import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  connectionGrants,
  issueComments,
  issueCreateIdempotencyKeys,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND } from "@paperclipai/shared";
import { resolveClaudeQuotaCardConfig, type ClaudeQuotaCardConfig } from "../config.js";
import {
  CLAUDE_QUOTA_ELIGIBILITY_KEY,
  claudeQuotaCardService,
  deriveClaudeQuotaResetDisplay,
  evaluateClaudeQuotaEligibility,
} from "../services/claude-quota-card.js";
import { issueService } from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OPERATOR = "operator-user";
const MINUTE = 60_000;
const SECRET = "sk-ant-oat01-SHOULD-NEVER-APPEAR";
const T0 = new Date("2026-10-26T10:00:00.000Z").getTime();

describe("resolveClaudeQuotaCardConfig", () => {
  const company = "11111111-1111-4111-8111-111111111111";

  it("is disabled by default", () => {
    expect(resolveClaudeQuotaCardConfig({})).toMatchObject({ operatorUserId: null, warnings: [] });
    expect(resolveClaudeQuotaCardConfig({}).companyIds.size).toBe(0);
  });

  it("enables only with valid companies and an operator", () => {
    const config = resolveClaudeQuotaCardConfig({
      PAPERCLIP_CLAUDE_QUOTA_CARD_COMPANY_IDS: ` ${company.toUpperCase()} `,
      PAPERCLIP_CLAUDE_QUOTA_CARD_OPERATOR_USER_ID: OPERATOR,
    });
    expect([...config.companyIds]).toEqual([company]);
    expect(config.operatorUserId).toBe(OPERATOR);
  });

  it("disables with a warning for an invalid company list or a missing operator", () => {
    const invalidCompany = resolveClaudeQuotaCardConfig({
      PAPERCLIP_CLAUDE_QUOTA_CARD_COMPANY_IDS: `${company},not-a-uuid`,
      PAPERCLIP_CLAUDE_QUOTA_CARD_OPERATOR_USER_ID: OPERATOR,
    });
    expect(invalidCompany.companyIds.size).toBe(0);
    expect(invalidCompany.warnings).toHaveLength(1);
    const noOperator = resolveClaudeQuotaCardConfig({ PAPERCLIP_CLAUDE_QUOTA_CARD_COMPANY_IDS: company });
    expect(noOperator.companyIds.size).toBe(0);
    expect(noOperator.operatorUserId).toBeNull();
    expect(noOperator.warnings).toHaveLength(1);
  });
});

describe("deriveClaudeQuotaResetDisplay", () => {
  const finishedAt = new Date("2026-10-26T20:00:00.000Z");
  const derive = (error: string | null, resultJson: Record<string, unknown> | null = null) =>
    deriveClaudeQuotaResetDisplay({ error, resultJson, finishedAt });

  it("shows an absolute time with its zone for the one supported form", () => {
    expect(derive("You've hit your limit. resets 5pm (America/New_York)")).toBe(
      "2026-10-26 17:00 America/New_York (2026-10-26T21:00:00.000Z)",
    );
  });

  it("is unknown for weekly, dated, repeated-different or unsupported text", () => {
    expect(derive("Weekly limit reached, resets Oct 30, 5pm (America/New_York)")).toBe("unknown");
    expect(derive("resets 5pm (America/New_York) and resets 6pm (America/New_York)")).toBe("unknown");
    expect(derive("resets 5pm (Mars/Olympus)")).toBe("unknown");
    expect(derive("limit reached")).toBe("unknown");
    expect(derive(null)).toBe("unknown");
  });

  it("is unknown when a persisted retry hint disagrees with the text", () => {
    expect(derive("resets 5pm (America/New_York)", { providerQuotaRetryNotBefore: "2026-10-27T03:00:00.000Z" })).toBe("unknown");
    expect(derive("resets 5pm (America/New_York)", { providerQuotaRetryNotBefore: "2026-10-26T21:00:00.000Z" })).not.toBe("unknown");
  });
});

