import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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
import { subscribeCompanyLiveEvents } from "../services/live-events.js";

// Fork test (SX-2509): a run that closes, cancels or hands off its own task is
// stopped as before, then recorded `succeeded` with a `selfHandoff` marker. The
// same change by another actor still cancels the run exactly as today. The
// reassignment case and the new owner's wake are covered in
// execution-reassignment-stop-hold.test.ts and execution-stage-handoff-wake.test.ts.

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
    summary: "Self hand-off test run.",
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
import { agentRunWritesRevoked } from "../agent-run-cancellation.ts";
import { isConfirmedReassignmentStop } from "../services/run-cancellation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self hand-off tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describe("self hand-off run shape (SX-2509)", () => {
  const selfHandoff = {
    status: "succeeded",
    errorCode: null,
    resultJson: {
      reassignmentStopConfirmed: true,
      selfHandoff: true,
      selfHandoffStop: { kind: "reassignment", errorCode: "issue_reassigned", error: null, recordedAt: "2026-10-25T00:00:00.000Z" },
    },
  };

  it("counts as a confirmed reassignment stop", () => {
    expect(isConfirmedReassignmentStop(selfHandoff)).toBe(true);
    expect(isConfirmedReassignmentStop({
      status: "cancelled", errorCode: "issue_reassigned", resultJson: { reassignmentStopConfirmed: true },
    })).toBe(true);
    // A self close is not a reassignment stop, and a plain success never is.
    expect(isConfirmedReassignmentStop({ ...selfHandoff, resultJson: {
      ...selfHandoff.resultJson, selfHandoffStop: { ...selfHandoff.resultJson.selfHandoffStop, errorCode: "cancelled" },
    } })).toBe(false);
    expect(isConfirmedReassignmentStop({ status: "succeeded", errorCode: null, resultJson: { reassignmentStopConfirmed: true } })).toBe(false);
  });

  it("keeps the run's write authority revoked", () => {
    expect(agentRunWritesRevoked(selfHandoff)).toBe(true);
    expect(agentRunWritesRevoked({ status: "succeeded", resultJson: {} })).toBe(false);
  });
});

