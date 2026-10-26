// Fork (SX-2922, SX-2923): one Claude usage-limit incident per connection episode.
//
// When a claude_local run fails with provider_quota on an eligible shared
// Anthropic connection, create ONE host task and ONE card for the
// configured operator. The card is acknowledgement-only unless a
// compatible shared account and eligible agents exist, in which case accepting
// it switches only the listed agents' AI account. Nothing is retried or
// rescheduled. Dedupe is a company-scoped advisory lock plus a durable origin
// lookup (no migration, no unique index).
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, notInArray, sql } from "drizzle-orm";
import {
  agentConfigRevisions,
  agents,
  companyMemberships,
  connectionGrants,
  environments,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  projects,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import {
  aiConnectionBindingSchema,
  aiConnectionMetadataSchema,
  claudeQuotaSwitchPayloadSchema,
  CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND,
  CLAUDE_QUOTA_SWITCH_AGENT_LIMIT,
  CLAUDE_QUOTA_SWITCH_TARGET_LIMIT,
  type ClaudeQuotaSwitchPayload,
  type ClaudeQuotaSwitchResult,
  type IssueThreadInteraction,
} from "@paperclipai/shared";
import { resolveClaudeQuotaCardConfig, type ClaudeQuotaCardConfig } from "../config.js";
import { parseObject } from "../adapters/utils.js";
import { conflict, forbidden, HttpError, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { aiConnectionService } from "./ai-connections.js";
import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { persistActivity } from "./activity-log.js";
import { issueService } from "./issues.js";
import { CLAUDE_QUOTA_CARD_SYSTEM_ID, issueThreadInteractionService } from "./issue-thread-interactions.js";
import { readHeartbeatRunErrorFamily } from "./heartbeat/retries.js";

type RunRow = typeof heartbeatRuns.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CLAUDE_QUOTA_ELIGIBILITY_KEY = "claudeQuotaCardEligibility";
export const CLAUDE_QUOTA_RECEIPT_KEY = "claudeQuotaCard";
const CARD_SYSTEM_ID = CLAUDE_QUOTA_CARD_SYSTEM_ID;
export const CLAUDE_QUOTA_SWITCH_REVISION_SOURCE = "claude_quota_card_switch";
const ACTIVE_TASK_SCAN_LIMIT = 500;
const RECONCILE_LOOKBACK_MS = 48 * 60 * 60 * 1000;
const RECONCILE_BATCH_LIMIT = 50;
const RECONCILE_MAX_PAGES = 5;

// Env keys that select a login, token, endpoint or custom routing for Claude.
// Managed AI strips most of these, but an explicit choice still means the
// run's quota is not the shared connection's quota, so the agent is excluded.
const CLAUDE_OWN_LOGIN_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_ROLE_ARN",
] as const;
const CLAUDE_AUTH_ARG_RE = /^(--config|-c|--settings|--setting-sources|--api-key|--auth-token)(=|$)/;

export interface ClaudeQuotaEligibilityEvidence {
  version: 1;
  runId: string;
  eligible: boolean;
  reason: string | null;
  adapterType: string;
  fingerprint: string;
  binding: { connectionId: string; grantId: string; provider: string; method: string } | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function envHasValue(value: unknown) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function ownLoginFindings(source: string, env: unknown, config: unknown): string[] {
  const findings: string[] = [];
  const envMap = env && typeof env === "object" && !Array.isArray(env) ? (env as Record<string, unknown>) : {};
  for (const key of CLAUDE_OWN_LOGIN_ENV_KEYS) {
    if (envHasValue(envMap[key])) findings.push(`${source}:env:${key}`);
  }
  const configMap = parseObject(config);
  const args = [
    ...(Array.isArray(configMap.extraArgs) ? configMap.extraArgs : []),
    ...(Array.isArray(configMap.args) ? configMap.args : []),
  ];
  if (args.some((arg) => typeof arg === "string" && CLAUDE_AUTH_ARG_RE.test(arg))) findings.push(`${source}:args`);
  const command = readString(configMap.command);
  if (command && command !== "claude") findings.push(`${source}:command`);
  return findings;
}

/**
 * Non-secret eligibility evidence, captured before managed-AI auth stripping.
 * Never records a credential value: only source names, key names and ids.
 */
export function evaluateClaudeQuotaEligibility(input: {
  runId: string;
  adapterType: string;
  requestedBinding: unknown;
  attribution: unknown;
  agentConfig: unknown;
  effectiveConfig: unknown;
  environmentEnv: unknown;
  projectEnv: unknown;
  routineEnv: unknown;
}): ClaudeQuotaEligibilityEvidence {
  const requested = parseObject(input.requestedBinding);
  const attribution = parseObject(input.attribution);
  const binding = {
    connectionId: readString(attribution.connectionId) ?? "",
    grantId: readString(attribution.grantId) ?? "",
    provider: readString(attribution.provider) ?? "",
    method: readString(attribution.method) ?? "",
  };
  const findings = [
    ...ownLoginFindings("agent", parseObject(input.agentConfig).env, input.agentConfig),
    ...ownLoginFindings("effective", parseObject(input.effectiveConfig).env, input.effectiveConfig),
    ...ownLoginFindings("environment", input.environmentEnv, null),
    ...ownLoginFindings("project", input.projectEnv, null),
    ...ownLoginFindings("routine", input.routineEnv, null),
  ].sort();

  let reason: string | null = null;
  if (input.adapterType !== "claude_local") reason = "adapter_not_claude_local";
  else if (requested.mode !== "shared") reason = "binding_not_direct_shared";
  else if (!binding.connectionId || !binding.grantId || !binding.method) reason = "attribution_missing";
  else if (
    attribution.mode !== "shared" ||
    binding.provider !== "anthropic" ||
    requested.connectionId !== binding.connectionId ||
    requested.grantId !== binding.grantId
  ) reason = "attribution_mismatch";
  else if (findings.length > 0) reason = `own_login_override:${findings[0]}`;

  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ adapterType: input.adapterType, binding, findings }))
    .digest("hex");
  return {
    version: 1,
    runId: input.runId,
    eligible: reason === null,
    reason,
    adapterType: input.adapterType,
    fingerprint,
    binding: binding.connectionId ? binding : null,
  };
}

