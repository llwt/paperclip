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
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import type { IssueExecutionState } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork test (SX-1735, the SX-1603 case): the issue PATCH route stops the
// author's own legacy run before it commits a hand-off to a stage participant.
// The cancel lands while the issue is still assigned to the author, so it must
// not leave the issue-wide `legacy_execution_requires_reconciliation` hold that
// would save every later wake (the stage hand-off and user comments) forever.
// Fork test (SX-2418): a plain reassignment from A to B while A runs gives B
// exactly one run after A's cleanup, also when the hand-off has no comment.

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
    summary: "Reassignment stop test run.",
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
import { getExecutionBlocker } from "../services/execution-blocker.ts";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.ts";
import { buildExecutionStageWakeup } from "../routes/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reassignment stop tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("wakes after the author's run is stopped for a stage hand-off", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-reassignment-stop-hold-");
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

  /**
   * The author's legacy run is running on an in_progress task assigned to the
   * author. The route's reassignment stop cancels it before the PATCH commits
   * the move to in_review with the reviewer as the stage participant.
   */
  async function stopAuthorRunThenHandOff() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const authorId = await insertAgent(companyId, "Author");
    const reviewerId = await insertAgent(companyId, "Reviewer");
    const issueId = randomUUID();
    const stageId = randomUUID();
    const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
    const base = {
      reviewRequest: null,
      completedStageIds: [] as string[],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      returnAssignee: agent(authorId),
    };
    const previousState = null;
    const reviewPending: IssueExecutionState = {
      ...base,
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: agent(reviewerId),
    };

    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: authorId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand-off after a stopped run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: authorId,
      responsibleUserId: "responsible-user",
      checkoutRunId: runId,
    });
    // The exact call the issue PATCH route makes (routes/issues.ts).
    const issueMutationStopId = randomUUID();
    const cancelled = await heartbeat.cancelRun(runId, "Cancelled before issue reassignment", {
      errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId },
      eventMessage: "run cancelled before issue reassignment",
      eventPayload: { issueId },
      suppressImmediateRecovery: true,
    });
    expect(cancelled?.status).toBe("cancelled");

    // The PATCH then commits the reassignment.
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: reviewerId,
      checkoutRunId: null,
      executionState: reviewPending as unknown as Record<string, unknown>,
    }).where(eq(issues.id, issueId));

    const stageWakeup = buildExecutionStageWakeup({
      issueId,
      previousState,
      nextState: reviewPending,
      interruptedRunId: runId,
      requestedByActorType: "agent",
      requestedByActorId: authorId,
    });
    if (!stageWakeup) throw new Error("expected a stage wake");
    expect(stageWakeup.agentId).toBe(reviewerId);
    return { companyId, issueId, authorId, reviewerId, runId, stageWakeup };
  }

  async function runsFor(agentId: string, wakeReason: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = ${wakeReason}`,
      ));
  }

  async function deferredWakes(agentId: string, issueId: string) {
    return db
      .select({ id: agentWakeupRequests.id, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
  }

  it("leaves no execution hold behind the reassignment stop", async () => {
    const ids = await stopAuthorRunThenHandOff();
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    expect(await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, ids.issueId))).toEqual([]);
  });

  it("starts a run for the stage participant after the move to in_review", async () => {
    const ids = await stopAuthorRunThenHandOff();
    const reason = ids.stageWakeup.wakeup.reason!;
    expect(reason).toBe("execution_review_requested");

    const run = await heartbeat.wakeup(ids.reviewerId, ids.stageWakeup.wakeup);
    expect(await deferredWakes(ids.reviewerId, ids.issueId)).toEqual([]);
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runsFor(ids.reviewerId, reason)).toHaveLength(1);
  });

  it("starts a run for the assignee when a user comments on the in_review task", async () => {
    const ids = await stopAuthorRunThenHandOff();

    const run = await heartbeat.wakeup(ids.reviewerId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: ids.issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: ids.issueId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });
    expect(await deferredWakes(ids.reviewerId, ids.issueId)).toEqual([]);
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runsFor(ids.reviewerId, "issue_commented")).toHaveLength(1);
  });

  describe("a hold persisted before the reassignment stop fix (SX-2419)", () => {
    type HoldOptions = { confirmedStop?: boolean; patchRun?: Partial<typeof heartbeatRuns.$inferInsert>; evidence?: Record<string, unknown> };

    /**
     * Agent A's legacy run is cancelled and the settle sweep turns the recovery
     * action it opened into a resolved no-replay hold, as the code before the
     * fix did for a reassignment stop. A confirmed stop is then recorded on the
     * run the way the issue route records it. The task is back with A.
     */
    async function seedPersistedHold(options: HoldOptions = {}) {
      const { confirmedStop = true } = options;
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      });
      const agentA = await insertAgent(companyId, "Source");
      const agentB = await insertAgent(companyId, "Other");
      const issueId = randomUUID();
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: agentA,
        status: "running",
        runtimeMode: "legacy",
        invocationSource: "assignment",
        startedAt: new Date(Date.now() - 60_000),
        contextSnapshot: { issueId },
        runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      });
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Task with a hold from an old reassignment stop",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentA,
        responsibleUserId: "responsible-user",
        checkoutRunId: runId,
      });
      const cancelled = await heartbeat.cancelRun(runId, "Execution stopped without a recorded cancellation request", {
        errorCode: "cancelled",
        eventMessage: "run cancelled",
        eventPayload: { issueId },
        suppressImmediateRecovery: true,
      });
      expect(cancelled?.status).toBe("cancelled");
      await settleUnrecoverableExecutions(db);
      const [action] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, issueId));
      expect(action).toMatchObject({
        status: "resolved",
        evidence: { runId, automaticRecovery: { replay: "blocked" } },
      });

      const [stopped] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const runPatch = {
        ...(confirmedStop ? {
          errorCode: "issue_reassigned",
          resultJson: {
            ...(stopped!.resultJson ?? {}),
            reassignmentStopConfirmed: true,
            issueMutationStopId: randomUUID(),
          },
        } : {}),
        ...options.patchRun,
      };
      if (Object.keys(runPatch).length) await db.update(heartbeatRuns).set(runPatch).where(eq(heartbeatRuns.id, runId));
      if (options.evidence) {
        await db.update(issueRecoveryActions).set({
          evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(options.evidence)}::jsonb`,
        }).where(eq(issueRecoveryActions.id, action!.id));
      }
      return { companyId, issueId, agentA, agentB, runId, actionId: action!.id };
    }

    const commentWake = (issueId: string) => ({
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user" as const,
      requestedByActorId: "board-user",
      contextSnapshot: { issueId, wakeReason: "issue_commented", source: "issue.comment" },
    });

    it("1. a task assigned back to the source agent has no blocker and a new wake starts one run", async () => {
      const ids = await seedPersistedHold();
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();

      expect(await heartbeat.wakeup(ids.agentA, commentWake(ids.issueId))).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await runsFor(ids.agentA, "issue_commented")).toHaveLength(1);
      expect(await deferredWakes(ids.agentA, ids.issueId)).toEqual([]);
    });

    it("2. the recovery action stays as audit history", async () => {
      const ids = await seedPersistedHold();
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();
      const [action] = await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, ids.issueId));
      expect(action).toMatchObject({
        id: ids.actionId,
        status: "resolved",
        evidence: { automaticRecovery: { replay: "blocked" } },
      });
    });

    it("3. a task assigned to a different agent has no blocker", async () => {
      const ids = await seedPersistedHold();
      await db.update(issues).set({ assigneeAgentId: ids.agentB, checkoutRunId: null })
        .where(eq(issues.id, ids.issueId));
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();

      expect(await heartbeat.wakeup(ids.agentB, commentWake(ids.issueId))).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await runsFor(ids.agentB, "issue_commented")).toHaveLength(1);
    });

    it("4. a live controller lease keeps the blocker", async () => {
      const ids = await seedPersistedHold({
        patchRun: { controllerLeaseExpiresAt: new Date(Date.now() + 60_000) },
      });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        recoveryActionId: ids.actionId,
        runId: ids.runId,
      });
      expect(await heartbeat.wakeup(ids.agentA, commentWake(ids.issueId))).toBeNull();
      expect(await runsFor(ids.agentA, "issue_commented")).toHaveLength(0);
    });

    it("5. an expired controller lease does not keep the blocker", async () => {
      const ids = await seedPersistedHold({
        patchRun: { controllerLeaseExpiresAt: new Date(Date.now() - 60_000) },
      });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    });

    it("6. a live process keeps the blocker", async () => {
      // The test process is alive, so its pid stands in for the stopped provider.
      const ids = await seedPersistedHold({ patchRun: { processPid: process.pid } });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).not.toBeNull();
      expect(await heartbeat.wakeup(ids.agentA, commentWake(ids.issueId))).toBeNull();
      expect(await runsFor(ids.agentA, "issue_commented")).toHaveLength(0);
    });

    it("7. an environment lease that is not released keeps the blocker", async () => {
      const ids = await seedPersistedHold();
      await db.insert(environmentLeases).values({
        companyId: ids.companyId, heartbeatRunId: ids.runId, issueId: ids.issueId,
        provider: "local", status: "active", leasePolicy: "ephemeral",
      });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).not.toBeNull();
      expect(await heartbeat.wakeup(ids.agentA, commentWake(ids.issueId))).toBeNull();
      expect(await runsFor(ids.agentA, "issue_commented")).toHaveLength(0);
    });

    it("8. an unsafe workspace restore on the action keeps the blocker for every assignee", async () => {
      const ids = await seedPersistedHold({ evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        recoveryActionId: ids.actionId,
        workspaceRepairRequired: true,
      });
      await db.update(issues).set({ assigneeAgentId: ids.agentB, checkoutRunId: null })
        .where(eq(issues.id, ids.issueId));
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        workspaceRepairRequired: true,
      });
    });

    it("9. a workspace restore failure recorded on the run keeps the blocker", async () => {
      const ids = await seedPersistedHold({
        patchRun: { resultJson: {
          reassignmentStopConfirmed: true,
          workspaceRestoreFailure: "restore_unsafe_archive",
        } },
      });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        recoveryActionId: ids.actionId,
      });
    });

    it("10. a run that has not ended keeps the blocker", async () => {
      const ids = await seedPersistedHold();
      await db.update(heartbeatRuns).set({ status: "running", finishedAt: null })
        .where(eq(heartbeatRuns.id, ids.runId));
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        recoveryActionId: ids.actionId,
      });
    });

    it("11. a hold from an unknown cancellation keeps the blocker", async () => {
      const ids = await seedPersistedHold({ confirmedStop: false });
      const [run] = await db.select({ resultJson: heartbeatRuns.resultJson, errorCode: heartbeatRuns.errorCode })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.runId));
      expect(run?.errorCode).not.toBe("issue_reassigned");
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        recoveryActionId: ids.actionId,
        runId: ids.runId,
      });
      expect(await heartbeat.wakeup(ids.agentA, commentWake(ids.issueId))).toBeNull();
      expect(await runsFor(ids.agentA, "issue_commented")).toHaveLength(0);
    });

    it("12. a stop that was requested but never confirmed keeps the blocker", async () => {
      const ids = await seedPersistedHold({
        patchRun: { errorCode: "issue_reassigned", resultJson: { reassignmentStopRequested: true } },
      });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        recoveryActionId: ids.actionId,
      });
    });
  });

  it.each([
    { by: "the board", actorType: "user" as const, actor: () => "board-user" },
    // A hands the task to B in its own last step (SX-2272).
    { by: "A itself", actorType: "agent" as const, actor: (formerOwnerId: string) => formerOwnerId },
  ])("reassigning A to B while A runs ($by): B gets exactly one run after A's cleanup, with no comment (SX-2418)", async ({ actorType, actor }) => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const formerOwnerId = await insertAgent(companyId, "A");
    const newOwnerId = await insertAgent(companyId, "B");
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: formerOwnerId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassigned while running",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: formerOwnerId,
      responsibleUserId: "responsible-user",
      checkoutRunId: runId,
    });
    // A's executor still has to release its environment lease.
    const [localEnvironment] = await db.select({ id: environments.id }).from(environments)
      .where(eq(environments.driver, "local")).then(async (rows) => rows.length ? rows
        : db.insert(environments).values({ name: "Local", driver: "local", status: "active", config: {} })
          .returning({ id: environments.id }));
    await db.insert(environmentLeases).values({
      companyId,
      environmentId: localEnvironment!.id,
      issueId,
      heartbeatRunId: runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      metadata: { driver: "local" },
    });

    // The exact stop the issue PATCH route makes before it commits B.
    const cancelled = await heartbeat.cancelRun(runId, "Cancelled before issue reassignment", {
      errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: randomUUID() },
      eventMessage: "run cancelled before issue reassignment",
      eventPayload: { issueId },
      suppressImmediateRecovery: true,
    });
    expect(cancelled?.status).toBe("cancelled");
    await db.update(issues).set({ assigneeAgentId: newOwnerId, checkoutRunId: null }).where(eq(issues.id, issueId));

    // The route's wake for the new assignee, with no comment.
    await heartbeat.wakeup(newOwnerId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId, mutation: "update", interruptedRunId: runId },
      requestedByActorType: actorType,
      requestedByActorId: actor(formerOwnerId),
      contextSnapshot: { issueId, source: "issue.update", interruptedRunId: runId },
    });

    expect(await deferredWakes(newOwnerId, issueId)).toHaveLength(1);
    expect(await runsFor(newOwnerId, "issue_assigned")).toHaveLength(0);

    // A's executor finishes its cleanup (the release at the end of its run),
    // then a late scheduler sweep.
    await heartbeat.releaseEnvironmentLeasesForRun({
      runId, companyId, agentId: formerOwnerId, status: "cancelled",
    });
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.agentId, newOwnerId));
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await runsFor(newOwnerId, "issue_assigned")).toHaveLength(1);
    expect(await deferredWakes(newOwnerId, issueId)).toEqual([]);
  });
});
