import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork test (SX-1386): a stage decision stops the deciding run itself. Its
// environment lease is released only when its executor finishes cleanup, so
// the stage hand-off wake meets the execution owner blocker. The wake must
// wait for the lease and then start exactly one run for the next participant.

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

// A started wake runs a real heartbeat. Keep it away from a real agent CLI.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stage hand-off test run.",
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

import { heartbeatService } from "../services/heartbeat.ts";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.ts";
import { buildExecutionStageWakeup } from "../routes/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage hand-off wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// No process or process group can have this id, so a signal to it fails.
const DEAD_ID = 2_000_000_000;

describeEmbeddedPostgres("execution stage hand-off wake when the deciding run is stopped", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stage-handoff-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(sql`truncate table companies, environments cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function localEnvironmentId() {
    const [existing] = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.driver, "local"));
    if (existing) return existing.id;
    const id = randomUUID();
    await db.insert(environments).values({ id, name: "Local", driver: "local", status: "active", config: {} });
    return id;
  }

  /**
   * A task whose stage decision just happened: `previousState` is the state
   * the deciding run acted on, `nextState` the state after the decision. The
   * deciding run is stopped the way the issue routes stop it before a
   * reassignment. With `leaseHeld` its environment lease is still active.
   */
  async function seedDecision(input: {
    transition: "review_to_approval" | "approval_to_changes_requested" | "review_to_changes_requested";
    leaseHeld: boolean;
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const executorId = await insertAgent(companyId, "Executor");
    const reviewerId = await insertAgent(companyId, "Reviewer");
    const approverId = await insertAgent(companyId, "Approver");
    const issueId = randomUUID();
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
    const base = {
      reviewRequest: null,
      completedStageIds: [] as string[],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      returnAssignee: agent(executorId),
    };
    const reviewPending: IssueExecutionState = {
      ...base,
      status: "pending",
      currentStageId: reviewStageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: agent(reviewerId),
    };
    const approvalPending: IssueExecutionState = {
      ...base,
      status: "pending",
      currentStageId: approvalStageId,
      currentStageIndex: 1,
      currentStageType: "approval",
      currentParticipant: agent(approverId),
      completedStageIds: [reviewStageId],
      lastDecisionId: randomUUID(),
      lastDecisionOutcome: "approved",
    };
    const changesRequested = (from: IssueExecutionState): IssueExecutionState => ({
      ...from,
      status: "changes_requested",
      currentParticipant: null,
      lastDecisionId: randomUUID(),
      lastDecisionOutcome: "changes_requested",
    });
    const { previousState, nextState, deciderId, nextAgentId } =
      input.transition === "review_to_approval"
        ? { previousState: reviewPending, nextState: approvalPending, deciderId: reviewerId, nextAgentId: approverId }
        : input.transition === "approval_to_changes_requested"
          ? {
              previousState: approvalPending,
              nextState: changesRequested(approvalPending),
              deciderId: approverId,
              nextAgentId: executorId,
            }
          : {
              previousState: reviewPending,
              nextState: changesRequested(reviewPending),
              deciderId: reviewerId,
              nextAgentId: executorId,
            };

    const decidingRunId = randomUUID();
    const finishedAt = new Date();
    await db.insert(heartbeatRuns).values({
      id: decidingRunId,
      companyId,
      agentId: deciderId,
      status: "cancelled",
      invocationSource: "assignment",
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      error: "Cancelled before issue reassignment",
      errorCode: "issue_reassigned",
      contextSnapshot: { issueId },
      resultJson: {
        reassignmentStopConfirmed: true,
        executionCancellation: { state: "acknowledged", acknowledgedAt: finishedAt.toISOString() },
      },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      processPid: DEAD_ID,
      processGroupId: DEAD_ID,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stage hand-off",
      status: nextState.status === "pending" ? "in_review" : "in_progress",
      priority: "high",
      assigneeAgentId: nextAgentId,
      responsibleUserId: "responsible-user",
      executionState: nextState as unknown as Record<string, unknown>,
    });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId: await localEnvironmentId(),
      issueId,
      heartbeatRunId: decidingRunId,
      status: input.leaseHeld ? "active" : "released",
      releasedAt: input.leaseHeld ? null : finishedAt,
      leasePolicy: "ephemeral",
      provider: "local",
      metadata: { driver: "local" },
    });

    const stageWakeup = buildExecutionStageWakeup({
      issueId,
      previousState,
      nextState,
      interruptedRunId: decidingRunId,
      requestedByActorType: "agent",
      requestedByActorId: deciderId,
    });
    if (!stageWakeup) throw new Error("expected a stage wake for this transition");
    expect(stageWakeup.agentId).toBe(nextAgentId);
    return { companyId, issueId, decidingRunId, nextAgentId, stageWakeup, approverId, leaseId };
  }

  // Only the stage hand-off counts. A finished test run without a comment
  // gets its own `missing_issue_comment` follow-up, which is not a duplicate.
  async function wakesFor(agentId: string, issueId: string, reason: string) {
    return db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.reason, reason),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
  }

  async function runsFor(agentId: string, wakeReason: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = ${wakeReason}`,
      ));
  }

  it.each([
    ["review to approval", "review_to_approval", "execution_approval_requested"],
    ["approval to changes requested", "approval_to_changes_requested", "execution_changes_requested"],
    ["review to changes requested", "review_to_changes_requested", "execution_changes_requested"],
  ] as const)(
    "%s: the wake waits for the stopped run's lease, then starts exactly one run",
    async (_name, transition, wakeReason) => {
      const ids = await seedDecision({ transition, leaseHeld: true });
      expect(ids.stageWakeup.wakeup.reason).toBe(wakeReason);
      expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        runId: ids.decidingRunId,
        cause: "execution_owner_active",
      });

      // The route queues the wake while the deciding run still holds its lease.
      expect(await heartbeat.wakeup(ids.nextAgentId, ids.stageWakeup.wakeup)).toBeNull();
      // Before the fix this row was written as `skipped` and never resumed.
      expect(await wakesFor(ids.nextAgentId, ids.issueId, ids.stageWakeup.wakeup.reason!)).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution", reason: wakeReason, runId: null }),
      ]);
      expect(await runsFor(ids.nextAgentId, ids.stageWakeup.wakeup.reason!)).toHaveLength(0);

      // The deciding run's cleanup releases the lease (here: the fork's sweep
      // for a terminal run whose process is gone).
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });

      const runs = await runsFor(ids.nextAgentId, ids.stageWakeup.wakeup.reason!);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({
        issueId: ids.issueId,
        wakeReason,
        source: "issue.execution_stage",
      });
      const wakes = await wakesFor(ids.nextAgentId, ids.issueId, ids.stageWakeup.wakeup.reason!);
      expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
      expect(wakes.filter((wake) => wake.runId === runs[0]!.id)).toHaveLength(2);

      // A second release pass starts nothing more.
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 0 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await runsFor(ids.nextAgentId, ids.stageWakeup.wakeup.reason!)).toHaveLength(1);
    },
  );

  it.each([
    ["review to approval", "review_to_approval"],
    ["approval to changes requested", "approval_to_changes_requested"],
  ] as const)("%s: without a held lease the wake starts exactly one run at once", async (_name, transition) => {
    const ids = await seedDecision({ transition, leaseHeld: false });
    expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toBeNull();

    const run = await heartbeat.wakeup(ids.nextAgentId, ids.stageWakeup.wakeup);
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await runsFor(ids.nextAgentId, ids.stageWakeup.wakeup.reason!);
    expect(runs.map((row) => row.id)).toEqual([run!.id]);
    const wakes = await wakesFor(ids.nextAgentId, ids.issueId, ids.stageWakeup.wakeup.reason!);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ runId: run!.id });
  });

  it("the queued-run resume starts a saved hand-off whose lease was released without the hook", async () => {
    const ids = await seedDecision({ transition: "review_to_approval", leaseHeld: true });
    const reason = ids.stageWakeup.wakeup.reason!;
    expect(await heartbeat.wakeup(ids.nextAgentId, ids.stageWakeup.wakeup)).toBeNull();

    // A restart between the save and the release: the lease is gone, but no
    // release hook ran in this process.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, ids.leaseId));
    await heartbeat.resumeQueuedRuns();
    // Too recent: the release hook still owns it.
    expect(await runsFor(ids.nextAgentId, reason)).toHaveLength(0);

    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.agentId, ids.nextAgentId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await runsFor(ids.nextAgentId, reason)).toHaveLength(1);
    expect((await wakesFor(ids.nextAgentId, ids.issueId, reason))
      .filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
  });

  it("drops a saved hand-off when the task no longer waits on that participant", async () => {
    const ids = await seedDecision({ transition: "review_to_approval", leaseHeld: true });
    expect(await heartbeat.wakeup(ids.nextAgentId, ids.stageWakeup.wakeup)).toBeNull();

    // The approval stage moved on before the lease was released.
    await db.update(issues).set({
      executionState: sql`jsonb_set(${issues.executionState}, '{currentStageId}', to_jsonb(${randomUUID()}::text))`,
    }).where(eq(issues.id, ids.issueId));

    expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
    expect(await runsFor(ids.nextAgentId, ids.stageWakeup.wakeup.reason!)).toHaveLength(0);
    expect(await wakesFor(ids.nextAgentId, ids.issueId, ids.stageWakeup.wakeup.reason!)).toEqual([
      expect.objectContaining({ status: "cancelled", runId: null }),
    ]);
  });
});
