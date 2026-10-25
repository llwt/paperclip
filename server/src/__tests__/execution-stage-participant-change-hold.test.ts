import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
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

// Fork test (SX-2384, the SX-2278 case): a legacy run that ends `cancelled` with
// no recorded cancellation request leaves a resolved no-replay hold. When the
// task then moves to another agent (stage participant change), that hold must
// not save the new owner's stage and comment wakes. It still blocks the old
// owner, and a workspace-restore hold still blocks everyone.

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
    summary: "Participant change test run.",
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
    `Skipping embedded Postgres participant change hold tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("a resolved no-replay hold and a new task owner", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-participant-change-hold-");
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

  const agentRef = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });

  function reviewState(stageId: string, participantId: string, returnId: string): IssueExecutionState {
    return {
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      returnAssignee: agentRef(returnId),
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: agentRef(participantId),
    };
  }

  /**
   * Agent A reviews an in_review task. A's legacy run ends `cancelled` with no
   * recorded cancellation request, and the settle sweep resolves the recovery
   * action it opened into a no-replay hold. The task stays with A.
   */
  async function seedResolvedHoldOwnedByA(options: { restoreHold?: boolean } = {}) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentA = await insertAgent(companyId, "Reviewer A");
    const agentB = await insertAgent(companyId, "Reviewer B");
    const authorId = await insertAgent(companyId, "Author");
    const issueId = randomUUID();
    const stageId = randomUUID();
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
      title: "Review with a stopped reviewer run",
      status: "in_review",
      priority: "high",
      assigneeAgentId: agentA,
      responsibleUserId: "responsible-user",
      checkoutRunId: runId,
      executionState: reviewState(stageId, agentA, authorId) as unknown as Record<string, unknown>,
    });

    // A stop without a recorded request: not the reassignment stop, which is exempt.
    const cancelled = await heartbeat.cancelRun(runId, "Execution stopped without a recorded cancellation request", {
      errorCode: "cancelled",
      eventMessage: "run cancelled",
      eventPayload: { issueId },
      suppressImmediateRecovery: true,
    });
    expect(cancelled?.status).toBe("cancelled");
    await settleUnrecoverableExecutions(db);

    if (options.restoreHold) {
      await db.update(issueRecoveryActions).set({
        evidence: sql`${issueRecoveryActions.evidence} || '{"workspaceRestoreFailure":"restore_unsafe_archive"}'::jsonb`,
      }).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    }

    return { companyId, issueId, stageId, agentA, agentB, authorId, runId };
  }

  type Seed = Awaited<ReturnType<typeof seedResolvedHoldOwnedByA>>;

  /** The PATCH commits the new stage participant and assignee. */
  async function moveTaskTo(ids: Seed, toAgentId: string) {
    const next = reviewState(ids.stageId, toAgentId, ids.authorId);
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: toAgentId,
      checkoutRunId: null,
      executionState: next as unknown as Record<string, unknown>,
    }).where(eq(issues.id, ids.issueId));
    const stageWakeup = buildExecutionStageWakeup({
      issueId: ids.issueId,
      previousState: reviewState(ids.stageId, toAgentId === ids.agentB ? ids.agentA : ids.agentB, ids.authorId),
      nextState: next,
      interruptedRunId: ids.runId,
      requestedByActorType: "agent",
      requestedByActorId: ids.authorId,
    });
    if (!stageWakeup) throw new Error("expected a stage wake");
    expect(stageWakeup.agentId).toBe(toAgentId);
    return stageWakeup;
  }

  function commentWake(ids: Seed, actor: "user" | "agent") {
    return {
      source: "automation" as const,
      triggerDetail: "system" as const,
      reason: "issue_commented",
      payload: { issueId: ids.issueId, commentId: randomUUID() },
      requestedByActorType: actor,
      requestedByActorId: actor === "user" ? "board-user" : ids.authorId,
      contextSnapshot: {
        issueId: ids.issueId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    };
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

  it("1. an unexpected cancel of the reviewer's legacy run resolves into a no-replay hold", async () => {
    const ids = await seedResolvedHoldOwnedByA();
    const [action] = await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, ids.issueId));
    expect(action).toMatchObject({
      status: "resolved",
      cause: "legacy_execution_requires_reconciliation",
      returnOwnerAgentId: ids.agentA,
      evidence: { runId: ids.runId, automaticRecovery: { replay: "blocked" } },
    });
    const [issue] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, ids.issueId));
    expect(issue?.status).toBe("blocked");
  });

  it("2. the hold blocks while the task is still assigned to the old owner", async () => {
    const ids = await seedResolvedHoldOwnedByA();
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
      runId: ids.runId,
      agentId: ids.agentA,
      cause: "legacy_execution_requires_reconciliation",
    });
  });

  it("3. the new participant's stage wake starts a run at once", async () => {
    const ids = await seedResolvedHoldOwnedByA();
    const stageWakeup = await moveTaskTo(ids, ids.agentB);
    const reason = stageWakeup.wakeup.reason!;
    expect(reason).toBe("execution_review_requested");
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();

    const run = await heartbeat.wakeup(ids.agentB, stageWakeup.wakeup);
    expect(await deferredWakes(ids.agentB, ids.issueId)).toEqual([]);
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runsFor(ids.agentB, reason)).toHaveLength(1);
  });

  it("4. a stage wake saved before the change starts on the next scheduler sweep", async () => {
    const ids = await seedResolvedHoldOwnedByA();
    // The hand-off is sent while the old owner still holds the task's blocker.
    const stageWakeup = await moveTaskTo(ids, ids.agentB);
    await db.update(issues).set({ assigneeAgentId: ids.agentA }).where(eq(issues.id, ids.issueId));
    expect(await heartbeat.wakeup(ids.agentB, stageWakeup.wakeup)).toBeNull();
    const [saved] = await deferredWakes(ids.agentB, ids.issueId);
    expect(saved).toBeDefined();
    expect(await runsFor(ids.agentB, stageWakeup.wakeup.reason!)).toHaveLength(0);

    // The fix is installed: the new owner is the assignee and the hold no longer applies.
    await db.update(issues).set({ assigneeAgentId: ids.agentB }).where(eq(issues.id, ids.issueId));
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.id, saved!.id));
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await runsFor(ids.agentB, stageWakeup.wakeup.reason!)).toHaveLength(1);
    expect(await deferredWakes(ids.agentB, ids.issueId)).toEqual([]);
  });

  it("5. a comment wake for the new owner is admitted", async () => {
    const ids = await seedResolvedHoldOwnedByA();
    await moveTaskTo(ids, ids.agentB);

    for (const actor of ["user", "agent"] as const) {
      expect(await heartbeat.wakeup(ids.agentB, commentWake(ids, actor))).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
    }
    expect(await deferredWakes(ids.agentB, ids.issueId)).toEqual([]);
    expect(await runsFor(ids.agentB, "issue_commented")).toHaveLength(2);
  });

  it("6. a workspace-restore hold still blocks the new owner", async () => {
    const ids = await seedResolvedHoldOwnedByA({ restoreHold: true });
    const stageWakeup = await moveTaskTo(ids, ids.agentB);
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
      workspaceRepairRequired: true,
    });

    expect(await heartbeat.wakeup(ids.agentB, stageWakeup.wakeup)).toBeNull();
    expect(await deferredWakes(ids.agentB, ids.issueId)).toHaveLength(1);
    expect(await runsFor(ids.agentB, stageWakeup.wakeup.reason!)).toHaveLength(0);
  });

  it("7. moving the task back to the old owner brings the hold back", async () => {
    const ids = await seedResolvedHoldOwnedByA();
    await moveTaskTo(ids, ids.agentB);
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();

    await moveTaskTo(ids, ids.agentA);
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
      runId: ids.runId,
      agentId: ids.agentA,
    });
    expect(await heartbeat.wakeup(ids.agentA, commentWake(ids, "user"))).toBeNull();
    expect(await runsFor(ids.agentA, "issue_commented")).toHaveLength(0);
  });
});
