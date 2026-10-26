import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  agentTaskSessions,
  heartbeatRuns,
  issueComments,
  issueCreateIdempotencyKeys,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND } from "@paperclipai/shared";
import type { ClaudeQuotaCardConfig } from "../config.js";
import { errorHandler } from "../middleware/index.js";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueRoutes } from "../routes/issues.js";
import { aiConnectionService } from "../services/ai-connections.js";
import {
  CLAUDE_QUOTA_ELIGIBILITY_KEY,
  CLAUDE_QUOTA_SWITCH_REVISION_SOURCE,
  claudeQuotaCardService,
  evaluateClaudeQuotaEligibility,
} from "../services/claude-quota-card.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const OPERATOR = "operator-user";
const OTHER_USER = "other-board-user";
const T0 = new Date("2026-10-26T10:00:00.000Z").getTime();

describeEmbeddedPostgres("claude quota card account switch", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let connections!: ReturnType<typeof aiConnectionService>;
  const extraClients: Array<ReturnType<typeof createDb>> = [];
  let enabledCompanies: string[] = [];

  function syncEnv() {
    vi.stubEnv("PAPERCLIP_CLAUDE_QUOTA_CARD_COMPANY_IDS", enabledCompanies.join(","));
    vi.stubEnv("PAPERCLIP_CLAUDE_QUOTA_CARD_OPERATOR_USER_ID", OPERATOR);
  }

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-quota-switch-")));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "claude-quota-switch-fixture");
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-quota-switch-");
    db = createDb(tempDb.connectionString);
    connections = aiConnectionService(db);
  }, 60_000);

  afterEach(async () => {
    enabledCompanies = [];
    syncEnv();
    const cleanups = [
      () => db.delete(issueThreadInteractions),
      () => db.delete(activityLog),
      () => db.delete(issueComments),
      () => db.delete(agentConfigRevisions),
      () => db.delete(agentTaskSessions),
      () => db.delete(heartbeatRuns),
      () => db.delete(agentWakeupRequests),
      () => db.delete(issueCreateIdempotencyKeys),
      () => db.delete(issues),
      () => db.delete(toolConnectionInstalls),
      () => db.delete(connectionGrants),
      () => db.delete(toolConnections),
      () => db.delete(toolApplications),
      () => db.delete(principalPermissionGrants),
      () => db.delete(agents),
      () => db.delete(companyMemberships),
      () => db.delete(authUsers),
      () => db.delete(companies),
    ];
    for (const cleanup of cleanups) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    for (const client of extraClients) await client.$client.end().catch(() => undefined);
    await db.$client.end();
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  function config(companyId: string, enabled = true): () => ClaudeQuotaCardConfig {
    return () => ({
      companyIds: new Set(enabled ? [companyId] : []),
      operatorUserId: enabled ? OPERATOR : null,
      warnings: [],
    });
  }

  function newClient() {
    const client = createDb(tempDb!.connectionString);
    extraClients.push(client);
    return client;
  }

  function cardService(companyId: string, client = db) {
    return claudeQuotaCardService(client, { config: config(companyId) });
  }

  async function seedUsers(companyId: string) {
    for (const [userId, role] of [[OPERATOR, "owner"], [OTHER_USER, "owner"]] as const) {
      await db.insert(authUsers).values({ id: userId, name: userId, email: `${randomUUID()}@example.test`, createdAt: new Date(), updatedAt: new Date() }).onConflictDoNothing();
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: role, status: "active" });
    }
  }

  async function seedAccount(companyId: string, name: string) {
    return connections.save(
      companyId,
      OPERATOR,
      { provider: "anthropic", method: "api_key", ownership: "shared", name, apiKey: "fixture", agentIds: [], allAgents: true },
      `fixture-${name}`,
    );
  }

  function sharedBinding(account: { connectionId: string; grantId: string }) {
    return { provider: "anthropic", method: "api_key", mode: "shared", connectionId: account.connectionId, grantId: account.grantId } as const;
  }

  async function seedAgent(
    companyId: string,
    name: string,
    binding: { connectionId: string; grantId: string } | null,
    overrides: { runtimeConfig?: Record<string, unknown>; adapterConfig?: Record<string, unknown>; status?: string } = {},
  ) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: overrides.status ?? "idle",
      adapterType: "claude_local",
      adapterConfig: overrides.adapterConfig ?? { model: "claude-sonnet-4-5" },
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 3600, maxConcurrentRuns: 2 },
        ...(binding ? { aiConnection: sharedBinding(binding) } : {}),
        ...overrides.runtimeConfig,
      },
      permissions: {},
    });
    return id;
  }

  async function seedFailedRun(companyId: string, agentId: string, source: { connectionId: string; grantId: string }, offsetMinutes = 0) {
    const id = randomUUID();
    const startedAt = new Date(T0 + offsetMinutes * 60_000);
    const attribution = { ...sharedBinding(source), responsibleUserId: OPERATOR, accountName: "Team Max", identity: "acct-a", sessionIdentity: "acct-a" };
    const evidence = {
      ...evaluateClaudeQuotaEligibility({
        runId: id,
        adapterType: "claude_local",
        requestedBinding: sharedBinding(source),
        attribution,
        agentConfig: { env: {} },
        effectiveConfig: { env: {} },
        environmentEnv: null,
        projectEnv: null,
        routineEnv: null,
      }),
      runId: id,
    };
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      startedAt,
      finishedAt: new Date(startedAt.getTime() + 60_000),
      createdAt: startedAt,
      errorCode: "provider_quota",
      error: "You've hit your limit. resets 5pm (America/New_York)",
      resultJson: { errorFamily: "provider_quota" },
      contextSnapshot: { issueId: randomUUID(), aiConnection: attribution, [CLAUDE_QUOTA_ELIGIBILITY_KEY]: evidence },
    });
    return id;
  }

  type World = Awaited<ReturnType<typeof seedWorld>>;

  async function seedWorld(options: { agentCount?: number; targets?: string[] } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Somnex",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    enabledCompanies.push(companyId);
    syncEnv();
    await seedUsers(companyId);
    const source = await seedAccount(companyId, "Team Max");
    const targets: Array<{ connectionId: string; grantId: string; name: string }> = [];
    for (const name of options.targets ?? ["Backup Max"]) targets.push({ ...(await seedAccount(companyId, name)), name });
    const agentIds: string[] = [];
    for (let i = 0; i < (options.agentCount ?? 2); i += 1) agentIds.push(await seedAgent(companyId, `Coder ${i}`, source));
    const runId = await seedFailedRun(companyId, agentIds[0]!, source);
    return { companyId, source, targets, agentIds, runId };
  }

  async function raiseCard(world: World) {
    const observation = await cardService(world.companyId).observeFailedRun({ id: world.runId, companyId: world.companyId });
    expect(observation).toMatchObject({ status: "recorded" });
    const [card] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, world.companyId));
    const [host] = await db.select().from(issues).where(and(eq(issues.companyId, world.companyId), eq(issues.originKind, CLAUDE_QUOTA_INCIDENT_ORIGIN_KIND)));
    return { card: card!, host: host! };
  }

  function boardActor(companyId: string, userId = OPERATOR, isInstanceAdmin = true) {
    return {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "owner" }],
      isInstanceAdmin,
    };
  }

  function app(actor: Record<string, unknown>, client = db) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(client, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function accept(world: World, issueId: string, interactionId: string, selectedOptionIds: string[], actor = boardActor(world.companyId), client = db) {
    return request(app(actor, client)).post(`/api/issues/${issueId}/interactions/${interactionId}/accept`).send({ selectedOptionIds });
  }

  async function revisions(agentId: string) {
    return db.select().from(agentConfigRevisions).where(eq(agentConfigRevisions.agentId, agentId)).orderBy(asc(agentConfigRevisions.createdAt));
  }

  async function runtimeOf(agentId: string) {
    const [row] = await db.select({ runtimeConfig: agents.runtimeConfig }).from(agents).where(eq(agents.id, agentId));
    return row!.runtimeConfig as Record<string, any>;
  }

  async function revisionCount(companyId: string) {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(agentConfigRevisions).where(eq(agentConfigRevisions.companyId, companyId));
    return row!.count;
  }

  async function cardOf(id: string) {
    const [row] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, id));
    return row!;
  }

  // Cards ----------------------------------------------------------------------

  it("offers one preselected target with a single click label", async () => {
    const world = await seedWorld();
    const { card } = await raiseCard(world);
    expect(card.kind).toBe("request_checkbox_confirmation");
    const payload = card.payload as Record<string, any>;
    expect(payload).toMatchObject({
      minSelected: 1,
      maxSelected: 1,
      defaultSelectedOptionIds: [world.targets[0]!.grantId],
      acceptLabel: "Switch listed agents to Backup Max",
      rejectLabel: "Keep current account",
      rejectRequiresReason: false,
    });
    expect(payload.claudeQuotaSwitch.agents.map((entry: any) => entry.agentId).sort()).toEqual([...world.agentIds].sort());
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("offers several targets with nothing preselected and changes nothing without a click", async () => {
    const world = await seedWorld({ targets: ["Backup One", "Backup Two"] });
    const { card } = await raiseCard(world);
    const payload = card.payload as Record<string, any>;
    expect(payload.options).toHaveLength(2);
    expect(payload.defaultSelectedOptionIds).toEqual([]);
    expect(payload).toMatchObject({ minSelected: 1, maxSelected: 1 });
    expect(await revisionCount(world.companyId)).toBe(0);
    expect((await runtimeOf(world.agentIds[0]!)).aiConnection.connectionId).toBe(world.source.connectionId);
  });

  it("keeps the acknowledgement-only card when no compatible target exists", async () => {
    const world = await seedWorld({ targets: [] });
    const { card } = await raiseCard(world);
    expect(card.kind).toBe("request_confirmation");
    expect(card.payload).toMatchObject({ acceptLabel: "Acknowledge", rejectLabel: "Dismiss" });
  });

  it("keeps the acknowledgement-only card when no agent is eligible", async () => {
    const world = await seedWorld();
    await db.update(agents).set({ adapterConfig: { env: { ANTHROPIC_API_KEY: "own-login" } } }).where(eq(agents.companyId, world.companyId));
    const { card } = await raiseCard(world);
    expect(card.kind).toBe("request_confirmation");
  });

  it("stays informational above the agent bound", async () => {
    const world = await seedWorld({ agentCount: 1 });
    for (let i = 0; i < 200; i += 1) await seedAgent(world.companyId, `Extra ${i}`, world.source);
    const { card } = await raiseCard(world);
    expect(card.kind).toBe("request_confirmation");
  });

  it("does not offer a target the agents cannot use", async () => {
    const world = await seedWorld();
    await db.update(toolConnectionInstalls).set({ targetType: "agent", targetId: randomUUID() }).where(eq(toolConnectionInstalls.connectionId, world.targets[0]!.connectionId));
    const { card } = await raiseCard(world);
    expect(card.kind).toBe("request_confirmation");
  });

  // Accept ---------------------------------------------------------------------

  it("switches each listed agent with exactly one revision that changes only the AI connection", async () => {
    const world = await seedWorld({ agentCount: 3 });
    const { card, host } = await raiseCard(world);
    const before = await Promise.all(world.agentIds.map(runtimeOf));
    const target = world.targets[0]!;

    const response = await accept(world, host.id, card.id, [target.grantId]);

    expect(response.status).toBe(200);
    const stored = await cardOf(card.id);
    expect(stored.status).toBe("accepted");
    const result = (stored.result as Record<string, any>).claudeQuotaSwitch;
    expect(result.targetOptionId).toBe(target.grantId);
    expect(result.changed).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    for (const [index, agentId] of world.agentIds.entries()) {
      const rows = await revisions(agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: CLAUDE_QUOTA_SWITCH_REVISION_SOURCE, createdByUserId: OPERATOR, changedKeys: ["runtimeConfig"] });
      expect(result.changed.find((entry: any) => entry.agentId === agentId).revisionId).toBe(rows[0]!.id);
      const after = await runtimeOf(agentId);
      expect(after.aiConnection).toEqual(sharedBinding(target));
      const { aiConnection: _a, ...afterRest } = after;
      const { aiConnection: _b, ...beforeRest } = before[index]!;
      expect(afterRest).toEqual(beforeRest);
      const beforeSnapshot = rows[0]!.beforeConfig as Record<string, any>;
      const afterSnapshot = rows[0]!.afterConfig as Record<string, any>;
      expect({ ...afterSnapshot, runtimeConfig: undefined }).toEqual({ ...beforeSnapshot, runtimeConfig: undefined });
    }
  });

  it("requires exactly one selected account that the card offers", async () => {
    const world = await seedWorld({ targets: ["Backup One", "Backup Two"] });
    const { card, host } = await raiseCard(world);
    expect((await accept(world, host.id, card.id, [])).status).toBe(422);
    expect((await accept(world, host.id, card.id, [world.targets[0]!.grantId, world.targets[1]!.grantId])).status).toBeGreaterThanOrEqual(400);
    expect((await accept(world, host.id, card.id, [randomUUID()])).status).toBeGreaterThanOrEqual(400);
    expect((await cardOf(card.id)).status).toBe("pending");
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("skips an agent a human edited, including an A to B to A edit, and names the reason", async () => {
    const world = await seedWorld({ agentCount: 3 });
    const { card, host } = await raiseCard(world);
    const [edited, aba, untouched] = world.agentIds as [string, string, string];
    const lifecycle = await import("../services/agent-configuration-transaction.js");
    await db.transaction((tx) => lifecycle.updateAgentConfigurationInTransaction(
      tx as never, edited, { runtimeConfig: { heartbeat: { enabled: false } , aiConnection: sharedBinding(world.source) } },
      { recordRevision: { source: "patch", createdByUserId: OTHER_USER } },
    ));
    for (const binding of [world.targets[0]!, world.source]) {
      await db.transaction((tx) => lifecycle.updateAgentConfigurationInTransaction(
        tx as never, aba, { runtimeConfig: { heartbeat: { enabled: true, intervalSec: 3600, maxConcurrentRuns: 2 }, aiConnection: sharedBinding(binding) } },
        { recordRevision: { source: "patch", createdByUserId: OTHER_USER } },
      ));
    }

    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);

    expect(response.status).toBe(200);
    const result = ((await cardOf(card.id)).result as Record<string, any>).claudeQuotaSwitch;
    expect(result.changed.map((entry: any) => entry.agentId)).toEqual([untouched]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { agentId: edited, reason: "config_changed" },
      { agentId: aba, reason: "config_changed" },
    ]));
    expect((await runtimeOf(edited)).heartbeat.enabled).toBe(false);
    expect((await runtimeOf(aba)).aiConnection.connectionId).toBe(world.source.connectionId);
    expect((await runtimeOf(untouched)).aiConnection.connectionId).toBe(world.targets[0]!.connectionId);
    expect(await revisions(untouched)).toHaveLength(1);
  });

  it("skips an agent that moved to another account, one that was paused for termination, and a revoked install", async () => {
    const world = await seedWorld({ agentCount: 3 });
    const { card, host } = await raiseCard(world);
    const [moved, terminated, ok] = world.agentIds as [string, string, string];
    await db.update(agents).set({ runtimeConfig: sql`jsonb_set(runtime_config, '{aiConnection,grantId}', to_jsonb(${randomUUID()}::text))` }).where(eq(agents.id, moved));
    await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, terminated));

    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);

    expect(response.status).toBe(200);
    const result = ((await cardOf(card.id)).result as Record<string, any>).claudeQuotaSwitch;
    expect(result.changed.map((entry: any) => entry.agentId)).toEqual([ok]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { agentId: moved, reason: "binding_changed" },
      { agentId: terminated, reason: "agent_not_active" },
    ]));
  });

  it("changes nothing when the target grant or install was revoked after the card was made", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, world.targets[0]!.grantId));

    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);

    expect(response.status).toBe(200);
    const result = ((await cardOf(card.id)).result as Record<string, any>).claudeQuotaSwitch;
    expect(result.changed).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toMatch(/^target_unavailable/);
    expect(await revisionCount(world.companyId)).toBe(0);
    expect((await runtimeOf(world.agentIds[0]!)).aiConnection.connectionId).toBe(world.source.connectionId);
  });

  it("changes nothing for an agent whose install for the target was removed", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, world.targets[0]!.connectionId));

    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);

    expect(response.status).toBe(200);
    expect(((await cardOf(card.id)).result as Record<string, any>).claudeQuotaSwitch.changed).toEqual([]);
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("resolves with every agent skipped when none is eligible any more", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    await db.update(agents).set({ adapterConfig: { env: { ANTHROPIC_API_KEY: "own-login" } } }).where(eq(agents.companyId, world.companyId));
    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
    expect(response.status).toBe(200);
    const result = ((await cardOf(card.id)).result as Record<string, any>).claudeQuotaSwitch;
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((entry: any) => entry.reason)).toEqual(["config_changed", "config_changed"]);
  });

  it("rolls the acceptance and every revision back when a later agent fails mid-batch", async () => {
    const world = await seedWorld({ agentCount: 3 });
    const { card, host } = await raiseCard(world);
    const sorted = [...world.agentIds].sort();
    // The last agent in lock order fails inside the real configuration write.
    await db.execute(sql.raw(`
      create or replace function claude_quota_switch_test_fail() returns trigger language plpgsql as $$
      begin
        if new.id = '${sorted[2]}'::uuid then raise exception 'injected failure'; end if;
        return new;
      end $$;
    `));
    await db.execute(sql.raw(`create trigger claude_quota_switch_test_fail before update on agents for each row execute function claude_quota_switch_test_fail()`));
    try {
      const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
      expect(response.status).toBeGreaterThanOrEqual(500);
    } finally {
      await db.execute(sql.raw(`drop trigger if exists claude_quota_switch_test_fail on agents`));
      await db.execute(sql.raw(`drop function if exists claude_quota_switch_test_fail()`));
    }

    expect((await cardOf(card.id)).status).toBe("pending");
    expect(await revisionCount(world.companyId)).toBe(0);
    for (const agentId of world.agentIds) expect((await runtimeOf(agentId)).aiConnection.connectionId).toBe(world.source.connectionId);

    const retry = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
    expect(retry.status).toBe(200);
    expect(await revisionCount(world.companyId)).toBe(3);
  });

  it("creates no duplicate revisions for two clicks, two simultaneous accepts, or a restart after commit", async () => {
    const world = await seedWorld({ agentCount: 2 });
    const { card, host } = await raiseCard(world);
    const target = world.targets[0]!;

    const results = await Promise.all([
      accept(world, host.id, card.id, [target.grantId], boardActor(world.companyId), newClient()),
      accept(world, host.id, card.id, [target.grantId], boardActor(world.companyId), newClient()),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await revisionCount(world.companyId)).toBe(2);

    const second = await accept(world, host.id, card.id, [target.grantId]);
    expect(second.status).toBe(409);
    const restarted = await accept(world, host.id, card.id, [target.grantId], boardActor(world.companyId), newClient());
    expect(restarted.status).toBe(409);
    await cardService(world.companyId, newClient()).reconcile();
    expect(await revisionCount(world.companyId)).toBe(2);
    expect((await cardOf(card.id)).status).toBe("accepted");
  });

  it("lets two conflicting source cards switch an agent at most once", async () => {
    const world = await seedWorld({ agentCount: 1, targets: ["Backup One"] });
    const first = await raiseCard(world);
    const otherSource = await seedAccount(world.companyId, "Second Max");
    const otherAgent = await seedAgent(world.companyId, "Other coder", otherSource);
    const otherRun = await seedFailedRun(world.companyId, otherAgent, otherSource, 5);
    await cardService(world.companyId).observeFailedRun({ id: otherRun, companyId: world.companyId });
    const cards = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, world.companyId));
    const second = cards.find((row) => row.id !== first.card.id)!;
    expect(second.kind).toBe("request_checkbox_confirmation");
    const secondPayload = second.payload as Record<string, any>;
    const secondTarget = secondPayload.options.find((option: any) => option.id === world.targets[0]!.grantId);
    expect(secondTarget).toBeTruthy();

    // The second card is made stale by moving its agent onto the first card's source.
    await db.update(agents).set({ runtimeConfig: sql`jsonb_set(jsonb_set(runtime_config, '{aiConnection,connectionId}', to_jsonb(${world.source.connectionId}::text)), '{aiConnection,grantId}', to_jsonb(${world.source.grantId}::text))` }).where(eq(agents.id, otherAgent));

    const a = await accept(world, first.host.id, first.card.id, [world.targets[0]!.grantId]);
    const b = await accept(world, second.issueId, second.id, [world.targets[0]!.grantId]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const secondResult = ((await cardOf(second.id)).result as Record<string, any>).claudeQuotaSwitch;
    expect(secondResult.changed).toEqual([]);
    expect(secondResult.skipped).toEqual([{ agentId: otherAgent, reason: "binding_changed" }]);
    expect(await revisions(otherAgent)).toHaveLength(0);
    expect((await runtimeOf(otherAgent)).aiConnection.connectionId).toBe(world.source.connectionId);
    expect(await revisions(world.agentIds[0]!)).toHaveLength(1);
  });

  // Callers --------------------------------------------------------------------

  it("rejects a public create that carries the reserved payload, even from a board user", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    const payload = JSON.parse(JSON.stringify(card.payload));
    for (const actor of [boardActor(world.companyId), { type: "agent", source: "agent_key", companyId: world.companyId, agentId: world.agentIds[0], runId: randomUUID() }]) {
      const response = await request(app(actor as any)).post(`/api/issues/${host.id}/interactions`).send({ kind: "request_checkbox_confirmation", title: "forged", idempotencyKey: randomUUID(), payload });
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    await expect(
      issueThreadInteractionService(db).create(host as never, { kind: "request_checkbox_confirmation", title: "forged", payload } as never, { userId: OPERATOR } as never),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      issueThreadInteractionService(db).create(host as never, { kind: "request_checkbox_confirmation", title: "forged", payload } as never, { systemId: "someone-else" } as never),
    ).rejects.toMatchObject({ status: 422 });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, host.id))).toHaveLength(1);
  });

  it("does not let an agent caller or a different board user run the switch", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    const target = world.targets[0]!.grantId;
    const agentActor = { type: "agent", source: "agent_key", companyId: world.companyId, agentId: world.agentIds[0], runId: randomUUID() };
    expect((await request(app(agentActor as any)).post(`/api/issues/${host.id}/interactions/${card.id}/accept`).send({ selectedOptionIds: [target] })).status).toBeGreaterThanOrEqual(400);
    expect((await accept(world, host.id, card.id, [target], boardActor(world.companyId, OTHER_USER))).status).toBeGreaterThanOrEqual(400);
    expect((await cardOf(card.id)).status).toBe("pending");
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("does not let a board user without agent-config permission switch", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    const actor = { ...boardActor(world.companyId, OPERATOR, false), memberships: [{ companyId: world.companyId, status: "active", membershipRole: "viewer" }] };
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(and(eq(companyMemberships.companyId, world.companyId), eq(companyMemberships.principalId, OPERATOR)));
    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId], actor);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect((await cardOf(card.id)).status).toBe("pending");
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("does not run for another company's board user or against another company's agents", async () => {
    const world = await seedWorld();
    const other = await seedWorld();
    const { card, host } = await raiseCard(world);
    const foreign = await accept(world, host.id, card.id, [world.targets[0]!.grantId], boardActor(other.companyId, OPERATOR, false));
    expect(foreign.status).toBeGreaterThanOrEqual(400);

    // A forged stored payload that points at another company's agent is skipped, never written.
    const payload = JSON.parse(JSON.stringify(card.payload));
    payload.claudeQuotaSwitch.agents[0].agentId = other.agentIds[0];
    await db.update(issueThreadInteractions).set({ payload }).where(eq(issueThreadInteractions.id, card.id));
    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
    expect(response.status).toBe(200);
    expect(await revisionCount(other.companyId)).toBe(0);
    expect((await runtimeOf(other.agentIds[0]!)).aiConnection.connectionId).toBe(other.source.connectionId);
  });

  it("fails closed when the feature is off at click time", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    vi.stubEnv("PAPERCLIP_CLAUDE_QUOTA_CARD_COMPANY_IDS", "");
    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
    expect(response.status).toBe(409);
    syncEnv();
    expect((await cardOf(card.id)).status).toBe("pending");
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("fails closed when the interaction is accepted without the handler", async () => {
    const world = await seedWorld();
    const { card, host } = await raiseCard(world);
    await expect(
      issueThreadInteractionService(db).acceptInteraction(
        host as never,
        card.id,
        { selectedOptionIds: [world.targets[0]!.grantId] } as never,
        { userId: OPERATOR } as never,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await cardOf(card.id)).status).toBe("pending");
    expect(await revisionCount(world.companyId)).toBe(0);
  });

  it("never runs the switch on reject, skip or withdraw, and a comment cannot answer the card", async () => {
    const world = await seedWorld({ agentCount: 3 });
    const { card, host } = await raiseCard(world);
    const rejected = await request(app(boardActor(world.companyId))).post(`/api/issues/${host.id}/interactions/${card.id}/reject`).send({});
    expect(rejected.status).toBe(200);
    expect((await cardOf(card.id)).status).toBe("rejected");
    expect(await revisionCount(world.companyId)).toBe(0);
    for (const agentId of world.agentIds) expect((await runtimeOf(agentId)).aiConnection.connectionId).toBe(world.source.connectionId);
    const [stored] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, card.id));
    expect(JSON.stringify(stored!.result)).not.toContain("claudeQuotaSwitch");
  });

  // End to end ------------------------------------------------------------------

  it("runs the next normal execution on the new account with a fresh session and leaves holds alone", async () => {
    const world = await seedWorld({ agentCount: 2 });
    const [worker, paused] = world.agentIds as [string, string];
    await db.update(agents).set({ adapterConfig: { cwd: home, engine: "cli", model: "claude-sonnet-4-5" } }).where(eq(agents.companyId, world.companyId));
    await db.update(agents).set({ status: "paused", pauseReason: "budget", pausedAt: new Date() }).where(eq(agents.id, paused));
    const monitorAt = new Date(Date.now() + 6 * 3600_000);
    const [task, held, review, cancelled] = await db.insert(issues).values([
      { companyId: world.companyId, title: "Normal work", status: "todo", assigneeAgentId: worker, responsibleUserId: OPERATOR, createdByUserId: OPERATOR, identifier: `E-${randomUUID().slice(0, 6)}` },
      { companyId: world.companyId, title: "Held by monitor", status: "blocked", assigneeAgentId: worker, monitorNextCheckAt: monitorAt, monitorNotes: "quota", monitorScheduledBy: "system", monitorAttemptCount: 2, identifier: `E-${randomUUID().slice(0, 6)}` },
      { companyId: world.companyId, title: "Held by budget pause", status: "in_review", assigneeAgentId: paused, identifier: `E-${randomUUID().slice(0, 6)}` },
      { companyId: world.companyId, title: "Cancelled", status: "cancelled", assigneeAgentId: worker, identifier: `E-${randomUUID().slice(0, 6)}` },
    ] as never).returning();

    const calls: Array<{ sessionId: string | null; account: Record<string, any> }> = [];
    const execute = vi.fn(async (ctx: any) => {
      calls.push({ sessionId: ctx.runtime?.sessionId ?? null, account: { ...(ctx.context?.aiConnection ?? {}) } });
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, task!.id));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "native-session-a", sessionParams: { sessionId: "native-session-a", cwd: home }, sessionDisplayId: "native-session-a", summary: "ok" };
    });
    registerServerAdapter({ ...getServerAdapter("claude_local"), execute } as never);
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    const wake = async (reason = "issue_commented") => {
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, task!.id));
      const run = await heartbeat.wakeup(worker, { source: "automation", reason, payload: { issueId: task!.id }, contextSnapshot: { issueId: task!.id, wakeReason: reason, responsibleUserId: OPERATOR }, triggerDetail: "system" });
      expect(run).not.toBeNull();
      await expect.poll(async () => (await heartbeat.getRun(run!.id))?.status, { timeout: 25_000 }).toMatch(/^(succeeded|failed|cancelled)$/);
      const done = (await heartbeat.getRun(run!.id))!;
      return done;
    };
    const settle = async () => {
      let previous = -1;
      for (let stable = 0; stable < 2;) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, world.companyId));
        const busy = rows.some((row) => row.status === "queued" || row.status === "running");
        stable = !busy && rows.length === previous ? stable + 1 : 0;
        previous = rows.length;
      }
    };
    try {
      const first = await wake("issue_assigned");
      expect(first.status).toBe("succeeded");
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0]!.account.connectionId).toBe(world.source.connectionId);
      await expect.poll(async () => (await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, worker)))[0]?.sessionDisplayId, { timeout: 10_000 }).toBe("native-session-a");

      await settle();
      const beforeSecond = calls.length;
      const second = await wake();
      expect(second.status).toBe("succeeded");
      expect(calls[beforeSecond]!.sessionId).toBe("native-session-a");

      await settle();
      const callsBeforeSwitch = calls.length;
      const { card, host } = await raiseCard(world);
      const holdsBefore = await db.select({ id: issues.id, status: issues.status, monitorNextCheckAt: issues.monitorNextCheckAt, monitorAttemptCount: issues.monitorAttemptCount }).from(issues).where(inArray(issues.id, [held!.id, review!.id, cancelled!.id]));
      const runsBefore = (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, world.companyId))).length;
      const wakeupsBefore = (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, world.companyId))).length;

      const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
      expect(response.status).toBe(200);
      expect(await revisionCount(world.companyId)).toBe(2);

      expect((await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, world.companyId))).length).toBe(runsBefore);
      expect((await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, world.companyId))).length).toBe(wakeupsBefore);
      expect(await db.select({ id: issues.id, status: issues.status, monitorNextCheckAt: issues.monitorNextCheckAt, monitorAttemptCount: issues.monitorAttemptCount }).from(issues).where(inArray(issues.id, [held!.id, review!.id, cancelled!.id]))).toEqual(holdsBefore);
      expect(calls).toHaveLength(callsBeforeSwitch);

      const third = await wake();
      expect(third.status).toBe("succeeded");
      const last = calls[callsBeforeSwitch]!;
      expect(last.sessionId).toBeNull();
      expect(last.account.connectionId).toBe(world.targets[0]!.connectionId);
      expect(last.account.grantId).toBe(world.targets[0]!.grantId);
    } finally {
      unregisterServerAdapter("claude_local");
      await heartbeat.drainActiveRunExecutions();
    }
  }, 90_000);

  // Held work ------------------------------------------------------------------

  it("leaves held task schedules and run state untouched", async () => {
    const world = await seedWorld({ agentCount: 2 });
    const { card, host } = await raiseCard(world);
    const monitorAt = new Date(T0 + 6 * 3600_000);
    const held = await db.insert(issues).values([
      { companyId: world.companyId, title: "Held by monitor", status: "blocked", assigneeAgentId: world.agentIds[0]!, monitorNextCheckAt: monitorAt, monitorNotes: "quota", monitorScheduledBy: "system", monitorAttemptCount: 2, identifier: `H-${randomUUID().slice(0, 6)}` },
      { companyId: world.companyId, title: "Cancelled hold", status: "cancelled", assigneeAgentId: world.agentIds[1]!, identifier: `H-${randomUUID().slice(0, 6)}` },
    ] as never).returning();
    const retryAt = new Date(T0 + 7 * 3600_000);
    const [retry] = await db.insert(heartbeatRuns).values({
      companyId: world.companyId, agentId: world.agentIds[0]!, invocationSource: "automation", triggerDetail: "system", status: "scheduled_retry",
      scheduledRetryAt: retryAt, scheduledRetryReason: "provider_quota", scheduledRetryAttempt: 1, contextSnapshot: { issueId: held[0]!.id },
    } as never).returning();
    const snapshot = async () => ({
      issues: await db.select({ id: issues.id, status: issues.status, monitorNextCheckAt: issues.monitorNextCheckAt, monitorAttemptCount: issues.monitorAttemptCount, monitorNotes: issues.monitorNotes, assigneeAgentId: issues.assigneeAgentId }).from(issues).where(eq(issues.companyId, world.companyId)).orderBy(asc(issues.id)),
      retry: await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status, scheduledRetryAt: heartbeatRuns.scheduledRetryAt, scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt }).from(heartbeatRuns).where(eq(heartbeatRuns.id, retry!.id)),
      runs: (await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, world.companyId))).length,
      wakeups: (await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, world.companyId))).length,
    });
    const hostBefore = await snapshot();

    const response = await accept(world, host.id, card.id, [world.targets[0]!.grantId]);
    expect(response.status).toBe(200);

    const after = await snapshot();
    expect(after.retry).toEqual(hostBefore.retry);
    expect(after.runs).toBe(hostBefore.runs);
    expect(after.wakeups).toBe(hostBefore.wakeups);
    const withoutHost = (rows: typeof after.issues) => rows.filter((row) => row.id !== host.id);
    expect(withoutHost(after.issues)).toEqual(withoutHost(hostBefore.issues));
  });
});