describeEmbeddedPostgres("claudeQuotaCardService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const extraClients: Array<ReturnType<typeof createDb>> = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-quota-card-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueThreadInteractions);
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function enabledConfig(companyId: string, operatorUserId: string | null = OPERATOR): () => ClaudeQuotaCardConfig {
    return () => ({ companyIds: new Set([companyId]), operatorUserId, warnings: [] });
  }

  function newService(companyId: string, operatorUserId: string | null = OPERATOR) {
    const client = createDb(tempDb!.connectionString);
    extraClients.push(client);
    return claudeQuotaCardService(client, { config: enabledConfig(companyId, operatorUserId) });
  }

  async function seedCompany(options: { operator?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Somnex",
      issuePrefix: `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    if (options.operator !== false) {
      await db.insert(authUsers).values({ id: OPERATOR, name: "Operator", email: `${randomUUID()}@example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: OPERATOR, membershipRole: "owner", status: "active" });
    }
    const agentId = await seedAgent(companyId, "Coder A");
    return { companyId, agentId };
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  const connectionA = { connectionId: randomUUID(), grantId: randomUUID() };
  const connectionB = { connectionId: randomUUID(), grantId: randomUUID() };

  function aiConnection(connection: { connectionId: string; grantId: string }) {
    return {
      ...connection,
      provider: "anthropic",
      method: "oauth",
      mode: "shared",
      responsibleUserId: OPERATOR,
      accountName: "Team Max",
      identity: "acct-1",
      sessionIdentity: "acct-1",
    };
  }

  function evidenceFor(connection: { connectionId: string; grantId: string }, overrides: { agentEnv?: Record<string, unknown> } = {}) {
    return evaluateClaudeQuotaEligibility({
      runId: "pending",
      adapterType: "claude_local",
      requestedBinding: { mode: "shared", ...connection },
      attribution: aiConnection(connection),
      agentConfig: { env: overrides.agentEnv ?? {} },
      effectiveConfig: { env: {} },
      environmentEnv: null,
      projectEnv: null,
      routineEnv: null,
    });
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    offsetMinutes: number;
    status?: "failed" | "succeeded";
    connection?: { connectionId: string; grantId: string };
    evidence?: ReturnType<typeof evidenceFor> | null;
    evidenceRunId?: string;
    error?: string | null;
    durationMinutes?: number;
  }) {
    const connection = input.connection ?? connectionA;
    const startedAt = new Date(T0 + input.offsetMinutes * MINUTE);
    const finishedAt = new Date(startedAt.getTime() + (input.durationMinutes ?? 1) * MINUTE);
    const id = randomUUID();
    const status = input.status ?? "failed";
    const evidence = { ...(input.evidence ?? evidenceFor(connection)), runId: input.evidenceRunId ?? id };
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status,
      startedAt,
      finishedAt,
      createdAt: startedAt,
      errorCode: status === "failed" ? "provider_quota" : null,
      error: status === "failed" ? (input.error === undefined ? "You've hit your limit. resets 5pm (America/New_York)" : input.error) : null,
      resultJson: status === "failed" ? { errorFamily: "provider_quota", stderr: `Authorization: Bearer ${SECRET}` } : { ok: true },
      contextSnapshot: {
        issueId: randomUUID(),
        aiConnection: aiConnection(connection),
        ...(input.evidence === null ? {} : { [CLAUDE_QUOTA_ELIGIBILITY_KEY]: evidence }),
      },
    });
    return id;
  }

  async function incidents(companyId: string) {
    return db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND)));
  }

  async function cards(companyId: string) {
    return db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, companyId));
  }

  async function receiptOf(runId: string) {
    const [row] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    return (row?.resultJson as Record<string, any> | null)?.claudeQuotaCard ?? null;
  }

  it("creates exactly one host and one card for 13 concurrent failures on independent DB clients", async () => {
    const { companyId, agentId } = await seedCompany();
    const runIds: string[] = [];
    for (let i = 0; i < 13; i += 1) runIds.push(await seedRun({ companyId, agentId, offsetMinutes: i }));

    const results = await Promise.all(runIds.map((id) => newService(companyId).observeFailedRun({ id, companyId })));

    expect(results.every((result) => result?.status === "recorded")).toBe(true);
    const hosts = await incidents(companyId);
    expect(hosts).toHaveLength(1);
    const allCards = await cards(companyId);
    expect(allCards).toHaveLength(1);
    expect(allCards[0]).toMatchObject({ kind: "request_confirmation", status: "pending", issueId: hosts[0]!.id, continuationPolicy: "none" });
    expect(allCards[0]!.payload).toMatchObject({ supersedeOnUserComment: false });
    expect(new Set((await Promise.all(runIds.map(receiptOf))).map((receipt) => receipt.incidentId))).toEqual(new Set([hosts[0]!.id]));
  }, 60_000);

  it("shapes the host for the operator without agent assignee, parent or workspace inheritance", async () => {
    const { companyId, agentId } = await seedCompany();
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    await newService(companyId).observeFailedRun({ id: runId, companyId });
    const [host] = await incidents(companyId);
    expect(host).toMatchObject({
      status: "in_review",
      assigneeUserId: OPERATOR,
      assigneeAgentId: null,
      parentId: null,
      originFingerprint: runId,
      projectWorkspaceId: null,
      executionWorkspaceId: null,
    });
    const [card] = await cards(companyId);
    expect(card).toMatchObject({ requestedResolverPolicy: "human_only", addresseeUserId: OPERATOR, continuationPolicy: "none" });
    expect(JSON.stringify(card!.payload)).toContain("2026-10-26 17:00 America/New_York");
  });

  it("keeps one card through acknowledgement, restart, key cleanup, different reset text and unknown reset", async () => {
    const { companyId, agentId } = await seedCompany();
    const first = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    await newService(companyId).observeFailedRun({ id: first, companyId });
    const [host] = await incidents(companyId);
    const [card] = await cards(companyId);

    await db.update(issueThreadInteractions).set({ status: "accepted", resolvedAt: new Date(), resolvedByUserId: OPERATOR }).where(eq(issueThreadInteractions.id, card!.id));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, host!.id));
    expect(await db.select().from(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.companyId, companyId))).toHaveLength(1);
    await db.delete(issueCreateIdempotencyKeys).where(eq(issueCreateIdempotencyKeys.companyId, companyId));
    await db.update(issueThreadInteractions).set({ idempotencyKey: null }).where(eq(issueThreadInteractions.id, card!.id));

    const differentReset = await seedRun({ companyId, agentId, offsetMinutes: 30, error: "limit reached, resets 9am (Europe/London)" });
    const unknownReset = await seedRun({ companyId, agentId, offsetMinutes: 60, error: "limit reached" });
    const restarted = newService(companyId);
    expect(await restarted.observeFailedRun({ id: differentReset, companyId })).toMatchObject({ status: "recorded", newEpisode: false });
    expect(await restarted.observeFailedRun({ id: unknownReset, companyId })).toMatchObject({ status: "recorded", newEpisode: false });
    await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(result_json, '{}'::jsonb) - 'claudeQuotaCard'` }).where(eq(heartbeatRuns.id, first));
    expect(await newService(companyId).observeFailedRun({ id: first, companyId })).toMatchObject({ status: "recorded", incidentId: host!.id, newEpisode: false });

    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
    expect((await cards(companyId))[0]!.status).toBe("accepted");
  });

  it("does not create a second card for a repeated observation of the same run", async () => {
    const { companyId, agentId } = await seedCompany();
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    const service = newService(companyId);
    expect(await service.observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "recorded" });
    expect(await service.observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "already_recorded" });
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
  });

  it("stays in one episode across a long unknown window with no success", async () => {
    const { companyId, agentId } = await seedCompany();
    const first = await seedRun({ companyId, agentId, offsetMinutes: 0, error: "limit reached" });
    const later = await seedRun({ companyId, agentId, offsetMinutes: 60 * 24 * 9, error: "limit reached" });
    const service = newService(companyId);
    await service.observeFailedRun({ id: first, companyId });
    await service.observeFailedRun({ id: later, companyId });
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
  });

  it("starts a new episode after a successful managed run, and keeps late old runs on the old episode", async () => {
    const { companyId, agentId } = await seedCompany();
    const old1 = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    const lateOld = await seedRun({ companyId, agentId, offsetMinutes: 3 });
    await seedRun({ companyId, agentId, offsetMinutes: 10, status: "succeeded" });
    const fresh = await seedRun({ companyId, agentId, offsetMinutes: 20 });
    const service = newService(companyId);

    // Deliver the fresh failure first, then old ones late and out of order.
    expect(await service.observeFailedRun({ id: fresh, companyId })).toMatchObject({ newEpisode: true });
    expect(await service.observeFailedRun({ id: lateOld, companyId })).toMatchObject({ newEpisode: true });
    expect(await service.observeFailedRun({ id: old1, companyId })).toMatchObject({ newEpisode: false });

    const hosts = await incidents(companyId);
    expect(hosts).toHaveLength(2);
    expect(await cards(companyId)).toHaveLength(2);
    const freshReceipt = await receiptOf(fresh);
    const oldReceipt = await receiptOf(old1);
    expect(freshReceipt.incidentId).not.toBe(oldReceipt.incidentId);
    expect((await receiptOf(lateOld)).incidentId).toBe(oldReceipt.incidentId);
    const oldHost = hosts.find((host) => host.id === oldReceipt.incidentId)!;
    expect(oldHost.originFingerprint).toBe(lateOld);
  });

  it("keeps connections separate", async () => {
    const { companyId, agentId } = await seedCompany();
    const a = await seedRun({ companyId, agentId, offsetMinutes: 0, connection: connectionA });
    const b = await seedRun({ companyId, agentId, offsetMinutes: 1, connection: connectionB });
    const service = newService(companyId);
    await service.observeFailedRun({ id: a, companyId });
    await service.observeFailedRun({ id: b, companyId });
    expect(await incidents(companyId)).toHaveLength(2);
    expect(await cards(companyId)).toHaveLength(2);
  });

  it("repairs a crash after the host was created and after the card was created", async () => {
    const { companyId, agentId } = await seedCompany();
    const first = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    // Crash state 1: host exists (same shape as the service creates), no card, no receipt.
    const sourceProbe = newService(companyId);
    await sourceProbe.observeFailedRun({ id: first, companyId });
    const [host] = await incidents(companyId);
    await db.delete(issueThreadInteractions);
    await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(result_json, '{}'::jsonb) - 'claudeQuotaCard'` }).where(eq(heartbeatRuns.id, first));
    expect(await receiptOf(first)).toBeNull();

    expect(await newService(companyId).observeFailedRun({ id: first, companyId })).toMatchObject({ status: "recorded", incidentId: host!.id });
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);

    // Crash state 2: host and card exist, receipt missing; a sibling run joins and nothing is duplicated.
    await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(result_json, '{}'::jsonb) - 'claudeQuotaCard'` }).where(eq(heartbeatRuns.id, first));
    const sibling = await seedRun({ companyId, agentId, offsetMinutes: 5 });
    await newService(companyId).observeFailedRun({ id: sibling, companyId });
    await newService(companyId).observeFailedRun({ id: first, companyId });
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
    expect((await receiptOf(first)).incidentId).toBe(host!.id);
  });

  it("repairs missed observations through the bounded reconcile scan and is idempotent", async () => {
    const { companyId, agentId } = await seedCompany();
    const withEvidence = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    const withoutEvidence = await seedRun({ companyId, agentId, offsetMinutes: 1, evidence: null });
    const service = newService(companyId);

    expect(await service.reconcile()).toMatchObject({ scanned: 1, recorded: 1 });
    expect(await service.reconcile()).toMatchObject({ scanned: 0, recorded: 0 });
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
    expect(await receiptOf(withEvidence)).not.toBeNull();
    expect(await receiptOf(withoutEvidence)).toBeNull();
  });

  it("pages past receipt-less rows so they cannot starve newer missed runs", async () => {
    const { companyId, agentId } = await seedCompany();
    const poison: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = await seedRun({ companyId, agentId, offsetMinutes: i });
      await db.update(heartbeatRuns).set({ resultJson: { errorFamily: "transient_upstream" } }).where(eq(heartbeatRuns.id, id));
      poison.push(id);
    }
    const missed = await seedRun({ companyId, agentId, offsetMinutes: 10 });
    const service = newService(companyId);

    expect(await service.reconcile({ limit: 2, now: new Date(T0 + 20 * MINUTE) })).toMatchObject({ recorded: 1 });
    expect(await receiptOf(missed)).toMatchObject({ status: "recorded" });
    for (const id of poison) expect(await receiptOf(id)).toBeNull();
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
  });

  it("produces no incident and no other side effect when disabled, not allowlisted, or the operator is missing", async () => {
    const { companyId, agentId } = await seedCompany();
    const other = await seedCompany({ operator: false });
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    const otherRunId = await seedRun({ companyId: other.companyId, agentId: other.agentId, offsetMinutes: 0 });
    const before = await db.select().from(heartbeatRuns);

    const disabled = claudeQuotaCardService(db, { config: () => ({ companyIds: new Set(), operatorUserId: null, warnings: [] }) });
    expect(await disabled.observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "disabled" });
    const notAllowlisted = claudeQuotaCardService(db, { config: enabledConfig(randomUUID()) });
    expect(await notAllowlisted.observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "disabled" });
    const noOperator = claudeQuotaCardService(db, { config: enabledConfig(companyId, null) });
    expect(await noOperator.observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "disabled" });
    const invalidOperator = claudeQuotaCardService(db, { config: enabledConfig(other.companyId, "ghost-user") });
    expect(await invalidOperator.observeFailedRun({ id: otherRunId, companyId: other.companyId })).toMatchObject({ status: "disabled", reason: "operator_unavailable" });
    expect(await disabled.reconcile()).toMatchObject({ scanned: 0 });

    expect(await db.select().from(heartbeatRuns)).toEqual(before);
    expect(await incidents(companyId)).toHaveLength(0);
    expect(await incidents(other.companyId)).toHaveLength(0);
    expect(await cards(companyId)).toHaveLength(0);
  });

  it("does not touch another company's runs when one company is enabled", async () => {
    const enabled = await seedCompany();
    const other = await seedCompany();
    const otherRun = await seedRun({ companyId: other.companyId, agentId: other.agentId, offsetMinutes: 0 });
    const service = newService(enabled.companyId);
    await service.reconcile();
    expect(await service.observeFailedRun({ id: otherRun, companyId: other.companyId })).toMatchObject({ status: "disabled" });
    expect(await receiptOf(otherRun)).toBeNull();
    expect(await incidents(other.companyId)).toHaveLength(0);
  });

  it("excludes agents with their own login and records only an exclusion receipt", async () => {
    const { companyId, agentId } = await seedCompany();
    for (const key of ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
      const evidence = evidenceFor(connectionA, { agentEnv: { [key]: "/home/own/.claude" } });
      expect(evidence.eligible).toBe(false);
      expect(JSON.stringify(evidence)).not.toContain("/home/own");
    }
    const evidence = evidenceFor(connectionA, { agentEnv: { CLAUDE_CONFIG_DIR: "/home/own/.claude" } });
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0, evidence });
    expect(await newService(companyId).observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "excluded" });
    expect(await incidents(companyId)).toHaveLength(0);
    expect(await cards(companyId)).toHaveLength(0);
    expect(await receiptOf(runId)).toMatchObject({ status: "excluded" });
  });

  it("ignores eligibility evidence copied from another run by a scheduled retry", async () => {
    const { companyId, agentId } = await seedCompany();
    const service = newService(companyId);
    const firstRun = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    expect(await service.observeFailedRun({ id: firstRun, companyId })).toMatchObject({ status: "recorded" });
    await seedRun({ companyId, agentId, offsetMinutes: 5, status: "succeeded" });

    // The retry ran on an own login (no binding), so it carries the first run's snapshot untouched.
    const retryRun = await seedRun({ companyId, agentId, offsetMinutes: 10, evidenceRunId: firstRun });
    expect(await service.observeFailedRun({ id: retryRun, companyId })).toMatchObject({ status: "ignored", reason: "no_eligibility_evidence" });
    expect(await service.reconcile()).toMatchObject({ recorded: 0 });
    expect(await receiptOf(retryRun)).toBeNull();
    expect(await incidents(companyId)).toHaveLength(1);
    expect(await cards(companyId)).toHaveLength(1);
  });

  it("is ineligible for router, non-shared, non-claude and mismatched bindings", () => {
    const base = {
      runId: randomUUID(),
      adapterType: "claude_local",
      requestedBinding: { mode: "shared", ...connectionA },
      attribution: aiConnection(connectionA),
      agentConfig: {},
      effectiveConfig: {},
      environmentEnv: null,
      projectEnv: null,
      routineEnv: null,
    };
    expect(evaluateClaudeQuotaEligibility(base).eligible).toBe(true);
    expect(evaluateClaudeQuotaEligibility({ ...base, requestedBinding: { mode: "router", connectionId: connectionA.connectionId } }).eligible).toBe(false);
    expect(evaluateClaudeQuotaEligibility({ ...base, requestedBinding: { mode: "responsible_user" } }).eligible).toBe(false);
    expect(evaluateClaudeQuotaEligibility({ ...base, adapterType: "codex_local" }).eligible).toBe(false);
    expect(evaluateClaudeQuotaEligibility({ ...base, attribution: { ...aiConnection(connectionA), provider: "openai" } }).eligible).toBe(false);
    expect(evaluateClaudeQuotaEligibility({ ...base, projectEnv: { CLAUDE_CONFIG_DIR: "x" } }).eligible).toBe(false);
    expect(evaluateClaudeQuotaEligibility({ ...base, effectiveConfig: { command: "/opt/claude-wrapper" } }).eligible).toBe(false);
  });

  it("leaves agents, connection health, scheduled retry and monitor rows unchanged", async () => {
    const { companyId, agentId } = await seedCompany();
    const connection = { connectionId: randomUUID(), grantId: randomUUID() };
    const applicationId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: "Claude", type: "rest_api" });
    await db.insert(toolConnections).values({
      id: connection.connectionId,
      companyId,
      applicationId,
      name: "Team Max",
      uid: `claude-${randomUUID()}`,
      connectionPurpose: "ai",
      transport: "runtime_auth",
      healthStatus: "healthy",
      healthMessage: "ok",
      healthCheckedAt: new Date(T0),
      lastHealthAt: new Date(T0),
    });
    await db.insert(connectionGrants).values({ id: connection.grantId, companyId, connectionId: connection.connectionId, kind: "user", subjectUserId: OPERATOR });
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Held source task",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      monitorNextCheckAt: new Date(T0 + 120 * MINUTE),
      monitorLastTriggeredAt: new Date(T0 - 30 * MINUTE),
      monitorAttemptCount: 3,
      monitorNotes: "waiting for the quota reset",
      monitorScheduledBy: "agent",
    });
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0, connection });
    await db
      .update(heartbeatRuns)
      .set({
        scheduledRetryAt: new Date(T0 + 90 * MINUTE),
        scheduledRetryAttempt: 2,
        scheduledRetryReason: "provider_quota",
        contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || ${JSON.stringify({ issueId: sourceIssueId })}::jsonb`,
      })
      .where(eq(heartbeatRuns.id, runId));
    const snapshot = async () => ({
      agents: await db.select().from(agents),
      wakeups: await db.select().from(agentWakeupRequests),
      connections: await db.select().from(toolConnections),
      grants: await db.select().from(connectionGrants),
      sourceIssue: (await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0],
      run: (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!,
    });
    const before = await snapshot();
    expect(before.connections).toHaveLength(1);
    expect(before.grants).toHaveLength(1);
    expect(before.sourceIssue?.monitorNextCheckAt).not.toBeNull();

    expect(await newService(companyId).observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "recorded" });

    const after = await snapshot();
    expect(after.agents).toEqual(before.agents);
    expect(after.wakeups).toEqual(before.wakeups);
    expect(after.connections).toEqual(before.connections);
    expect(after.grants).toEqual(before.grants);
    expect(after.sourceIssue).toEqual(before.sourceIssue);
    const { resultJson: _beforeResult, ...runBeforeRest } = before.run;
    const { resultJson: afterResult, ...runAfterRest } = after.run;
    expect(runAfterRest).toEqual(runBeforeRest);
    expect(afterResult).toMatchObject({ errorFamily: "provider_quota", claudeQuotaCard: { status: "recorded" } });
  });

  it("keeps task text, prompts, credentials and raw error JSON out of the host and card", async () => {
    const { companyId, agentId } = await seedCompany();
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0, error: `limit reached (Authorization: Bearer ${SECRET}) resets 5pm (America/New_York)` });
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({ id: sourceIssueId, companyId, title: "Secret customer migration", description: "PRIVATE-TASK-DESCRIPTION", status: "in_progress", priority: "medium" });
    await db.update(heartbeatRuns).set({ contextSnapshot: sql`${heartbeatRuns.contextSnapshot} || ${JSON.stringify({ issueId: sourceIssueId })}::jsonb` }).where(eq(heartbeatRuns.id, runId));

    await newService(companyId).observeFailedRun({ id: runId, companyId });

    const [host] = await incidents(companyId);
    const serialized = JSON.stringify({ host, cards: await cards(companyId), comments: await db.select().from(issueComments) });
    for (const forbidden of [SECRET, "PRIVATE-TASK-DESCRIPTION", "Secret customer migration", "Authorization", "errorFamily", "acct-1"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("Team Max");
  });

  it("serializes with the issue service when a host exists for a different source", async () => {
    const { companyId, agentId } = await seedCompany();
    await issueService(db).create(companyId, { title: "Unrelated", status: "todo", priority: "medium" });
    const runId = await seedRun({ companyId, agentId, offsetMinutes: 0 });
    expect(await newService(companyId).observeFailedRun({ id: runId, companyId })).toMatchObject({ status: "recorded" });
    expect(await incidents(companyId)).toHaveLength(1);
  });
});
