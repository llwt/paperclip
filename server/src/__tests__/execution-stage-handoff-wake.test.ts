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
  budgetPolicies,
  costEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
  issueTreeHolds,
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
// Fork test (SX-2418): the same for the new owner's assignment wake after a
// reassignment stopped the former owner's run.

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

  it("keeps the saved hand-off when starting its run fails, and a retry starts exactly one run", async () => {
    const ids = await seedDecision({ transition: "review_to_approval", leaseHeld: true });
    const reason = ids.stageWakeup.wakeup.reason!;
    expect(await heartbeat.wakeup(ids.nextAgentId, ids.stageWakeup.wakeup)).toBeNull();
    const [saved] = await wakesFor(ids.nextAgentId, ids.issueId, reason);

    // Fail the successor run's insert: the same point as a crash after the
    // saved row is claimed and before the successor run is stored.
    await db.execute(sql.raw(`
      create function fail_stage_handoff_run() returns trigger language plpgsql as $$
      begin raise exception 'injected failure before the successor run is saved'; end $$;
      create trigger fail_stage_handoff_run before insert on heartbeat_runs for each row
        when (new.agent_id = '${ids.nextAgentId}') execute function fail_stage_handoff_run();
    `));
    try {
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      expect(await runsFor(ids.nextAgentId, reason)).toHaveLength(0);
      // The failed attempt rolled back: the saved row is still there to retry,
      // and no other receipt for it was stored.
      expect(await wakesFor(ids.nextAgentId, ids.issueId, reason)).toEqual([
        expect.objectContaining({ id: saved!.id, status: "deferred_issue_execution", runId: null }),
      ]);
    } finally {
      await db.execute(sql.raw(`
        drop trigger fail_stage_handoff_run on heartbeat_runs;
        drop function fail_stage_handoff_run();
      `));
    }

    // The queued-run resume retries it (after a restart this is the only path).
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.id, saved!.id));
    await heartbeat.resumeQueuedRuns();
    const runs = await runsFor(ids.nextAgentId, reason);
    expect(runs).toHaveLength(1);
    const wakes = await wakesFor(ids.nextAgentId, ids.issueId, reason);
    expect(wakes.find((wake) => wake.id === saved!.id)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });

    // A retry after the admission committed finds nothing left to start.
    await heartbeat.resumeQueuedRuns();
    expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 0 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runsFor(ids.nextAgentId, reason)).toHaveLength(1);
  });

  it("concurrent retries of one saved hand-off start exactly one run", async () => {
    const ids = await seedDecision({ transition: "approval_to_changes_requested", leaseHeld: true });
    const reason = ids.stageWakeup.wakeup.reason!;
    expect(await heartbeat.wakeup(ids.nextAgentId, ids.stageWakeup.wakeup)).toBeNull();

    // Lease gone without the release hook, and the row old enough for the
    // queued-run resume: every caller below sees the same saved row.
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, ids.leaseId));
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.agentId, ids.nextAgentId));
    await Promise.all([
      heartbeat.resumeQueuedRuns(),
      heartbeat.resumeQueuedRuns(),
      heartbeatService(db).resumeQueuedRuns(),
    ]);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await runsFor(ids.nextAgentId, reason);
    expect(runs).toHaveLength(1);
    const wakes = await wakesFor(ids.nextAgentId, ids.issueId, reason);
    expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
    expect(wakes.every((wake) => wake.runId === runs[0]!.id)).toBe(true);
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

  /**
   * Fork (SX-2418). The issue PATCH route stopped the former owner's run
   * (`issue_reassigned`, `reassignmentStopConfirmed`) and committed the new
   * owner, then queues the new owner's `issue_assigned` wake: the exact wake
   * the route builds. With `leaseHeld` the stopped run still holds its lease.
   * `stop: "operator"` is a genuine Stop before a plain reassignment, and
   * `newOwner: "self"` hands the task back to the stopped run's own agent.
   */
  async function seedReassignment(input: {
    leaseHeld: boolean;
    withComment?: boolean;
    stop?: "reassignment" | "operator" | "self_handoff";
    newOwner?: "other" | "self";
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const formerOwnerId = await insertAgent(companyId, "Former owner");
    const otherAgentId = await insertAgent(companyId, "New owner");
    const newOwnerId = input.newOwner === "self" ? formerOwnerId : otherAgentId;
    const issueId = randomUUID();
    const stoppedRunId = randomUUID();
    const finishedAt = new Date();
    const operatorStop = input.stop === "operator";
    // Fork (SX-2509): the former owner's own run made the change and was
    // recorded `succeeded` after the commit.
    const selfHandoff = input.stop === "self_handoff";
    await db.insert(heartbeatRuns).values({
      id: stoppedRunId,
      companyId,
      agentId: formerOwnerId,
      status: selfHandoff ? "succeeded" : "cancelled",
      invocationSource: "assignment",
      createdAt: new Date(finishedAt.getTime() - 60_000),
      startedAt: new Date(finishedAt.getTime() - 60_000),
      finishedAt,
      error: selfHandoff ? null : operatorStop ? "Cancelled by operator" : "Cancelled before issue reassignment",
      errorCode: selfHandoff ? null : operatorStop ? "cancelled" : "issue_reassigned",
      contextSnapshot: { issueId },
      resultJson: {
        ...(operatorStop ? {} : { reassignmentStopConfirmed: true }),
        ...(selfHandoff ? {
          selfHandoff: true,
          selfHandoffStop: {
            kind: "reassignment", errorCode: "issue_reassigned",
            error: "Cancelled before issue reassignment", recordedAt: finishedAt.toISOString(),
          },
        } : {}),
        executionCancellation: { state: "acknowledged", acknowledgedAt: finishedAt.toISOString() },
      },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      processPid: DEAD_ID,
      processGroupId: DEAD_ID,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: newOwnerId,
      responsibleUserId: "responsible-user",
    });
    const leaseId = randomUUID();
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId: await localEnvironmentId(),
      issueId,
      heartbeatRunId: stoppedRunId,
      status: input.leaseHeld ? "active" : "released",
      releasedAt: input.leaseHeld ? null : finishedAt,
      leasePolicy: "ephemeral",
      provider: "local",
      metadata: { driver: "local" },
    });
    const commentId = input.withComment ? randomUUID() : null;
    if (commentId) {
      await db.insert(issueComments).values({
        id: commentId, companyId, issueId, authorUserId: "board-user", body: "Please take this over.",
      });
    }
    return {
      companyId, issueId, stoppedRunId, formerOwnerId, newOwnerId, otherAgentId, leaseId,
      wakeup: assignmentWakeup(issueId, operatorStop ? null : stoppedRunId, commentId),
    };
  }

  // The wake the issue PATCH route queues for a new assignee (routes/issues.ts).
  function assignmentWakeup(issueId: string, interruptedRunId: string | null, commentId: string | null = null) {
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: {
        issueId,
        ...(commentId ? { commentId } : {}),
        mutation: "update",
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
      requestedByActorType: "user" as const,
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId,
        ...(commentId ? { taskId: issueId, commentId, wakeCommentId: commentId } : {}),
        source: "issue.update",
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
    };
  }

  async function issueRunsOf(agentId: string, issueId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      ));
  }

  async function ageWakes(issueId: string) {
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`);
  }

  async function releaseLeaseWithoutHook(leaseId: string) {
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date() })
      .where(eq(environmentLeases.id, leaseId));
  }

  describe("assignment hand-off after a confirmed reassignment stop (SX-2418)", () => {
    it.each([
      ["without a comment", false, "reassignment"],
      ["with a hand-off comment", true, "reassignment"],
      ["self hand-off recorded as succeeded (SX-2509), without a comment", false, "self_handoff"],
      ["self hand-off recorded as succeeded (SX-2509), with a hand-off comment", true, "self_handoff"],
    ] as const)("%s: the new owner's wake waits for the stopped run's cleanup, then starts exactly one run", async (_name, withComment, stop) => {
      const ids = await seedReassignment({ leaseHeld: true, withComment, stop });
      expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        runId: ids.stoppedRunId,
        cause: "execution_owner_active",
      });

      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      // Before the fix a wake without a comment was written as `skipped`.
      expect(await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned")).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution", runId: null }),
      ]);
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });

      const runs = await issueRunsOf(ids.newOwnerId, ids.issueId);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({
        issueId: ids.issueId,
        wakeReason: "issue_assigned",
        interruptedRunId: ids.stoppedRunId,
      });
      const wakes = await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned");
      expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
      expect(wakes.every((wake) => wake.runId === runs[0]!.id)).toBe(true);

      // Later release passes and sweeps start nothing more.
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 0 });
      await ageWakes(ids.issueId);
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await issueRunsOf(ids.newOwnerId, ids.issueId))
        .filter((run) => run.contextSnapshot?.wakeReason === "issue_assigned")).toHaveLength(1);
    });

    it("late cleanup: a sweep before the stopped run's cleanup starts nothing, the next sweep starts one run", async () => {
      const ids = await seedReassignment({ leaseHeld: true });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      await ageWakes(ids.issueId);

      await heartbeat.resumeQueuedRuns();
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);
      expect(await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned")).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution" }),
      ]);

      // The stopped run's cleanup finishes on another controller: no release
      // hook runs in this server.
      await releaseLeaseWithoutHook(ids.leaseId);
      await heartbeat.resumeQueuedRuns();
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(1);
    });

    it("server restart between the stop and the promotion: the sweep of a new server starts one run, with no earlier run of the new owner", async () => {
      const ids = await seedReassignment({ leaseHeld: true });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);

      await releaseLeaseWithoutHook(ids.leaseId);
      const restarted = heartbeatService(db);
      await restarted.resumeQueuedRuns();
      // Too recent: the release hook still owns it.
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);

      await ageWakes(ids.issueId);
      await restarted.resumeQueuedRuns();
      await restarted.resumeQueuedRuns();
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(1);
      await drainHeartbeatRunsToQuiescence(db, restarted);
    });

    it("concurrent sweeps start exactly one run", async () => {
      const ids = await seedReassignment({ leaseHeld: true });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      await releaseLeaseWithoutHook(ids.leaseId);
      await ageWakes(ids.issueId);

      await Promise.all([
        heartbeat.resumeQueuedRuns(),
        heartbeat.resumeQueuedRuns(),
        heartbeatService(db).resumeQueuedRuns(),
      ]);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const runs = (await issueRunsOf(ids.newOwnerId, ids.issueId))
        .filter((run) => run.contextSnapshot?.wakeReason === "issue_assigned");
      expect(runs).toHaveLength(1);
      const wakes = await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned");
      expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
      expect(wakes.every((wake) => wake.runId === runs[0]!.id)).toBe(true);
    });

    it("stale reassignment: the task moved on to a third agent before promotion, so only that agent runs", async () => {
      const ids = await seedReassignment({ leaseHeld: true });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();

      // Reassigned again while the first new owner had no run: nothing was
      // stopped, so its wake names no stopped run.
      const thirdId = await insertAgent(ids.companyId, "Third owner");
      await db.update(issues).set({ assigneeAgentId: thirdId }).where(eq(issues.id, ids.issueId));
      expect(await heartbeat.wakeup(thirdId, assignmentWakeup(ids.issueId, null))).toBeNull();

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);
      expect(await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned")).toEqual([
        expect.objectContaining({ status: "cancelled", runId: null }),
      ]);
      expect((await issueRunsOf(thirdId, ids.issueId))
        .filter((run) => run.contextSnapshot?.wakeReason === "issue_assigned")).toHaveLength(1);
    });

    it("an older saved assignment wake of the same owner is settled with the one run", async () => {
      const ids = await seedReassignment({ leaseHeld: true });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      expect(await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned")).toHaveLength(2);

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      await ageWakes(ids.issueId);
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const runs = (await issueRunsOf(ids.newOwnerId, ids.issueId))
        .filter((run) => run.contextSnapshot?.wakeReason === "issue_assigned");
      expect(runs).toHaveLength(1);
      expect((await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned"))
        .every((wake) => wake.runId === runs[0]!.id)).toBe(true);
    });

    it("self-reassignment: a task handed back to the stopped run's own agent starts no run on this path", async () => {
      const ids = await seedReassignment({ leaseHeld: true, newOwner: "self" });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      await ageWakes(ids.issueId);
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect((await issueRunsOf(ids.newOwnerId, ids.issueId)).map((run) => run.id)).toEqual([ids.stoppedRunId]);
    });

    it("a genuine operator Stop before a plain reassignment does not promote the saved wake", async () => {
      const ids = await seedReassignment({ leaseHeld: true, stop: "operator" });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();
      expect(await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned")).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution" }),
      ]);

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      await ageWakes(ids.issueId);
      await heartbeat.resumeQueuedRuns();
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);
      expect(await wakesFor(ids.newOwnerId, ids.issueId, "issue_assigned")).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution" }),
      ]);
    });

    it.each([
      ["a pause hold on the task", "pause"],
      ["an open dependency", "dependency"],
      ["a budget hard stop", "budget"],
      ["a workspace restore hold", "restore"],
      ["an active execution recovery hold", "recovery"],
    ] as const)("%s keeps the saved wake and starts no run", async (_name, gate) => {
      const ids = await seedReassignment({ leaseHeld: true });
      expect(await heartbeat.wakeup(ids.newOwnerId, ids.wakeup)).toBeNull();

      if (gate === "pause") {
        await db.insert(issueTreeHolds).values({
          companyId: ids.companyId, rootIssueId: ids.issueId, mode: "pause", status: "active",
          reason: "operator pause", releasePolicy: { strategy: "manual" },
        });
      } else if (gate === "dependency") {
        const blockerId = randomUUID();
        await db.insert(issues).values({
          id: blockerId, companyId: ids.companyId, title: "Open blocker", status: "todo", priority: "high",
        });
        await db.insert(issueRelations).values({
          companyId: ids.companyId, issueId: blockerId, relatedIssueId: ids.issueId, type: "blocks",
        });
      } else if (gate === "budget") {
        await db.insert(budgetPolicies).values({
          companyId: ids.companyId, scopeType: "agent", scopeId: ids.newOwnerId, metric: "billed_cents",
          windowKind: "calendar_month_utc", amount: 1, hardStopEnabled: true, isActive: true,
        });
        await db.insert(costEvents).values({
          companyId: ids.companyId, agentId: ids.newOwnerId, issueId: ids.issueId, provider: "test", biller: "test",
          billingType: "tokens", model: "test-model", costCents: 1, occurredAt: new Date(),
        });
      } else {
        if (gate === "restore") {
          // The stopped run itself recorded the unsafe workspace restore.
          await db.update(heartbeatRuns).set({
            resultJson: sql`${heartbeatRuns.resultJson} || '{"workspaceRestoreFailure":"restore_unsafe_archive"}'::jsonb`,
          }).where(eq(heartbeatRuns.id, ids.stoppedRunId));
        }
        await db.insert(issueRecoveryActions).values({
          companyId: ids.companyId, sourceIssueId: ids.issueId, kind: "active_run_watchdog", ownerType: "board",
          cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(),
          evidence: gate === "restore"
            ? { runId: ids.stoppedRunId, workspaceRestoreFailure: "restore_unsafe_archive" }
            : { runId: randomUUID() },
          nextAction: "Reconcile the stopped work.",
        });
      }

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      await ageWakes(ids.issueId);
      await heartbeat.resumeQueuedRuns();
      expect(await issueRunsOf(ids.newOwnerId, ids.issueId)).toHaveLength(0);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    });
  });
});