function readEligibility(run: RunRow): ClaudeQuotaEligibilityEvidence | null {
  const raw = parseObject(parseObject(run.contextSnapshot)[CLAUDE_QUOTA_ELIGIBILITY_KEY]);
  // Scheduled retries copy the whole snapshot, so evidence from another run must not count.
  if (raw.version !== 1 || typeof raw.eligible !== "boolean" || raw.runId !== run.id) return null;
  return raw as unknown as ClaudeQuotaEligibilityEvidence;
}

type SourceIdentity = { connectionId: string; grantId: string; provider: string; method: string };

function readSourceIdentity(run: RunRow): SourceIdentity | null {
  const ai = parseObject(parseObject(run.contextSnapshot).aiConnection);
  const connectionId = readString(ai.connectionId);
  const grantId = readString(ai.grantId);
  const method = readString(ai.method);
  if (ai.mode !== "shared" || ai.provider !== "anthropic" || !connectionId || !grantId || !method) return null;
  return { connectionId, grantId, provider: "anthropic", method };
}

function hashSource(source: SourceIdentity) {
  return createHash("sha256")
    .update(`claude-quota-card:v1\0${source.connectionId}\0${source.grantId}\0${source.provider}\0${source.method}`)
    .digest("hex");
}

function startedAtOf(run: Pick<RunRow, "startedAt" | "createdAt">) {
  return (run.startedAt ?? run.createdAt).getTime();
}

function compareRunOrder(a: { id: string; at: number }, b: { id: string; at: number }) {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function methodLabel(method: string) {
  return method === "api_key" ? "API key" : method === "subscription" ? "subscription" : method;
}

function label(value: unknown, fallback: string) {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/[\r\n\t]+/g, " ").replace(/[`*_~\[\]()<>|#\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || fallback;
}

// Reset display ---------------------------------------------------------------

const RESET_WORD_RE = /\bresets?\b/gi;
const SUPPORTED_RESET_RE = /^resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*\(([A-Za-z][A-Za-z0-9_+\-/]*)\)/i;

function wallClock(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function zonedInstant(day: { year: number; month: number; day: number }, hour: number, minute: number, timeZone: string) {
  const wanted = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  let candidate = new Date(wanted);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = wallClock(candidate, timeZone);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute);
    if (actualMs === wanted) return candidate;
    candidate = new Date(candidate.getTime() + (wanted - actualMs));
  }
  const final = wallClock(candidate, timeZone);
  return Date.UTC(final.year, final.month - 1, final.day, final.hour, final.minute) === wanted ? candidate : null;
}

function resetEvidenceText(run: Pick<RunRow, "error" | "resultJson">) {
  const result = parseObject(run.resultJson);
  return [run.error, result.stderr, result.stdout, result.error, result.result]
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.slice(-20_000))
    .join("\n");
}

/**
 * Absolute reset time with its timezone, or "unknown". Only an unambiguous
 * "resets H[:MM]am/pm (IANA zone)" form anchored to the failure time is
 * accepted; weekly or dated text, several different resets, or a persisted
 * hint that disagrees with the text all yield "unknown". This does not reuse
 * the permissive recovery clock parser, which guesses a next day.
 */
export function deriveClaudeQuotaResetDisplay(
  run: Pick<RunRow, "error" | "resultJson" | "finishedAt">,
): string {
  const anchor = run.finishedAt;
  if (!anchor) return "unknown";
  const text = resetEvidenceText(run);
  const candidates = new Set<string>();
  let occurrences = 0;
  for (const match of text.matchAll(RESET_WORD_RE)) {
    occurrences += 1;
    const lineEnd = text.indexOf("\n", match.index);
    const phrase = text.slice(match.index, lineEnd === -1 ? undefined : lineEnd).slice(0, 160);
    const parsed = phrase.match(SUPPORTED_RESET_RE);
    if (!parsed) return "unknown";
    const hour12 = Number.parseInt(parsed[1]!, 10);
    const minute = Number.parseInt(parsed[2] ?? "0", 10);
    if (hour12 < 1 || hour12 > 12 || minute > 59) return "unknown";
    const hour = (hour12 % 12) + (parsed[3]!.toLowerCase() === "p" ? 12 : 0);
    candidates.add(`${hour}:${minute}:${parsed[4]}`);
  }
  if (occurrences === 0 || candidates.size !== 1) return "unknown";
  const [hourText, minuteText, ...zoneParts] = [...candidates][0]!.split(":");
  const timeZone = zoneParts.join(":");
  try {
    const today = wallClock(anchor, timeZone);
    let instant = zonedInstant(today, Number(hourText), Number(minuteText), timeZone);
    if (instant && instant.getTime() <= anchor.getTime()) {
      const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      instant = zonedInstant(
        { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() },
        Number(hourText),
        Number(minuteText),
        timeZone,
      );
    }
    if (!instant) return "unknown";
    const result = parseObject(run.resultJson);
    for (const key of ["providerQuotaRetryNotBefore", "retryNotBefore", "transientRetryNotBefore"]) {
      const hint = readString(result[key]);
      if (!hint) continue;
      const hinted = new Date(hint).getTime();
      if (!Number.isFinite(hinted) || Math.abs(hinted - instant.getTime()) > 60_000) return "unknown";
    }
    const shown = wallClock(instant, timeZone);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${shown.year}-${pad(shown.month)}-${pad(shown.day)} ${pad(shown.hour)}:${pad(shown.minute)} ${timeZone} (${instant.toISOString()})`;
  } catch {
    return "unknown";
  }
}

// Account switch (slice 2) ----------------------------------------------------

type AgentRow = typeof agents.$inferSelect;
type SwitchBinding = ClaudeQuotaSwitchPayload["source"];

const SWITCH_EXCLUDED_AGENT_STATUSES = ["terminated", "pending_approval"];

function toSharedBinding(value: unknown): SwitchBinding | null {
  const parsed = aiConnectionBindingSchema.safeParse(value);
  if (!parsed.success || parsed.data.mode !== "shared") return null;
  const { provider, method, mode, connectionId, grantId } = parsed.data;
  return { provider, method, mode, connectionId, grantId };
}

function sameBinding(a: SwitchBinding, b: SwitchBinding) {
  return (
    a.provider === b.provider &&
    a.method === b.method &&
    a.connectionId === b.connectionId &&
    a.grantId === b.grantId
  );
}

function agentBinding(agent: Pick<AgentRow, "runtimeConfig">) {
  return toSharedBinding(parseObject(agent.runtimeConfig).aiConnection);
}

function switchFingerprint(agent: Pick<AgentRow, "adapterType" | "runtimeConfig">, findings: string[]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        adapterType: agent.adapterType,
        aiConnection: parseObject(agent.runtimeConfig).aiConnection ?? null,
        findings,
      }),
    )
    .digest("hex");
}