describeEmbeddedPostgres("a run that changes its own task ends succeeded (SX-2509)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-handoff-outcome-");
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

  async function insertCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Author",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRunningRun() {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Closed by its own run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: runId,
      executionRunId: runId,
    });
    return { companyId, agentId, issueId, runId };
  }

  function collectRunStatusEvents(companyId: string, runId: string) {
    const payloads: Array<Record<string, unknown>> = [];
    const stop = subscribeCompanyLiveEvents(companyId, (event) => {
      if (event.type === "heartbeat.run.status" && event.payload.runId === runId) payloads.push(event.payload);
    });
    return { payloads, stop };
  }

  describe.each([
    ["sets its task to cancelled", "cancelled_status"],
    ["closes its task through the goal stop", "terminalization"],
  ] as const)("a run that %s", (_name, kind) => {
    // The exact stops the issue PATCH route makes (routes/issues.ts).
    // Only the actor's own run gets a stop id and the selfHandoffRequested mark.
    async function stopAsRoute(runId: string, issueMutationStopId: string | null) {
      const own = issueMutationStopId ? { issueMutationStopId, selfHandoffRequested: true } : {};
      if (kind === "terminalization") {
        return heartbeat.cancelRun(runId, "Cancelled before issue terminalization", {
          errorCode: "issue_terminalized",
          resultJson: { terminalizationStopConfirmed: true, ...own },
          eventMessage: "run cancelled before issue terminalization",
        });
      }
      return issueMutationStopId
        ? heartbeat.cancelRun(runId, undefined, { resultJson: own })
        : heartbeat.cancelRun(runId);
    }

    it("itself: is recorded succeeded after the change commits", async () => {
      const ids = await seedRunningRun();
      const events = collectRunStatusEvents(ids.companyId, ids.runId);
      const issueMutationStopId = randomUUID();
      expect(await stopAsRoute(ids.runId, issueMutationStopId)).toMatchObject({ status: "cancelled" });
      await db.update(issues).set({ status: "cancelled", checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, ids.issueId));

      const recorded = await heartbeat.recordSelfHandoffOutcome({ runId: ids.runId, issueMutationStopId, kind });

      expect(recorded).toMatchObject({ status: "succeeded", errorCode: null, error: null });
      const run = await heartbeat.getRun(ids.runId);
      expect(run).toMatchObject({
        status: "succeeded",
        errorCode: null,
        resultJson: expect.objectContaining({
          selfHandoff: true,
          stopReason: "completed",
          issueMutationStopId,
          selfHandoffStop: expect.objectContaining({
            kind,
            errorCode: kind === "terminalization" ? "issue_terminalized" : "cancelled",
          }),
        }),
      });
      expect(run?.resultJson).not.toHaveProperty("selfHandoffPending");
      // The live sequence: the transient stop is marked so it announces no
      // cancellation (ui buildRunStatusToast), then the real result.
      events.stop();
      expect(events.payloads.map(p => [p.status, p.selfHandoffPending ?? false]))
        .toEqual([["cancelled", true], ["succeeded", false]]);
    });

    it("itself, when the change does not complete: the stop is announced as an ordinary cancellation", async () => {
      const ids = await seedRunningRun();
      const events = collectRunStatusEvents(ids.companyId, ids.runId);
      expect(await stopAsRoute(ids.runId, randomUUID())).toMatchObject({ status: "cancelled" });

      // The request ended before the outcome was recorded (route close fallback).
      await heartbeat.announceSelfHandoffStopCancelled(ids.runId);

      events.stop();
      expect(await heartbeat.getRun(ids.runId)).toMatchObject({ status: "cancelled" });
      expect(events.payloads.map(p => [p.status, p.selfHandoffPending ?? false]))
        .toEqual([["cancelled", true], ["cancelled", false]]);
    });

    it("by another actor: stays cancelled with today's code", async () => {
      const ids = await seedRunningRun();
      const events = collectRunStatusEvents(ids.companyId, ids.runId);
      // A board user or another agent: the route passes no stop id of its own.
      expect(await stopAsRoute(ids.runId, null)).toMatchObject({ status: "cancelled" });
      await db.update(issues).set({ status: "cancelled", checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, ids.issueId));

      // Another request's stop id never relabels this stop.
      expect(await heartbeat.recordSelfHandoffOutcome({
        runId: ids.runId, issueMutationStopId: randomUUID(), kind,
      })).toBeNull();
      expect(await heartbeat.getRun(ids.runId)).toMatchObject(kind === "terminalization"
        ? { status: "cancelled", errorCode: "issue_terminalized", error: "Cancelled before issue terminalization" }
        : { status: "cancelled", errorCode: "cancelled", error: "Cancelled by control plane" });
      // The cancellation is announced exactly as today.
      events.stop();
      expect(events.payloads.map(p => [p.status, p.selfHandoffPending ?? false]))
        .toEqual([["cancelled", false]]);
    });
  });

  describe("a leftover queued wake after the task was closed (continuation_task_ownership_changed)", () => {
    type Actor = "self" | "board";
    function actorFields(by: Actor, agentId: string) {
      return by === "self"
        ? { actorType: "agent" as const, actorId: agentId, agentId }
        : { actorType: "user" as const, actorId: "board-user", agentId: null };
    }

    async function seedQueuedRun() {
      const { companyId, agentId } = await insertCompanyAndAgent();
      const issueId = randomUUID();
      const runId = randomUUID();
      const wakeupRequestId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Closed while a wake waited",
        // Open when the run is claimed; the change lands before dispatch (the
        // SX-2460 shape).
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_children_completed",
        payload: { issueId },
        status: "queued",
        runId,
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId,
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_children_completed" },
      });
      return { companyId, agentId, issueId, runId, wakeupRequestId };
    }

    async function audit(ids: { companyId: string; agentId: string; issueId: string }, by: Actor,
      changes: Record<string, { from: unknown; to: unknown }>) {
      await db.insert(activityLog).values({
        companyId: ids.companyId,
        ...actorFields(by, ids.agentId),
        action: "issue.updated",
        entityType: "issue",
        entityId: ids.issueId,
        details: { changes },
      });
    }

    // The task change commits after the run was claimed and before dispatch,
    // like the PATCH route: the row first, its `issue.updated` audit after.
    // `auditPublished: false` dispatches inside that gap. The real dispatch
    // check (buildExecutionContinuation) then finds the task stale.
    async function dispatchAfterChange(ids: Awaited<ReturnType<typeof seedQueuedRun>>, change: {
      by: Actor; set: { status?: string; assigneeAgentId?: string | null }; auditPublished: boolean;
    }) {
      const build = vi.spyOn(executionContinuation, "buildExecutionContinuation")
        .mockImplementationOnce(async (input) => {
          await db.update(issues).set(change.set).where(eq(issues.id, ids.issueId));
          if (change.auditPublished) {
            await audit(ids, change.by, Object.fromEntries(Object.entries(change.set).map(([field, to]) =>
              [field, { from: field === "status" ? "in_progress" : ids.agentId, to }])));
          }
          return realBuildExecutionContinuation(input);
        });
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(build).toHaveBeenCalled();
      expect(mockAdapterExecute.mock.calls.some(
        ([input]) => (input as { runId?: string } | undefined)?.runId === ids.runId,
      )).toBe(false);
      return heartbeat.getRun(ids.runId);
    }

    function expectSucceededSelfHandoff(run: Awaited<ReturnType<typeof heartbeat.getRun>>) {
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

    async function expectCancelledAsToday(ids: { runId: string; wakeupRequestId: string }) {
      const run = await heartbeat.getRun(ids.runId);
      expect(run).toMatchObject({ status: "cancelled", errorCode: "continuation_task_ownership_changed" });
      expect(run?.resultJson).not.toHaveProperty("selfHandoff");
      expect(run?.resultJson).not.toHaveProperty("selfHandoffRequested");
      const [wakeup] = await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, ids.wakeupRequestId));
      expect(wakeup.status).toBe("cancelled");
    }

    it("closed by the same agent: the leftover run ends succeeded, not cancelled", async () => {
      const ids = await seedQueuedRun();
      const events = collectRunStatusEvents(ids.companyId, ids.runId);
      const run = await dispatchAfterChange(ids, { by: "self", set: { status: "done" }, auditPublished: true });
      expectSucceededSelfHandoff(run);
      const [agent] = await db.select().from(agents).where(eq(agents.id, ids.agentId));
      expect(agent.status).not.toBe("error");
      events.stop();
      expect(events.payloads.filter(p => p.status === "cancelled").every(p => p.selfHandoffPending === true)).toBe(true);
      expect(events.payloads.at(-1)).toMatchObject({ status: "succeeded" });
    });

    it("handed to another agent by the same agent: the leftover run ends succeeded", async () => {
      const ids = await seedQueuedRun();
      const { agentId: otherAgentId } = await insertCompanyAndAgent();
      await db.update(agents).set({ companyId: ids.companyId }).where(eq(agents.id, otherAgentId));
      const run = await dispatchAfterChange(ids, { by: "self", set: { assigneeAgentId: otherAgentId }, auditPublished: true });
      expectSucceededSelfHandoff(run);
    });

    it("closed by a board user: the run is cancelled with today's code", async () => {
      const ids = await seedQueuedRun();
      await dispatchAfterChange(ids, { by: "board", set: { status: "done" }, auditPublished: true });
      await expectCancelledAsToday(ids);
    });

    it("closed by a board user whose audit is not written yet, after the agent's own earlier change: cancelled with today's code", async () => {
      const ids = await seedQueuedRun();
      // The agent's earlier change is the latest audit entry when dispatch runs.
      await audit(ids, "self", { status: { from: "todo", to: "in_progress" } });
      await dispatchAfterChange(ids, { by: "board", set: { status: "done" }, auditPublished: false });
      await expectCancelledAsToday(ids);
    });

    it("closed by the same agent whose audit is not written yet: cancelled with today's code (no guess)", async () => {
      const ids = await seedQueuedRun();
      await audit(ids, "board", { status: { from: "todo", to: "in_progress" } });
      await dispatchAfterChange(ids, { by: "self", set: { status: "done" }, auditPublished: false });
      await expectCancelledAsToday(ids);
    });

    it("attribution needs every stale field changed by the agent to its current value", async () => {
      const ids = await seedQueuedRun();
      const attributed = () => executionContinuation.taskOwnershipLastChangedByAgent(db, ids);
      // Not stale: nothing to attribute.
      expect(await attributed()).toBe(false);
      // The agent closes the task: attributed.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, ids.issueId));
      await audit(ids, "self", { status: { from: "in_progress", to: "done" } });
      expect(await attributed()).toBe(true);
      // A board user then reassigns it; the audit is not written yet.
      await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "board-user" }).where(eq(issues.id, ids.issueId));
      expect(await attributed()).toBe(false);
      // Once written, the board's change is the latest for the owner field.
      await audit(ids, "board", { assigneeAgentId: { from: ids.agentId, to: null } });
      expect(await attributed()).toBe(false);
    });
  });
});
