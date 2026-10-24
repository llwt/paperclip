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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork test (SX-1848, the SX-1832 and SX-1837 cases): a disposition repair run
// is cancelled at the dispatch gate with `legacy_disposition_repair_suppressed`
// before any provider work starts. That cancel must not leave the issue-wide
// `legacy_execution_requires_reconciliation` hold that saves or skips every
// later wake and keeps the "Recovery needed" notice on the task.

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
    summary: "Suppressed repair test run.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres suppressed repair tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("wakes after a suppressed disposition repair run", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-repair-suppressed-hold-");
    db = createDb(tempDb.connectionString);
    // A dev worktree sets PAPERCLIP_IN_WORKTREE, which would suppress run dispatch.
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
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
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });
    return id;
  }

  /**
   * A disposition repair run is queued for the assignee after a successful run
   * that recorded no disposition. Before it dispatches, the task changes so the
   * repair no longer applies, and the dispatch gate cancels it.
   */
  async function suppressedRepair(reason: "recorded_disposition" | "existing_execution") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = await insertAgent(companyId, "Assignee");
    const otherAgentId = await insertAgent(companyId, "Other");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Task whose repair is suppressed",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const sourceRunId = randomUUID();
    const sourceFinished = new Date(Date.now() - 120_000);
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      status: "succeeded",
      runtimeMode: "legacy",
      invocationSource: "automation",
      startedAt: new Date(sourceFinished.getTime() - 60_000),
      finishedAt: sourceFinished,
      contextSnapshot: { issueId },
      livenessState: "blocked",
      resultJson: { summary: "Done. Need approval. I will continue." },
    });

    if (reason === "recorded_disposition") {
      // The agent (or Hog Boss) recorded a disposition before the repair ran.
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    } else {
      // A newer run for the same task exists, so the repair is not the latest.
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: otherAgentId,
        status: "succeeded",
        runtimeMode: "legacy",
        invocationSource: "automation",
        finishedAt: new Date(),
        createdAt: new Date(Date.now() + 5_000),
        contextSnapshot: { issueId },
      });
    }

    const wakeId = randomUUID();
    const repairRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "automation",
      reason: "issue_disposition_repair",
      triggerDetail: "system",
      requestedByActorType: "system",
      requestedByActorId: "heartbeat_test",
      payload: { issueId, retryOfRunId: sourceRunId },
      status: "queued",
      runId: repairRunId,
    });
    await db.insert(heartbeatRuns).values({
      id: repairRunId,
      companyId,
      agentId,
      status: "queued",
      runtimeMode: "legacy",
      invocationSource: "automation",
      responsibleUserId: "responsible-user",
      wakeupRequestId: wakeId,
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_disposition_repair",
        source: "issue.deliberate_wait_disposition_repair",
        retryOfRunId: sourceRunId,
        dispositionRepairSourceRunId: sourceRunId,
        legacyDispositionEpisode: { id: sourceRunId, attempt: 1, maxAttempts: 2 },
      },
    });
    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const [repair] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, repairRunId));
    // The periodic settle sweep resolves any recovery action the cancel left.
    await settleUnrecoverableExecutions(db);

    if (reason === "recorded_disposition") {
      // A user comment reopens a task in review before it wakes the assignee.
      await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    }
    return { companyId, issueId, agentId, repairRunId, repair };
  }

  async function wakeForUserComment(agentId: string, issueId: string) {
    return heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });
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
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
  }

  it.each(["recorded_disposition", "existing_execution"] as const)(
    "%s: cancels the repair at the dispatch gate and leaves no execution hold",
    async (reason) => {
      const ids = await suppressedRepair(reason);
      expect(ids.repair).toMatchObject({
        status: "cancelled",
        errorCode: "legacy_disposition_repair_suppressed",
        error: `Disposition repair suppressed: ${reason}`,
      });
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();
      expect(await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, ids.issueId))).toEqual([]);
    },
  );

  it.each(["recorded_disposition", "existing_execution"] as const)(
    "%s: a user comment after the suppressed repair queues a run for the assignee",
    async (reason) => {
      const ids = await suppressedRepair(reason);
      const run = await wakeForUserComment(ids.agentId, ids.issueId);
      expect(await deferredWakes(ids.agentId, ids.issueId)).toEqual([]);
      expect(run).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(await runsFor(ids.agentId, "issue_commented")).toHaveLength(1);
    },
  );

  it("no longer holds the task for a suppressed-repair hold that was already written", async () => {
    const ids = await suppressedRepair("recorded_disposition");
    // Shape of the records already in live data: the cancel created a legacy
    // reconciliation action, and the settle sweep resolved it with no replay.
    await db.insert(issueRecoveryActions).values({
      companyId: ids.companyId,
      sourceIssueId: ids.issueId,
      kind: "active_run_watchdog",
      ownerType: "board",
      status: "resolved",
      outcome: "blocked",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: `legacy-execution:${ids.repairRunId}`,
      nextAction: "Stopped",
      evidence: {
        runId: ids.repairRunId,
        originalFailureCode: "legacy_disposition_repair_suppressed",
        automaticRecovery: { policy: "preserve_without_replay_v1", runId: ids.repairRunId, replay: "blocked", actionOutcome: "unknown" },
      },
    });
    expect(await getExecutionBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    const run = await wakeForUserComment(ids.agentId, ids.issueId);
    expect(run).not.toBeNull();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await runsFor(ids.agentId, "issue_commented")).toHaveLength(1);
  });
});