/**
 * Best-effort own-login detection over the sources a run can draw on: the agent
 * config, its default environment, and the overrides and project of its active
 * tasks. Only key names are kept. Managed AI strips auth overrides at launch,
 * so this narrows the list rather than guarding a credential.
 */
async function loadOwnLoginFindings(executor: Db | Tx, companyId: string, rows: AgentRow[]) {
  const result = new Map<string, string[]>();
  if (rows.length === 0) return result;
  const environmentIds = [...new Set(rows.map((row) => row.defaultEnvironmentId).filter((id): id is string => Boolean(id)))];
  const environmentRows = environmentIds.length
    ? await executor
        .select({ id: environments.id, envVars: environments.envVars })
        .from(environments)
        .where(inArray(environments.id, environmentIds))
    : [];
  const environmentById = new Map(environmentRows.map((row) => [row.id, row.envVars]));
  const taskRows = await executor
    .select({
      agentId: issues.assigneeAgentId,
      overrides: issues.assigneeAdapterOverrides,
      projectId: issues.projectId,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        inArray(issues.assigneeAgentId, rows.map((row) => row.id)),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(ACTIVE_TASK_SCAN_LIMIT);
  const projectIds = [...new Set(taskRows.map((row) => row.projectId).filter((id): id is string => Boolean(id)))];
  const projectRows = projectIds.length
    ? await executor
        .select({ id: projects.id, env: projects.env })
        .from(projects)
        .where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds)))
    : [];
  const projectEnvById = new Map(projectRows.map((row) => [row.id, row.env]));

  for (const row of rows) {
    const found = new Set<string>([
      ...ownLoginFindings("agent", parseObject(row.adapterConfig).env, row.adapterConfig),
      ...ownLoginFindings("environment", row.defaultEnvironmentId ? environmentById.get(row.defaultEnvironmentId) : null, null),
    ]);
    for (const task of taskRows) {
      if (task.agentId !== row.id) continue;
      const overrideConfig = parseObject(parseObject(task.overrides).adapterConfig);
      for (const finding of ownLoginFindings("issue", overrideConfig.env, overrideConfig)) found.add(finding);
      if (task.projectId) {
        for (const finding of ownLoginFindings("project", projectEnvById.get(task.projectId), null)) found.add(finding);
      }
    }
    result.set(row.id, [...found].sort());
  }
  return result;
}

async function latestRevisionIds(executor: Db | Tx, companyId: string, agentIds: string[]) {
  const map = new Map<string, string>();
  if (agentIds.length === 0) return map;
  const rows = await executor
    .selectDistinctOn([agentConfigRevisions.agentId], {
      agentId: agentConfigRevisions.agentId,
      id: agentConfigRevisions.id,
    })
    .from(agentConfigRevisions)
    .where(and(eq(agentConfigRevisions.companyId, companyId), inArray(agentConfigRevisions.agentId, agentIds)))
    .orderBy(agentConfigRevisions.agentId, desc(agentConfigRevisions.createdAt), desc(agentConfigRevisions.id));
  for (const row of rows) map.set(row.agentId, row.id);
  return map;
}

function modelInputs(agent: Pick<AgentRow, "adapterConfig">) {
  const config = parseObject(agent.adapterConfig);
  return { model: config.model, runnerProvider: config.provider, acpxAgent: config.acpxAgent };
}

/** A select denial is a skip reason; anything else is a real failure. */
async function trySelectTarget(
  connections: ReturnType<typeof aiConnectionService>,
  input: { companyId: string; userId: string; agent: AgentRow; binding: SwitchBinding },
): Promise<string | null> {
  try {
    await connections.select({
      companyId: input.companyId,
      userId: input.userId,
      agentId: input.agent.id,
      adapterType: input.agent.adapterType,
      ...modelInputs(input.agent),
      binding: aiConnectionBindingSchema.parse(input.binding),
    });
    return null;
  } catch (err) {
    if (!(err instanceof HttpError) || ![403, 404, 422].includes(err.status)) throw err;
    const code = readString(parseObject(err.details).code);
    return code ? `target_unavailable:${code}` : "target_unavailable";
  }
}

