import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
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

// Fork test (SX-1537): an author hands its task to review from inside its own
// run. The route cancels that run and wakes the reviewer at once, while the
// author's provider process is still exiting. The reviewer's wake must wait for
// that process and then start exactly one run; it must never be left skipped,
// and no reviewer run may start while the old process is alive.

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
    summary: "Owner exit test run.",
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

import {
  heartbeatService,
  OWNER_EXIT_RECHECK_INTERVAL_MS,
  OWNER_EXIT_RECHECK_TIMEOUT_MS,
} from "../services/heartbeat.ts";
import { getExecutionBlocker } from "../services/execution-blocker.ts";
import { buildExecutionStageWakeup } from "../routes/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres owner-exit wake tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// No process or process group can have this id, so a signal to it fails.
const DEAD_ID = 2_000_000_000;
const REVIEW_REASON = "execution_review_requested";

// Stand-in for the author's provider process. Each test stops only the child it
// started, by its own handle.
const children = new Set<ChildProcess>();

function startOwnerProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], {
    detached: true,
    stdio: "ignore",
  });
  children.add(child);
  return child;
}

async function stopOwnerProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGKILL");
  await exited;
  children.delete(child);
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    value = await read();
  }
  return value;
}

describeEmbeddedPostgres("stage hand-off wake behind a stopped run whose process is still exiting", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-owner-exit-wake-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    for (const child of [...children]) await stopOwnerProcess(child);
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
   * The author just moved its task to review. Its own run was stopped by the
   * route ("Cancelled before issue reassignment") and its lease was released,
   * but its process (`owner: "pid"`) or process group (`owner: "group"`) may
   * still be alive. With `owner: "none"` it has already exited.
   */
  async function seedHandoffToReview(owner: { kind: "pid" | "group"; child: ChildProcess } | { kind: "none" }) {
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
    const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });
    const reviewPending: IssueExecutionState = {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: agent(reviewerId),
      returnAssignee: agent(authorId),
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };

    const authorRunId = randomUUID();
    const finishedAt = new Date();
    const ownerPid = owner.kind === "none" ? DEAD_ID : owner.child.pid!;
    await db.insert(heartbeatRuns).values({
      id: authorRunId,
      companyId,
      agentId: authorId,
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
      processPid: owner.kind === "pid" ? ownerPid : DEAD_ID,
      processGroupId: owner.kind === "group" ? ownerPid : DEAD_ID,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Hand-off to review",
      status: "in_review",
      priority: "high",
      assigneeAgentId: reviewerId,
      responsibleUserId: "responsible-user",
      executionState: reviewPending as unknown as Record<string, unknown>,
    });
    await db.insert(environmentLeases).values({
      id: randomUUID(),
      companyId,
      environmentId: await localEnvironmentId(),
      issueId,
      heartbeatRunId: authorRunId,
      status: "released",
      releasedAt: finishedAt,
      leasePolicy: "ephemeral",
      provider: "local",
      metadata: { driver: "local" },
    });

    const stageWakeup = buildExecutionStageWakeup({
      issueId,
      previousState: null,
      nextState: reviewPending,
      interruptedRunId: authorRunId,
      requestedByActorType: "agent",
      requestedByActorId: authorId,
    });
    if (!stageWakeup) throw new Error("expected a review wake");
    expect(stageWakeup.agentId).toBe(reviewerId);
    expect(stageWakeup.wakeup.reason).toBe(REVIEW_REASON);
    return { companyId, issueId, authorRunId, authorId, reviewerId, stageWakeup };
  }

  async function reviewWakes(agentId: string, issueId: string) {
    return db
      .select({
        id: agentWakeupRequests.id,
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        runId: agentWakeupRequests.runId,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
        inArray(agentWakeupRequests.reason, [REVIEW_REASON, "execution_reconciliation_required"]),
      ));
  }

  async function reviewRuns(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = ${REVIEW_REASON}`,
      ));
  }

  // Every run on the task other than the stopped author run.
  async function otherRunsOnIssue(issueId: string, authorRunId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`);
    return rows.filter((row) => row.id !== authorRunId);
  }

  it.each([
    ["process", "pid"],
    ["process group", "group"],
  ] as const)(
    "author run cancelled with a live %s: the reviewer wake waits, then starts exactly one run after the exit",
    async (_name, kind) => {
      const child = startOwnerProcess();
      const ids = await seedHandoffToReview({ kind, child });
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toMatchObject({
        runId: ids.authorRunId,
        cause: "execution_owner_active",
      });

      // The route wakes the reviewer while the author's process is alive.
      expect(await heartbeat.wakeup(ids.reviewerId, ids.stageWakeup.wakeup)).toBeNull();
      // Before the fix (installed build) this row was written as `skipped`
      // with reason `execution_reconciliation_required` and never retried.
      const saved = await reviewWakes(ids.reviewerId, ids.issueId);
      expect(saved).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution", reason: REVIEW_REASON, runId: null }),
      ]);
      expect(await reviewRuns(ids.reviewerId)).toHaveLength(0);
      // The task shows the blocker and says the hand-off is saved.
      const blocker = await getExecutionBlocker(db, ids.companyId, ids.issueId);
      expect(blocker?.cause).toBe("execution_owner_active");
      expect(blocker?.nextAction).toContain("The hand-off to the next participant is saved");

      // A recheck while the process is alive starts nothing.
      expect(await heartbeat.recheckOwnerExitWait(ids.companyId, ids.issueId, new Date())).toBe("waiting");
      expect(await otherRunsOnIssue(ids.issueId, ids.authorRunId)).toHaveLength(0);

      // The process exits. No lease release and no comment follows; the
      // server's own owner-exit recheck starts the review.
      await stopOwnerProcess(child);
      const runs = await waitFor(
        () => reviewRuns(ids.reviewerId),
        (rows) => rows.length > 0,
        OWNER_EXIT_RECHECK_INTERVAL_MS * 3,
      );
      expect(runs).toHaveLength(1);
      expect(runs[0]!.contextSnapshot).toMatchObject({
        issueId: ids.issueId,
        wakeReason: REVIEW_REASON,
        source: "issue.execution_stage",
      });
      const wakes = await reviewWakes(ids.reviewerId, ids.issueId);
      expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
      expect(wakes.filter((wake) => wake.status === "skipped")).toHaveLength(0);
      expect(wakes.find((wake) => wake.id === saved[0]!.id)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });

      // Later rechecks and sweeps start nothing more.
      expect(await heartbeat.recheckOwnerExitWait(ids.companyId, ids.issueId, new Date())).toBe("done");
      await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
        .where(eq(agentWakeupRequests.agentId, ids.reviewerId));
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await reviewRuns(ids.reviewerId)).toHaveLength(1);
    },
    30_000,
  );

  it("while the old process stays alive no run starts; after the timeout the task shows the wait and the wake still retries", async () => {
    const child = startOwnerProcess();
    const ids = await seedHandoffToReview({ kind: "pid", child });
    expect(await heartbeat.wakeup(ids.reviewerId, ids.stageWakeup.wakeup)).toBeNull();
    const [saved] = await reviewWakes(ids.reviewerId, ids.issueId);
    expect(saved).toMatchObject({ status: "deferred_issue_execution" });

    // The recheck has run out of time; the process is still alive.
    const waitingSince = new Date(Date.now() - OWNER_EXIT_RECHECK_TIMEOUT_MS - 1_000);
    expect(await heartbeat.recheckOwnerExitWait(ids.companyId, ids.issueId, waitingSince)).toBe("timed_out");
    // A second timeout pass does not mark it again.
    expect(await heartbeat.recheckOwnerExitWait(ids.companyId, ids.issueId, waitingSince)).toBe("timed_out");

    // No second provider process on this conversation: no run at all.
    expect(await otherRunsOnIssue(ids.issueId, ids.authorRunId)).toHaveLength(0);
    // The wake is still saved, now marked with the timeout, never skipped.
    const [marked] = await reviewWakes(ids.reviewerId, ids.issueId);
    expect(marked).toMatchObject({ id: saved!.id, status: "deferred_issue_execution", runId: null });
    expect(marked!.payload?.executionWait).toMatchObject({
      blockingRunId: ids.authorRunId,
      ownerExitTimedOutAt: expect.any(String),
    });
    // The task shows a visible blocked state with the saved hand-off.
    const blocker = await getExecutionBlocker(db, ids.companyId, ids.issueId);
    expect(blocker).toMatchObject({ runId: ids.authorRunId, cause: "execution_owner_active" });
    expect(blocker?.nextAction).toContain("The previous provider process is still running.");
    expect(blocker?.nextAction).toContain("is saved and starts when it has stopped");

    // The scheduler sweep keeps retrying it and still starts nothing.
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(Date.now() - 60_000) })
      .where(eq(agentWakeupRequests.id, saved!.id));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    expect(await otherRunsOnIssue(ids.issueId, ids.authorRunId)).toHaveLength(0);
    expect(await reviewWakes(ids.reviewerId, ids.issueId)).toEqual([
      expect.objectContaining({ id: saved!.id, status: "deferred_issue_execution" }),
    ]);

    // Once the process exits the next sweep starts exactly one review run.
    await stopOwnerProcess(child);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const runs = await reviewRuns(ids.reviewerId);
    expect(runs).toHaveLength(1);
    // The saved row and the receipt of its admission both point at that run.
    const wakes = await reviewWakes(ids.reviewerId, ids.issueId);
    expect(wakes.find((wake) => wake.id === saved!.id)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
    expect(wakes.every((wake) => wake.runId === runs[0]!.id)).toBe(true);
  }, 30_000);

  it("each sweep try stamps the saved hand-off, so a blocked task moves behind untried ones", async () => {
    // The sweep orders tasks by the oldest stamp and takes at most 50.
    const child = startOwnerProcess();
    const ids = await seedHandoffToReview({ kind: "pid", child });
    expect(await heartbeat.wakeup(ids.reviewerId, ids.stageWakeup.wakeup)).toBeNull();
    const old = new Date(Date.now() - 60_000);
    await db.update(agentWakeupRequests).set({ requestedAt: old, updatedAt: old })
      .where(eq(agentWakeupRequests.agentId, ids.reviewerId));
    await heartbeat.resumeQueuedRuns();
    const [row] = await reviewWakes(ids.reviewerId, ids.issueId);
    const [stamped] = await db.select({ updatedAt: agentWakeupRequests.updatedAt })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, row!.id));
    expect(stamped!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  }, 30_000);

  it("normal path: with no live old process the hand-off gives exactly one wake and one run", async () => {
    const ids = await seedHandoffToReview({ kind: "none" });
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();

    const run = await heartbeat.wakeup(ids.reviewerId, ids.stageWakeup.wakeup);
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Nothing was saved, so a recheck and a sweep start nothing more.
    expect(await heartbeat.recheckOwnerExitWait(ids.companyId, ids.issueId, new Date())).toBe("done");
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await reviewRuns(ids.reviewerId);
    expect(runs.map((row) => row.id)).toEqual([run!.id]);
    const wakes = await reviewWakes(ids.reviewerId, ids.issueId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ reason: REVIEW_REASON, runId: run!.id });
  }, 30_000);
});
