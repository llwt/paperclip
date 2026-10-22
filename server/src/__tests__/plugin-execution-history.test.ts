import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, issueExecutionDecisions, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import type { PluginIssueExecutionDecisionsPage } from "../../../packages/plugins/sdk/src/types.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Execution history tests unavailable: ${support.reason}`);
const describeDb = support.supported ? describe : describe.skip;

describeDb("plugin execution history through worker RPC and host query", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const issueId = randomUUID();
  const otherIssueId = randomUUID();
  const emptyIssueId = randomUUID();
  const agentId = randomUUID();
  const foreignAgentId = randomUUID();
  const missingAgentId = randomUUID();
  const stageId = randomUUID();
  const removedStageId = randomUUID();
  const userId = "history-member";
  const foreignUserId = "history-nonmember";
  const inactiveUserId = "history-inactive";
  const timestamp = new Date("2026-10-21T08:00:00.000Z");
  const ids = Array.from({ length: 125 }, () => randomUUID()).sort();
  const policy = {
    mode: "normal" as const, commentRequired: true,
    stages: [{ id: stageId, type: "review" as const, approvalsNeeded: 1 as const, participants: [
      { id: randomUUID(), type: "agent" as const, agentId },
      { id: randomUUID(), type: "user" as const, userId },
      { id: randomUUID(), type: "user" as const, userId: inactiveUserId },
    ] }],
  };
  const state = {
    status: "pending" as const, currentStageId: stageId, currentStageIndex: 0, currentStageType: "review" as const,
    currentParticipant: { type: "agent" as const, agentId: missingAgentId },
    returnAssignee: { type: "agent" as const, agentId: foreignAgentId },
    reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
  };

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-plugin-history-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([
      { id: companyId, name: "History fixture", issuePrefix: "HIST" },
      { id: otherCompanyId, name: "Other fixture", issuePrefix: "OTHER" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Current reviewer", role: "engineer", adapterType: "codex_local" },
      { id: foreignAgentId, companyId: otherCompanyId, name: "Private other agent", role: "engineer", adapterType: "codex_local" },
    ]);
    await db.insert(authUsers).values([userId, foreignUserId, inactiveUserId, "history-unreferenced"].map(id => ({
      id, name: `Name ${id}`, email: `${id}@example.test`, createdAt: timestamp, updatedAt: timestamp,
    })));
    await db.insert(companyMemberships).values([
      { companyId, principalType: "user", principalId: userId, status: "active" },
      { companyId: otherCompanyId, principalType: "user", principalId: foreignUserId, status: "active" },
      { companyId, principalType: "user", principalId: inactiveUserId, status: "suspended" },
      { companyId, principalType: "user", principalId: "history-unreferenced", status: "active" },
    ]);
    await db.insert(issues).values([
      { id: issueId, companyId, identifier: "HIST-1", title: "With retained decisions", executionPolicy: policy, executionState: state },
      { id: emptyIssueId, companyId, title: "Empty" },
      { id: otherIssueId, companyId: otherCompanyId, title: "Other" },
    ]);
    // All timestamps are equal, with repeated rounds and a stage removed from the current policy.
    await db.insert(issueExecutionDecisions).values(ids.map((id, i) => ({
      id, companyId, issueId, stageId: i % 2 ? stageId : removedStageId,
      stageType: i % 2 ? "review" : "approval", outcome: i % 3 ? "approved" : "changes_requested",
      actorAgentId: i % 4 === 0 ? agentId : null,
      actorUserId: i === 1 ? foreignUserId : i === 124 ? userId : null,
      body: `Round ${i}`, createdAt: timestamp, updatedAt: timestamp,
    })));
    // A malformed retained cross-company row must still be excluded by the query.
    await db.insert(issueExecutionDecisions).values({ companyId: otherCompanyId, issueId, stageId, stageType: "review", outcome: "approved", body: "Must stay private" });
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); });

  async function rpc(scopeCompanyId = companyId, capabilities: PaperclipPluginManifestV1["capabilities"] = ["issue.execution.read", "issues.read"]) {
    expect(pluginCapabilityValidator().getRequiredCapabilities("issues.listExecutionDecisions")).toEqual(["issue.execution.read"]);
    const services = buildHostServices(db, randomUUID(), "fixture.execution-history", {
      forPlugin: () => ({ emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() }),
    } as never);
    const listSpy = vi.spyOn(services.issues, "listExecutionDecisions");
    const handlers = createHostClientHandlers({ pluginId: "fixture.execution-history", capabilities, services });
    const handle = createPluginWorkerHandle("fixture.execution-history", {
      entrypointPath: fileURLToPath(new URL("./fixtures/plugin-execution-history-worker.mjs", import.meta.url)),
      manifest: { id: "fixture.execution-history", apiVersion: 1, version: "0.1.0", displayName: "Fixture", description: "Synthetic fixture", author: "Tests", categories: ["automation"], capabilities, entrypoints: {} },
      config: {}, instanceInfo: { instanceId: "test", hostVersion: "1.0.0" }, apiVersion: 1,
      hostHandlers: handlers, autoRestart: false, execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    });
    try { await handle.start(); }
    catch (error) { await handle.stop(); services.dispose(); throw error; }
    return {
      listSpy,
      history: (requestedIssueId: string, options?: unknown) => handle.call("getData", { key: "history", companyId: scopeCompanyId, params: { issueId: requestedIssueId, options } }) as Promise<PluginIssueExecutionDecisionsPage>,
      issue: () => handle.call("getData", { key: "issue", companyId: scopeCompanyId, params: { issueId } }),
      async close() { try { await handle.stop(); } finally { services.dispose(); } },
    };
  }

  it("reaches every retained decision in stable pages, with safe current labels and unchanged issue reads", async () => {
    const client = await rpc();
    try {
      expect(await client.issue()).toMatchObject({ executionPolicy: policy, executionState: state });
      const first = await client.history("hist-1");
      expect(first.items).toHaveLength(50);
      expect(first.principalLabels).toEqual({
        [`agent:${agentId}`]: { type: "agent", id: agentId, label: "Current reviewer" },
        [`agent:${missingAgentId}`]: { type: "agent", id: missingAgentId, label: null },
        [`agent:${foreignAgentId}`]: { type: "agent", id: foreignAgentId, label: null },
        [`user:${userId}`]: { type: "user", id: userId, label: `Name ${userId}` },
        [`user:${inactiveUserId}`]: { type: "user", id: inactiveUserId, label: null },
        [`user:${foreignUserId}`]: { type: "user", id: foreignUserId, label: null },
      });
      expect(first.items[0]).toEqual({
        id: ids[0], companyId, issueId, stageId: removedStageId, stageType: "approval", outcome: "changes_requested",
        actorAgentId: agentId, actorUserId: null, body: "Round 0", createdByRunId: null,
        createdAt: timestamp.toISOString(), updatedAt: timestamp.toISOString(),
      });
      const second = await client.history(issueId, { cursor: first.nextCursor });
      expect(second.items).toHaveLength(50);
      expect(second.principalLabels[`user:${foreignUserId}`]).toBeUndefined();
      const third = await client.history(issueId, { cursor: second.nextCursor, limit: 100 });
      expect(third.items).toHaveLength(25);
      expect(third.nextCursor).toBeNull();
      expect([...first.items, ...second.items, ...third.items].map(row => row.id)).toEqual(ids);
      expect(await client.history(issueId)).toEqual(first);
      expect((await client.history(issueId, { limit: 100 })).items).toHaveLength(100);
    } finally { await client.close(); }
  });

  it("returns the same empty result for zero, unknown, and mismatched company/issue reads", async () => {
    const client = await rpc();
    try {
      const empty = { items: [], nextCursor: null, principalLabels: {} };
      expect(await client.history(emptyIssueId)).toEqual(empty);
      expect(await client.history(randomUUID())).toEqual(empty);
      expect(await client.history("MISSING-99")).toEqual(empty);
      expect(await client.history(otherIssueId)).toEqual(empty);
    } finally { await client.close(); }
    const foreign = await rpc(otherCompanyId);
    try { expect(await foreign.history(issueId)).toEqual({ items: [], nextCursor: null, principalLabels: {} }); }
    finally { await foreign.close(); }
  });

  it("rejects malformed options and company/issue-bound foreign cursors", async () => {
    const client = await rpc();
    try {
      for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: "50" }, { limit: null }, { cursor: "" }, { cursor: "not-json" }, { cursor: 5 }]) {
        await expect(client.history(issueId, options)).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.VALIDATION_ERROR, message: expect.stringMatching(/Invalid execution decision history/),
        });
      }
      const page = await client.history(issueId, { limit: 1 });
      await expect(client.history(emptyIssueId, { cursor: page.nextCursor })).rejects.toThrow("Invalid execution decision history cursor");
      const foreign = await rpc(otherCompanyId);
      try { await expect(foreign.history(otherIssueId, { cursor: page.nextCursor })).rejects.toThrow("Invalid execution decision history cursor"); }
      finally { await foreign.close(); }
    } finally { await client.close(); }
  });

  it("denies absent capability before any service access", async () => {
    const client = await rpc(companyId, ["issues.read"]);
    try {
      await expect(client.history(issueId)).rejects.toThrow(/issue.execution.read/);
      expect(client.listSpy).not.toHaveBeenCalled();
      expect(await client.issue()).toMatchObject({ executionPolicy: policy, executionState: state });
    } finally { await client.close(); }
  });

  it("keeps microsecond timestamps stable across page boundaries", async () => {
    const preciseIssueId = randomUUID();
    await db.insert(issues).values({ id: preciseIssueId, companyId, title: "Submillisecond records" });
    const preciseIds = [randomUUID(), randomUUID(), randomUUID()].sort().reverse();
    for (const [index, id] of preciseIds.entries()) {
      await db.insert(issueExecutionDecisions).values({ id, companyId, issueId: preciseIssueId, stageId, stageType: "review", outcome: "approved", body: "Precise" });
      await db.update(issueExecutionDecisions).set({ createdAt: sql`${`2026-10-21T08:00:00.00000${index + 1}Z`}::timestamptz` }).where(eq(issueExecutionDecisions.id, id));
    }
    const client = await rpc();
    try {
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.history(preciseIssueId, { limit: 1, cursor });
        found.push(...page.items.map(row => row.id));
        cursor = page.nextCursor ?? undefined;
        expect(found.length).toBeLessThanOrEqual(3);
      } while (cursor);
      expect(found).toEqual(preciseIds);
    } finally { await client.close(); }
  });
});