// Service ---------------------------------------------------------------------

export type ClaudeQuotaObservation =
  | { status: "disabled"; reason: string }
  | { status: "ignored"; reason: string }
  | { status: "already_recorded" }
  | { status: "excluded"; reason: string }
  | { status: "recorded"; incidentId: string; interactionId: string; newEpisode: boolean };

export interface ClaudeQuotaCardServiceOptions {
  config?: () => ClaudeQuotaCardConfig;
}

const warnedConfig = new Set<string>();
export function warnClaudeQuotaCardConfig(config: ClaudeQuotaCardConfig) {
  for (const warning of config.warnings) {
    if (warnedConfig.has(warning)) continue;
    warnedConfig.add(warning);
    logger.warn({ feature: "claude_quota_card" }, warning);
  }
}

function defaultConfig(): ClaudeQuotaCardConfig {
  const config = resolveClaudeQuotaCardConfig();
  warnClaudeQuotaCardConfig(config);
  return config;
}

export function claudeQuotaCardService(db: Db, options: ClaudeQuotaCardServiceOptions = {}) {
  const getConfig = options.config ?? defaultConfig;
  const issueSvc = issueService(db);

  function isEnabledForCompany(companyId: string) {
    const config = getConfig();
    return Boolean(config.operatorUserId) && config.companyIds.has(companyId.toLowerCase());
  }

  async function mergeReceipt(executor: Db | Tx, run: Pick<RunRow, "id" | "companyId">, receipt: Record<string, unknown>) {
    await executor
      .update(heartbeatRuns)
      .set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || jsonb_build_object(${CLAUDE_QUOTA_RECEIPT_KEY}::text, ${JSON.stringify(receipt)}::jsonb)`,
      })
      .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  }

  function hasReceipt(run: RunRow) {
    return parseObject(parseObject(run.resultJson)[CLAUDE_QUOTA_RECEIPT_KEY]).version === 1;
  }

  function sourceMatch(source: SourceIdentity) {
    return sql`${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'connectionId' = ${source.connectionId}
      and ${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'grantId' = ${source.grantId}
      and ${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'provider' = ${source.provider}
      and ${heartbeatRuns.contextSnapshot} -> 'aiConnection' ->> 'method' = ${source.method}`;
  }

  // True when a successful managed run on the source started after `after` and
  // finished no later than `before`: the only signal that ends an episode.
  async function hasSeparatingSuccess(tx: Tx, companyId: string, source: SourceIdentity, after: Date, before: Date) {
    const [row] = await tx
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.status, "succeeded"),
          sql`${heartbeatRuns.startedAt} > ${after.toISOString()}::timestamptz`,
          sql`${heartbeatRuns.finishedAt} <= ${before.toISOString()}::timestamptz`,
          sourceMatch(source),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async function incidentLatestFailureFinish(tx: Tx, companyId: string, incidentId: string, first: RunRow) {
    const [row] = await tx
      .select({ latest: sql<string | null>`max(${heartbeatRuns.finishedAt})` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          sql`${heartbeatRuns.resultJson} -> ${CLAUDE_QUOTA_RECEIPT_KEY}::text ->> 'incidentId' = ${incidentId}`,
        ),
      );
    const receipted = row?.latest ? new Date(row.latest).getTime() : 0;
    return new Date(Math.max(receipted, first.finishedAt?.getTime() ?? 0));
  }

  // The host is dedicated to one card, so any interaction on it counts; this stays correct after key cleanup.
  async function findCard(tx: Tx, companyId: string, incidentId: string) {
    const [card] = await tx
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, incidentId),
        ),
      )
      .limit(1);
    return card ?? null;
  }

  async function buildSwitchProposal(
    tx: Tx,
    host: typeof issues.$inferSelect,
    first: RunRow,
    operatorUserId: string,
  ) {
    const source = readSourceIdentity(first);
    if (!source || hashSource(source) !== host.originId) return null;
    const sourceBinding: SwitchBinding = {
      provider: "anthropic",
      method: source.method as SwitchBinding["method"],
      mode: "shared",
      connectionId: source.connectionId,
      grantId: source.grantId,
    };
    const companyId = host.companyId;
    const candidates = await tx
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          eq(agents.adapterType, "claude_local"),
          notInArray(agents.status, SWITCH_EXCLUDED_AGENT_STATUSES),
          sql`${agents.runtimeConfig} -> 'aiConnection' ->> 'mode' = 'shared'`,
          sql`${agents.runtimeConfig} -> 'aiConnection' ->> 'connectionId' = ${source.connectionId}`,
          sql`${agents.runtimeConfig} -> 'aiConnection' ->> 'grantId' = ${source.grantId}`,
        ),
      )
      .orderBy(asc(agents.id))
      .limit(CLAUDE_QUOTA_SWITCH_AGENT_LIMIT + 1);
    // Above the bound the card stays informational rather than switching a partial list.
    if (candidates.length === 0 || candidates.length > CLAUDE_QUOTA_SWITCH_AGENT_LIMIT) return null;

    const findings = await loadOwnLoginFindings(tx, companyId, candidates);
    const eligible: AgentRow[] = [];
    const excluded: Array<{ name: string; reason: string }> = [];
    for (const agent of candidates) {
      const binding = agentBinding(agent);
      if (!binding || !sameBinding(binding, sourceBinding)) {
        excluded.push({ name: label(agent.name, "Agent"), reason: "uses a different account binding" });
      } else if ((findings.get(agent.id) ?? []).length > 0) {
        excluded.push({ name: label(agent.name, "Agent"), reason: "has its own login or credential override" });
      } else {
        eligible.push(agent);
      }
    }
    if (eligible.length === 0) return null;
    const revisions = await latestRevisionIds(tx, companyId, eligible.map((agent) => agent.id));

    const accountRows = await tx
      .select({ connection: toolConnections, grant: connectionGrants })
      .from(toolConnections)
      .innerJoin(
        connectionGrants,
        and(eq(connectionGrants.companyId, toolConnections.companyId), eq(connectionGrants.connectionId, toolConnections.id)),
      )
      .where(
        and(
          eq(toolConnections.companyId, companyId),
          eq(toolConnections.connectionPurpose, "ai"),
          eq(connectionGrants.kind, "organization"),
          eq(connectionGrants.status, "active"),
          eq(toolConnections.enabled, true),
          eq(toolConnections.status, "active"),
          eq(toolConnections.healthStatus, "ok"),
        ),
      )
      .orderBy(asc(toolConnections.name), asc(connectionGrants.id));
    const connections = aiConnectionService(tx as unknown as Db);
    const targets: ClaudeQuotaSwitchPayload["targets"] = [];
    for (const row of accountRows) {
      if (targets.length >= CLAUDE_QUOTA_SWITCH_TARGET_LIMIT) break;
      if (row.connection.id === source.connectionId && row.grant.id === source.grantId) continue;
      const metadata = aiConnectionMetadataSchema.safeParse(row.connection.config?.ai);
      if (!metadata.success || metadata.data.provider !== "anthropic") continue;
      // Never move subscription agents onto API-key billing, or the reverse.
      if (metadata.data.method !== source.method) continue;
      const binding: SwitchBinding = {
        provider: "anthropic",
        method: metadata.data.method,
        mode: "shared",
        connectionId: row.connection.id,
        grantId: row.grant.id,
      };
      // A common target must pass for every proposed agent; the click re-checks each one.
      let usable = true;
      for (const agent of eligible) {
        if ((await trySelectTarget(connections, { companyId, userId: operatorUserId, agent, binding })) !== null) {
          usable = false;
          break;
        }
      }
      if (usable) targets.push({ optionId: row.grant.id, name: label(row.connection.name, "Claude connection"), binding });
    }
    if (targets.length === 0) return null;

    const payload: ClaudeQuotaSwitchPayload = {
      version: 1,
      incidentId: host.id,
      sourceHash: host.originId!,
      source: sourceBinding,
      agents: eligible.map((agent) => ({
        agentId: agent.id,
        name: label(agent.name, "Agent"),
        binding: sourceBinding,
        expectedRevisionId: revisions.get(agent.id) ?? null,
        expectedFingerprint: switchFingerprint(agent, findings.get(agent.id) ?? []),
      })),
      targets,
    };
    return { payload, excluded };
  }

  async function ensureCard(tx: Tx, host: typeof issues.$inferSelect, first: RunRow, operatorUserId: string) {
    const existing = await findCard(tx, host.companyId, host.id);
    if (existing) return { id: existing.id, created: false };
    const ai = parseObject(parseObject(first.contextSnapshot).aiConnection);
    const account = label(ai.accountName, "Claude connection");
    const [agent] = await tx
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.id, first.agentId), eq(agents.companyId, host.companyId)));
    const agentName = label(agent?.name, "an agent");
    const reset = deriveClaudeQuotaResetDisplay(first);
    const proposal = await buildSwitchProposal(tx, host, first, operatorUserId);
    const switchPayload = proposal?.payload ?? null;
    const common = {
      idempotencyKey: `claude-quota-card:v1:${host.id}`,
      title: `Claude usage limit: ${account}`.slice(0, 240),
      continuationPolicy: "none",
      resolverPolicy: "human_only",
      addresseeUserId: operatorUserId,
    };
    const actor = { systemId: CARD_SYSTEM_ID };
    const interactions = issueThreadInteractionService(tx as unknown as Db);

    if (switchPayload) {
      const single = switchPayload.targets.length === 1 ? switchPayload.targets[0]! : null;
      const prompt = single
        ? `Claude usage limit reached on ${account}. Reset: ${reset}. Switch the listed agents to ${single.name}?`
        : `Claude usage limit reached on ${account}. Reset: ${reset}. Choose an account to switch the listed agents to.`;
      const detailsMarkdown = [
        `- Connection: ${account}`,
        `- First seen on agent: ${agentName}`,
        `- Reset: ${reset}`,
        "",
        "Agents that would switch:",
        ...switchPayload.agents.map((entry) => `- ${entry.name}`),
        "",
        ...(proposal && proposal.excluded.length > 0
          ? ["Agents left out:", ...proposal.excluded.map((entry) => `- ${entry.name}: ${entry.reason}`), ""]
          : []),
        "Accounts you can switch to:",
        ...switchPayload.targets.map((target) => `- ${target.name} (${methodLabel(target.binding.method)})`),
        "",
        "Nothing changes until you accept. Accepting changes only each listed agent's AI account, and skips any agent whose configuration changed since this card was created. Held tasks keep their existing recovery time, and the next normal run on the new account starts a fresh session.",
      ].join("\n");
      const interaction = await interactions.create(
        host,
        {
          kind: "request_checkbox_confirmation",
          ...common,
          summary: prompt.slice(0, 1000),
          payload: {
            version: 1,
            prompt,
            detailsMarkdown,
            options: switchPayload.targets.map((target) => ({ id: target.optionId, label: target.name })),
            defaultSelectedOptionIds: single ? [single.optionId] : [],
            minSelected: 1,
            maxSelected: 1,
            acceptLabel: single ? `Switch listed agents to ${single.name}`.slice(0, 80) : "Switch listed agents",
            rejectLabel: "Keep current account",
            rejectRequiresReason: false,
            allowDeclineReason: false,
            supersedeOnUserComment: false,
            claudeQuotaSwitch: switchPayload,
          },
        } as never,
        actor,
      );
      return { id: interaction.id, created: true };
    }

    const prompt = `Claude usage limit reached on ${account}. Reset: ${reset}. Nothing was changed automatically.`;
    const detailsMarkdown = [
      `- Connection: ${account}`,
      `- First seen on agent: ${agentName}`,
      `- Reset: ${reset}`,
      "",
      "Other agents that use this connection may be affected. Paperclip did not switch any account, retry or reschedule any work. Held tasks keep their existing recovery time.",
      "To change an agent's account, open its runtime settings.",
    ].join("\n");
    const interaction = await interactions.create(
      host,
      {
        kind: "request_confirmation",
        ...common,
        summary: prompt.slice(0, 1000),
        payload: {
          version: 1,
          prompt,
          detailsMarkdown,
          acceptLabel: "Acknowledge",
          rejectLabel: "Dismiss",
          rejectRequiresReason: false,
          allowDeclineReason: false,
          supersedeOnUserComment: false,
        },
      } as never,
      actor,
    );
    return { id: interaction.id, created: true };
  }

  async function createHost(tx: Tx, first: RunRow, sourceHash: string, operatorUserId: string) {
    const ai = parseObject(parseObject(first.contextSnapshot).aiConnection);
    const account = label(ai.accountName, "Claude connection");
    const description = [
      `The shared Claude connection "${account}" reached its usage limit.`,
      "",
      "This task only records the incident and holds one acknowledgement card. No agent, account or schedule was changed.",
    ].join("\n");
    return issueSvc.create(
      first.companyId,
      {
        title: `Claude usage limit reached: ${account}`.slice(0, 240),
        description,
        status: "in_review",
        priority: "medium",
        assigneeUserId: operatorUserId,
        responsibleUserId: operatorUserId,
        trustExplicitResponsibleUserId: true,
        originKind: CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND,
        originId: sourceHash,
        originFingerprint: first.id,
        idempotencyKey: `claude-quota-card:v1:${first.companyId}:${sourceHash}:${first.id}`,
      },
      tx,
    );
  }

  async function recordQuotaFailure(runId: string, companyId: string): Promise<ClaudeQuotaObservation> {
    const config = getConfig();
    const operatorUserId = config.operatorUserId;
    if (!operatorUserId || !config.companyIds.has(companyId.toLowerCase())) {
      return { status: "disabled", reason: "company_not_enabled" };
    }

    const [initial] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
    if (!initial) return { status: "ignored", reason: "run_not_found" };
    if (initial.status !== "failed" || readHeartbeatRunErrorFamily(initial) !== "provider_quota") {
      return { status: "ignored", reason: "not_provider_quota_failure" };
    }
    if (hasReceipt(initial)) return { status: "already_recorded" };

    const evidence = readEligibility(initial);
    if (!evidence) return { status: "ignored", reason: "no_eligibility_evidence" };
    const source = readSourceIdentity(initial);
    const exclusion = !evidence.eligible
      ? evidence.reason ?? "ineligible"
      : !source ||
          evidence.binding?.connectionId !== source.connectionId ||
          evidence.binding?.grantId !== source.grantId
        ? "attribution_mismatch"
        : null;
    if (exclusion) {
      await mergeReceipt(db, initial, { version: 1, status: "excluded", reason: exclusion, observedAt: new Date().toISOString() });
      return { status: "excluded", reason: exclusion };
    }

    const [member] = await db
      .select({ id: companyMemberships.id })
      .from(companyMemberships)
      .where(
        and(
          eq(companyMemberships.companyId, companyId),
          eq(companyMemberships.principalType, "user"),
          eq(companyMemberships.principalId, operatorUserId),
          eq(companyMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!member) {
      logger.warn({ companyId, runId }, "Claude quota card skipped: configured operator is not an active company member");
      return { status: "disabled", reason: "operator_unavailable" };
    }

    const sourceHash = hashSource(source!);
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`claude-quota-card:v1:${companyId}:${sourceHash}`}, 0))`,
      );
      const [run] = await tx
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
      if (!run) return { status: "ignored", reason: "run_not_found" } as const;
      if (hasReceipt(run)) return { status: "already_recorded" } as const;

      const incidents = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.originKind, CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND),
            eq(issues.originId, sourceHash),
          ),
        )
        .orderBy(asc(issues.createdAt), asc(issues.id));
      const firstRuns = new Map<string, RunRow>();
      for (const incident of incidents) {
        const [firstRun] = await tx
          .select()
          .from(heartbeatRuns)
          .where(and(eq(heartbeatRuns.id, incident.originFingerprint), eq(heartbeatRuns.companyId, companyId)));
        if (firstRun) firstRuns.set(incident.id, firstRun);
      }
      const ordered = incidents
        .filter((incident) => firstRuns.has(incident.id))
        .map((incident) => ({ incident, first: firstRuns.get(incident.id)!, at: startedAtOf(firstRuns.get(incident.id)!) }))
        .sort((a, b) => compareRunOrder({ id: a.first.id, at: a.at }, { id: b.first.id, at: b.at }));

      const self = { id: run.id, at: startedAtOf(run) };
      const previous = [...ordered].reverse().find((entry) => compareRunOrder({ id: entry.first.id, at: entry.at }, self) <= 0);
      const next = ordered.find((entry) => compareRunOrder({ id: entry.first.id, at: entry.at }, self) > 0);

      let target: { incident: typeof issues.$inferSelect; first: RunRow } | null = null;
      if (previous) {
        const latest = await incidentLatestFailureFinish(tx, companyId, previous.incident.id, previous.first);
        const selfStart = new Date(self.at);
        if (!(await hasSeparatingSuccess(tx, companyId, source!, latest, selfStart))) target = previous;
      }
      if (!target && next) {
        const selfFinish = run.finishedAt ?? run.createdAt;
        if (!(await hasSeparatingSuccess(tx, companyId, source!, selfFinish, new Date(next.at)))) target = next;
      }

      let incident: typeof issues.$inferSelect;
      let first: RunRow;
      let newEpisode = false;
      if (target) {
        incident = target.incident;
        first = target.first;
      } else {
        incident = (await createHost(tx, run, sourceHash, operatorUserId)) as typeof issues.$inferSelect;
        first = run;
        newEpisode = true;
      }

      const card = await ensureCard(tx, incident, first, operatorUserId);
      await mergeReceipt(tx, run, {
        version: 1,
        status: "recorded",
        incidentId: incident.id,
        interactionId: card.id,
        episodeFirstRunId: first.id,
        sourceHash,
        observedAt: new Date().toISOString(),
      });
      return { status: "recorded", incidentId: incident.id, interactionId: card.id, newEpisode } as const;
    });
  }

  /** Best-effort observer for a finalized run. Never throws. */
  async function observeFailedRun(run: Pick<RunRow, "id" | "companyId">): Promise<ClaudeQuotaObservation | null> {
    try {
      return await recordQuotaFailure(run.id, run.companyId);
    } catch (err) {
      logger.warn({ err, runId: run.id, companyId: run.companyId }, "Claude quota card observer failed");
      return null;
    }
  }


  /**
   * Runs inside the card's acceptance transaction. Everything here is DB-only:
   * no provider call, remote read or secret resolution happens under the agent
   * locks. Any throw rolls back the acceptance and every revision written so far.
   */
  async function applyAccountSwitch(
    tx: Tx,
    context: {
      issue: { id: string; companyId: string };
      interaction: IssueThreadInteraction;
      selectedOptionIds: string[];
    },
    resolver: { userId: string; allowedAgentIds: ReadonlySet<string> },
  ): Promise<ClaudeQuotaSwitchResult> {
    const companyId = context.issue.companyId;
    if (!isEnabledForCompany(companyId)) {
      throw conflict("Claude account switching is not enabled for this company", { code: "claude_quota_switch_disabled" });
    }
    const interaction = context.interaction;
    if (interaction.kind !== "request_checkbox_confirmation" || !interaction.payload.claudeQuotaSwitch) {
      throw unprocessable("This interaction does not carry an account switch");
    }
    if (interaction.companyId !== companyId || interaction.issueId !== context.issue.id) {
      throw unprocessable("This interaction does not belong to this issue");
    }
    if (interaction.addresseeUserId !== resolver.userId) {
      throw forbidden("Only the user this card is addressed to can switch accounts");
    }
    const parsed = claudeQuotaSwitchPayloadSchema.safeParse(interaction.payload.claudeQuotaSwitch);
    if (!parsed.success) throw unprocessable("The account switch payload is invalid");
    const payload = parsed.data;

    const [host] = await tx
      .select({ id: issues.id, originKind: issues.originKind, originId: issues.originId })
      .from(issues)
      .where(and(eq(issues.id, context.issue.id), eq(issues.companyId, companyId)));
    if (
      !host ||
      host.id !== payload.incidentId ||
      host.originKind !== CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND ||
      host.originId !== payload.sourceHash ||
      hashSource({
        connectionId: payload.source.connectionId,
        grantId: payload.source.grantId,
        provider: payload.source.provider,
        method: payload.source.method,
      }) !== payload.sourceHash ||
      payload.agents.some((entry) => !sameBinding(entry.binding, payload.source))
    ) {
      throw unprocessable("The account switch payload does not match its incident");
    }

    if (context.selectedOptionIds.length !== 1) {
      throw unprocessable("Choose exactly one account to switch to");
    }
    const target = payload.targets.find((entry) => entry.optionId === context.selectedOptionIds[0]);
    if (!target) throw unprocessable("The selected account is not offered by this card");
    if (payload.agents.every((entry) => !resolver.allowedAgentIds.has(entry.agentId))) {
      throw forbidden("You do not have permission to change the configuration of the listed agents");
    }

    const entries = [...payload.agents].sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
    const locked = await tx
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, companyId), inArray(agents.id, entries.map((entry) => entry.agentId))))
      .orderBy(asc(agents.id))
      .for("update");
    const lockedById = new Map(locked.map((row) => [row.id, row]));
    const revisions = await latestRevisionIds(tx, companyId, locked.map((row) => row.id));
    const findings = await loadOwnLoginFindings(tx, companyId, locked);
    const connections = aiConnectionService(tx as unknown as Db);

    const changed: ClaudeQuotaSwitchResult["changed"] = [];
    const skipped: ClaudeQuotaSwitchResult["skipped"] = [];
    for (const entry of entries) {
      const row = lockedById.get(entry.agentId);
      const skip = (reason: string) => skipped.push({ agentId: entry.agentId, reason });
      if (!row) { skip("agent_not_found"); continue; }
      if (SWITCH_EXCLUDED_AGENT_STATUSES.includes(row.status)) { skip("agent_not_active"); continue; }
      if (row.adapterType !== "claude_local") { skip("adapter_changed"); continue; }
      const current = agentBinding(row);
      if (!current || !sameBinding(current, entry.binding)) { skip("binding_changed"); continue; }
      if (
        (revisions.get(row.id) ?? null) !== entry.expectedRevisionId ||
        switchFingerprint(row, findings.get(row.id) ?? []) !== entry.expectedFingerprint
      ) { skip("config_changed"); continue; }
      if (!resolver.allowedAgentIds.has(row.id)) { skip("no_permission"); continue; }
      const denial = await trySelectTarget(connections, { companyId, userId: resolver.userId, agent: row, binding: target.binding });
      if (denial) { skip(denial); continue; }

      const updated = await updateAgentConfigurationInTransaction(
        tx as unknown as Db,
        row.id,
        { runtimeConfig: { ...parseObject(row.runtimeConfig), aiConnection: target.binding } },
        { recordRevision: { source: CLAUDE_QUOTA_SWITCH_REVISION_SOURCE, createdByUserId: resolver.userId } },
      );
      if (!updated) throw conflict("The agent disappeared during the switch", { code: "claude_quota_switch_agent_missing" });
      const revisionId = (await latestRevisionIds(tx, companyId, [row.id])).get(row.id);
      if (!revisionId || revisionId === entry.expectedRevisionId) {
        throw conflict("The switch did not record a configuration revision", { code: "claude_quota_switch_revision_missing" });
      }
      changed.push({ agentId: row.id, revisionId });
      await persistActivity(tx as unknown as Db, {
        companyId,
        actorType: "user",
        actorId: resolver.userId,
        action: "agent.claude_quota_switched",
        entityType: "agent",
        entityId: row.id,
        agentId: row.id,
        issueId: context.issue.id,
        details: {
          interactionId: interaction.id,
          incidentId: context.issue.id,
          fromConnectionId: entry.binding.connectionId,
          fromGrantId: entry.binding.grantId,
          toConnectionId: target.binding.connectionId,
          toGrantId: target.binding.grantId,
          previousRevisionId: entry.expectedRevisionId,
          revisionId,
        },
      });
    }

    if (changed.length === 0) {
      const unavailable = skipped.length > 0 && skipped.every((entry) => entry.reason.startsWith("target_unavailable"));
      throw conflict(
        unavailable
          ? `${target.name} can no longer be used by the listed agents. Nothing was changed and the card is still open; check the account in connection settings.`
          : "None of the listed agents can be switched any more because their configuration changed since this card was created. Nothing was changed; open each agent's runtime settings to change its account.",
        {
          code: unavailable ? "claude_quota_switch_target_unavailable" : "claude_quota_switch_stale",
          skipped,
        },
      );
    }

    const nameById = new Map(payload.agents.map((entry) => [entry.agentId, entry.name]));
    const summary = [
      `Switched ${changed.length} ${changed.length === 1 ? "agent" : "agents"} from the rate-limited account to ${label(target.name, "the new account")}: ${changed.map((entry) => label(nameById.get(entry.agentId), "Agent")).join(", ")}.`,
      ...(skipped.length > 0
        ? [
            `Skipped ${skipped.length}: ${skipped.map((entry) => `${label(nameById.get(entry.agentId), "Agent")} (${entry.reason})`).join(", ")}.`,
          ]
        : []),
      "Held tasks keep their existing recovery time.",
    ].join("\n\n");
    await issueSvc.addComment(context.issue.id, summary, {}, { authorType: "system" }, tx);

    return { targetOptionId: target.optionId, targetName: target.name, changed, skipped };
  }

  return {
    isEnabledForCompany,
    observeFailedRun,
    applyAccountSwitch,

    /**
     * Bounded, company-scoped repair of missed observations. Only runs that
     * carry eligibility evidence and no receipt are considered, oldest first.
     */
    async reconcile(options: { limit?: number; now?: Date } = {}) {
      const config = getConfig();
      const result = { scanned: 0, recorded: 0, excluded: 0 };
      if (!config.operatorUserId || config.companyIds.size === 0) return result;
      const limit = Math.max(1, Math.min(options.limit ?? RECONCILE_BATCH_LIMIT, 200));
      const since = new Date((options.now ?? new Date()).getTime() - RECONCILE_LOOKBACK_MS);
      for (const companyId of config.companyIds) {
        try {
          // Rows that stay receipt-less (ignored, operator unavailable, a throwing
          // observation) are paged past with a keyset cursor so they cannot
          // starve newer missed runs behind them.
          let cursor: { at: string; id: string } | null = null;
          let handled = 0;
          for (let page = 0; page < RECONCILE_MAX_PAGES && handled < limit; page += 1) {
            const sortKey = sql`coalesce(${heartbeatRuns.startedAt}, ${heartbeatRuns.createdAt})`;
            const rows: Array<{ id: string; companyId: string; at: string }> = await db
              .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, at: sql<string>`${sortKey}::text` })
              .from(heartbeatRuns)
              .where(
                and(
                  eq(heartbeatRuns.companyId, companyId),
                  eq(heartbeatRuns.status, "failed"),
                  gte(heartbeatRuns.createdAt, since),
                  sql`(${heartbeatRuns.errorCode} = 'provider_quota' or ${heartbeatRuns.resultJson} ->> 'errorFamily' = 'provider_quota')`,
                  sql`${heartbeatRuns.contextSnapshot} ? ${CLAUDE_QUOTA_ELIGIBILITY_KEY}::text`,
                  sql`not (coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) ? ${CLAUDE_QUOTA_RECEIPT_KEY}::text)`,
                  cursor ? sql`(${sortKey}, ${heartbeatRuns.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined,
                ),
              )
              .orderBy(asc(sortKey), asc(heartbeatRuns.id))
              .limit(limit);
            for (const row of rows) {
              result.scanned += 1;
              const outcome = await observeFailedRun(row);
              if (outcome?.status === "recorded") result.recorded += 1;
              if (outcome?.status === "excluded") result.excluded += 1;
              if (outcome?.status === "recorded" || outcome?.status === "excluded" || outcome?.status === "already_recorded") {
                handled += 1;
              }
            }
            if (rows.length < limit) break;
            const last = rows[rows.length - 1]!;
            cursor = { at: last.at, id: last.id };
          }
        } catch (err) {
          logger.warn({ err, companyId }, "Claude quota card reconciliation failed");
        }
      }
      return result;
    },
  };
}
