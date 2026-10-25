import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork test (SX-2550): a leftover queued wake whose task its own agent closed
// or handed off ends `succeeded`; the same change by a board user still cancels
// with continuation_task_ownership_changed. The task change goes through the
// real issue service; its `issue.updated` audit is written afterwards (like the
// PATCH route) or not yet, and dispatch runs the real continuation builder.

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskRun: vi.fn() };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stale continuation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import * as executionContinuation from "../services/execution-continuation.js";
const realBuildExecutionContinuation = executionContinuation.buildExecutionContinuation;
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import {
  staleTaskChangedByAgent,
  TASK_VERSION_CHANGED_BY_AGENT_ACTION,
} from "../services/task-version-attribution.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stale continuation tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Actor = "self" | "board";
type Change = { status?: "done" | "cancelled"; assigneeAgentId?: string | null };

describeEmbeddedPostgres("a leftover queued wake after the task changed (SX-2550)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stale-continuation-self-change-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    mockAdapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(sql`truncate table companies, environments cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(companyId: string, name: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await insertAgent(companyId, "Author");
    const otherAgentId = await insertAgent(companyId, "Next owner");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Changed while a wake waited",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    // The agent's own earlier change and checkout: its entries are the latest
    // in the audit when a later change by someone else has no audit yet.
    await issueService(db).update(issueId, { status: "in_progress", actorAgentId: agentId });
    await audit({ companyId, agentId, issueId }, "self", "issue.checked_out", {});
    return { companyId, agentId, otherAgentId, issueId };
  }

  async function queueWake(ids: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId: ids.issueId },
      status: "queued",
      runId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: ids.companyId,
      agentId: ids.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId, wakeReason: "issue_children_completed" },
    });
    return { runId, wakeupRequestId };
  }

  async function audit(ids: { companyId: string; agentId: string; issueId: string }, by: Actor,
    action: string, details: Record<string, unknown>) {
    await db.insert(activityLog).values({
      companyId: ids.companyId,
      ...(by === "self"
        ? { actorType: "agent", actorId: ids.agentId, agentId: ids.agentId }
        : { actorType: "user", actorId: "board-user", agentId: null }),
      action,
      entityType: "issue",
      entityId: ids.issueId,
      details,
    });
  }

  // The change the PATCH route makes: the issue service commits the task row,
  // then the route writes `issue.updated`.
  async function changeTask(ids: Awaited<ReturnType<typeof seed>>, by: Actor, set: Change, auditPublished: boolean) {
    await issueService(db).update(ids.issueId, {
      ...set,
      ...(by === "self" ? { actorAgentId: ids.agentId } : { actorUserId: "board-user" }),
    });
    if (auditPublished) {
      await audit(ids, by, "issue.updated", {
        changes: Object.fromEntries(Object.entries(set).map(([field, to]) =>
          [field, { from: field === "status" ? "in_progress" : ids.agentId, to }])),
      });
    }
  }

  // The change lands after the run was claimed and before dispatch (the SX-2460
  // shape); the real dispatch check then finds the task stale.
  async function dispatchAfterChange(ids: Awaited<ReturnType<typeof seed>>, by: Actor, set: Change, auditPublished: boolean) {
    const wake = await queueWake(ids);
    const build = vi.spyOn(executionContinuation, "buildExecutionContinuation")
      .mockImplementationOnce(async (input) => {
        await changeTask(ids, by, set, auditPublished);
        return realBuildExecutionContinuation(input);
      });
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(build).toHaveBeenCalled();
    expect(mockAdapterExecute.mock.calls.some(
      ([input]) => (input as { runId?: string } | undefined)?.runId === wake.runId,
    )).toBe(false);
    return { ...wake, run: await heartbeat.getRun(wake.runId) };
  }

  function expectSucceeded(run: Awaited<ReturnType<typeof heartbeat.getRun>>) {
    expect(run).toMatchObject({
      status: "succeeded",
      errorCode: null,
      resultJson: expect.objectContaining({
        selfHandoff: true,
        selfHandoffStop: expect.objectContaining({
          kind: "stale_continuation",
          errorCode: "continuation_task_ownership_changed",
        }),
      }),
    });
  }

  async function expectCancelledAsToday(wake: Awaited<ReturnType<typeof dispatchAfterChange>>) {
    expect(wake.run).toMatchObject({ status: "cancelled", errorCode: "continuation_task_ownership_changed" });
    expect(wake.run?.resultJson).not.toHaveProperty("selfHandoff");
    const [wakeup] = await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wake.wakeupRequestId));
    expect(wakeup.status).toBe("cancelled");
  }

  describe.each([
    ["audit not written yet", false],
    ["audit written", true],
  ] as const)("%s", (_name, auditPublished) => {
    it("closed by the same agent: the leftover run ends succeeded", async () => {
      const ids = await seed();
      const wake = await dispatchAfterChange(ids, "self", { status: "done" }, auditPublished);
      expectSucceeded(wake.run);
      const [agent] = await db.select().from(agents).where(eq(agents.id, ids.agentId));
      expect(agent.status).not.toBe("error");
    });

    it("handed to another agent by the same agent: the leftover run ends succeeded", async () => {
      const ids = await seed();
      const wake = await dispatchAfterChange(ids, "self", { assigneeAgentId: ids.otherAgentId }, auditPublished);
      expectSucceeded(wake.run);
    });

    it("closed by a board user after the agent's own checkout: cancelled with today's code", async () => {
      const ids = await seed();
      const wake = await dispatchAfterChange(ids, "board", { status: "done" }, auditPublished);
      await expectCancelledAsToday(wake);
    });

    it("handed to another agent by a board user: cancelled with today's code", async () => {
      const ids = await seed();
      const wake = await dispatchAfterChange(ids, "board", { assigneeAgentId: ids.otherAgentId }, auditPublished);
      await expectCancelledAsToday(wake);
    });
  });

  describe("attribution read (staleTaskChangedByAgent)", () => {
    const attributed = (ids: Awaited<ReturnType<typeof seed>>) =>
      staleTaskChangedByAgent(db, { companyId: ids.companyId, issueId: ids.issueId, agentId: ids.agentId });

    it("is written in the change's transaction for agents only", async () => {
      const ids = await seed();
      await changeTask(ids, "self", { status: "done" }, false);
      const entries = await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, ids.issueId), eq(activityLog.action, TASK_VERSION_CHANGED_BY_AGENT_ACTION)));
      const [issue] = await db.select().from(issues).where(eq(issues.id, ids.issueId));
      // One for the seed's own move to in_progress, one for the close.
      expect(entries.map(e => [e.actorId, (e.details as Record<string, unknown>).statusVersion])).toEqual(
        expect.arrayContaining([[ids.agentId, issue.statusVersion]]));
      expect(entries).toHaveLength(2);
      await changeTask(ids, "board", { status: "cancelled" }, false);
      expect(await db.select().from(activityLog).where(and(
        eq(activityLog.entityId, ids.issueId), eq(activityLog.action, TASK_VERSION_CHANGED_BY_AGENT_ACTION)))).toHaveLength(2);
    });

    it("follows the change that made the current version", async () => {
      const ids = await seed();
      // The agent closes the task: attributed.
      await changeTask(ids, "self", { status: "done" }, false);
      expect(await attributed(ids)).toBe(true);
      // A board user reopens and closes it again; no audit yet.
      await changeTask(ids, "board", { status: "cancelled" }, false);
      expect(await attributed(ids)).toBe(false);
      await changeTask(ids, "board", { status: "done" }, false);
      expect(await attributed(ids)).toBe(false);
      // Another agent's change is not this agent's.
      expect(await staleTaskChangedByAgent(db, { companyId: ids.companyId, issueId: ids.issueId, agentId: ids.otherAgentId }))
        .toBe(false);
    });

    it("is false when a later change kept the version but moved the owner", async () => {
      const ids = await seed();
      await changeTask(ids, "self", { assigneeAgentId: ids.otherAgentId }, false);
      expect(await attributed(ids)).toBe(true);
      // A write outside the issue service that changes the owner without
      // raising statusVersion (status unchanged).
      await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board-user" }).where(eq(issues.id, ids.issueId));
      expect(await attributed(ids)).toBe(false);
    });
  });
});
