import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork test (SX-1386): the same hand-off as execution-stage-handoff-wake.test.ts,
// but the stage decision goes through the real PATCH and comment routes. The
// PATCH route no longer stops the deciding run (SX-4277); it queues the stage
// wake behind that run, which ends on its own. While it is running, and when it
// has a live process its environment lease stays held until its executor
// finishes cleanup, the wake must wait and then start exactly one run for the
// next participant.

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
    summary: "Stage hand-off route test run.",
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

import { runningProcesses } from "../adapters/utils.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres stage hand-off route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// No process or process group can have this id, so a signal to it fails.
const DEAD_ID = 2_000_000_000;

// Child processes started by this file, stopped by their own PID afterwards.
const children = new Map<string, ChildProcess>();

type Transition = "review_to_approval" | "review_to_changes_requested" | "approval_to_changes_requested";

describeEmbeddedPostgres("execution stage hand-off wake through the issue routes", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stage-handoff-routes-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 30_000);

  afterEach(async () => {
    for (const [runId, child] of children) {
      runningProcesses.delete(runId);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    children.clear();
    mockAdapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Keep `environments`: truncating it cascades to `instance_settings`, and
    // re-creating that row under a request transaction stalls the routes.
    await db.execute(sql`truncate table companies cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

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
   * A task in review or approval whose participant has a running run that is
   * about to decide. With `leaseHeld` that run has a live process in this
   * server and owns an active environment lease. Stopping it ends the process;
   * the lease stays held until its executor finishes cleanup, which here is
   * the fork's sweep for a terminal run whose process is gone.
   */
  async function seedStage(input: { transition: Transition; leaseHeld: boolean }) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const executorId = await insertAgent(companyId, "Executor");
    const reviewerId = await insertAgent(companyId, "Reviewer");
    const approverId = await insertAgent(companyId, "Approver");
    const reviewStageId = randomUUID();
    const approvalStageId = randomUUID();
    const atApproval = input.transition === "approval_to_changes_requested";
    const deciderId = atApproval ? approverId : reviewerId;
    const nextAgentId = input.transition === "review_to_approval" ? approverId : executorId;
    const agent = (agentId: string) => ({ type: "agent" as const, agentId, userId: null });

    const issueId = randomUUID();
    const decidingRunId = randomUUID();
    let processId = DEAD_ID;
    if (input.leaseHeld) {
      const child = spawn("sleep", ["120"], { detached: true, stdio: "ignore" });
      if (!child.pid) throw new Error("could not start the deciding run's process");
      children.set(decidingRunId, child);
      processId = child.pid;
      runningProcesses.set(decidingRunId, { child, graceSec: 1, processGroupId: child.pid });
    }
    await db.insert(heartbeatRuns).values({
      id: decidingRunId,
      companyId,
      agentId: deciderId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(Date.now() - 60_000),
      contextSnapshot: {
        issueId,
        wakeReason: atApproval ? "execution_approval_requested" : "execution_review_requested",
      },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      runtimeModeResolvedAt: new Date(Date.now() - 60_000),
      processPid: processId,
      processGroupId: processId,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Stage hand-off through the routes",
      status: "in_review",
      priority: "high",
      assigneeAgentId: deciderId,
      responsibleUserId: "responsible-user",
      executionRunId: decidingRunId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [
          {
            id: reviewStageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }],
          },
          {
            id: approvalStageId,
            type: "approval",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: approverId }],
          },
        ],
      },
      executionState: {
        status: "pending",
        currentStageId: atApproval ? approvalStageId : reviewStageId,
        currentStageIndex: atApproval ? 1 : 0,
        currentStageType: atApproval ? "approval" : "review",
        currentParticipant: agent(deciderId),
        returnAssignee: agent(executorId),
        reviewRequest: null,
        completedStageIds: atApproval ? [reviewStageId] : [],
        lastDecisionId: null,
        lastDecisionOutcome: atApproval ? "approved" : null,
      },
    });
    const leaseId = randomUUID();
    if (input.leaseHeld) {
      await db.insert(environmentLeases).values({
        id: leaseId,
        companyId,
        environmentId: await localEnvironmentId(),
        issueId,
        heartbeatRunId: decidingRunId,
        status: "active",
        leasePolicy: "ephemeral",
        provider: "local",
        metadata: { driver: "local" },
      });
    }
    const actor = { type: "agent", source: "agent_key", companyId, agentId: deciderId, runId: decidingRunId };
    return { companyId, issueId, decidingRunId, nextAgentId, actor, leaseId };
  }

  async function wakesFor(agentId: string, issueId: string, reason: string) {
    return db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        // A wake saved behind the active issue run keeps its own reason in
        // its saved context.
        sql`(${agentWakeupRequests.reason} = ${reason} or
          ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'wakeReason' = ${reason})`,
        sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      ));
  }

  async function runsFor(agentId: string, issueId: string, wakeReason: string) {
    return db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' = ${wakeReason}`,
      ));
  }

  async function decide(ids: Awaited<ReturnType<typeof seedStage>>, route: "patch" | "comment", transition: Transition) {
    const res = route === "patch"
      ? await request(app(ids.actor))
        .patch(`/api/issues/${ids.issueId}`)
        .send(transition === "review_to_approval"
          ? { status: "done", comment: "Approved." }
          : { status: "in_progress", comment: "Changes needed." })
      : await request(app(ids.actor))
        .post(`/api/issues/${ids.issueId}/comments`)
        .send({ body: "## Review: APPROVED\n\nLooks good." });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const [decidingRun] = await db.select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, ids.decidingRunId));
    // The PATCH does not stop the deciding run (SX-4277); it ends on its own
    // after the decision.
    if (route === "patch") expect(decidingRun).toMatchObject({ status: "running", resultJson: null });
  }

  // The deciding run ends. Its process is gone, so the saved hand-off starts
  // on the owner-exit recheck and the queue sweep.
  async function endDecidingRun(ids: Awaited<ReturnType<typeof seedStage>>, input: { sweep: boolean }) {
    expect(await heartbeat.cancelRun(ids.decidingRunId, "Stopped after the decision"))
      .toMatchObject({ status: "cancelled" });
    if (input.sweep) {
      await heartbeat.recheckOwnerExitWait(ids.companyId, ids.issueId, new Date());
      await heartbeat.resumeQueuedRuns();
    }
  }

  const cases = [
    ["PATCH", "patch", "review_to_approval", "execution_approval_requested"],
    ["PATCH", "patch", "review_to_changes_requested", "execution_changes_requested"],
    ["PATCH", "patch", "approval_to_changes_requested", "execution_changes_requested"],
    ["comment", "comment", "review_to_approval", "execution_approval_requested"],
  ] as const;

  it.each(cases)(
    "%s %s, deciding run interrupted with its lease held: exactly one run after the release",
    async (_label, route, transition, wakeReason) => {
      const ids = await seedStage({ transition, leaseHeld: true });
      await decide(ids, route, transition);

      // The route queues the wake after its response; wait for the saved row.
      await vi.waitFor(async () => {
        expect(await wakesFor(ids.nextAgentId, ids.issueId, wakeReason)).toEqual([
          expect.objectContaining({ status: "deferred_issue_execution", runId: null }),
        ]);
      }, { timeout: 10_000, interval: 50 });
      expect(await runsFor(ids.nextAgentId, ids.issueId, wakeReason)).toHaveLength(0);

      // The deciding run ends after its decision; the held wake waits for the
      // lease release below.
      await endDecidingRun(ids, { sweep: false });
      expect(await runsFor(ids.nextAgentId, ids.issueId, wakeReason)).toHaveLength(0);
      // The stopped run's executor finishes cleanup and releases the lease.
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const runs = await runsFor(ids.nextAgentId, ids.issueId, wakeReason);
      expect(runs).toHaveLength(1);
      const wakes = await wakesFor(ids.nextAgentId, ids.issueId, wakeReason);
      expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
      expect(wakes.every((wake) => wake.runId === runs[0]!.id)).toBe(true);
    },
    30_000,
  );

  it.each(cases)(
    "%s %s, normal path without a held lease: exactly one run, no duplicate",
    async (_label, route, transition, wakeReason) => {
      const ids = await seedStage({ transition, leaseHeld: false });
      if (route === "comment") {
        // The deciding run already ended without holding a lease.
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
          .where(eq(heartbeatRuns.id, ids.decidingRunId));
        await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, ids.issueId));
      }
      await decide(ids, route, transition);

      if (route === "patch") {
        // The PATCH left the deciding run running; the wake is held behind it
        // until the run ends on its own.
        await vi.waitFor(async () => {
          expect(await wakesFor(ids.nextAgentId, ids.issueId, wakeReason)).toEqual([
            expect.objectContaining({ status: "deferred_issue_execution", runId: null }),
          ]);
        }, { timeout: 10_000, interval: 50 });
        expect(await runsFor(ids.nextAgentId, ids.issueId, wakeReason)).toHaveLength(0);
        await endDecidingRun(ids, { sweep: true });
      }

      await vi.waitFor(async () => {
        expect(await runsFor(ids.nextAgentId, ids.issueId, wakeReason)).toHaveLength(1);
      }, { timeout: 10_000, interval: 50 });
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      const runs = await runsFor(ids.nextAgentId, ids.issueId, wakeReason);
      expect(runs).toHaveLength(1);
      const wakes = await wakesFor(ids.nextAgentId, ids.issueId, wakeReason);
      if (route === "patch") {
        // The wake held behind the deciding run is settled with the one run.
        expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
        expect(wakes.every((wake) => wake.runId === runs[0]!.id)).toBe(true);
      } else {
        expect(wakes).toHaveLength(1);
        expect(wakes[0]).toMatchObject({ runId: runs[0]!.id });
      }
    },
    30_000,
  );

  it("one PATCH that sets status, assignee and stage together queues exactly one wake for the new owner", async () => {
    const ids = await seedStage({ transition: "review_to_changes_requested", leaseHeld: false });
    const res = await request(app(ids.actor))
      .patch(`/api/issues/${ids.issueId}`)
      .send({ status: "in_progress", assigneeAgentId: ids.nextAgentId, comment: "Changes needed." });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);

    const wakesForIssue = (agentId: string) => db
      .select({
        id: agentWakeupRequests.id,
        reason: agentWakeupRequests.reason,
        status: agentWakeupRequests.status,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, agentId),
        sql`${agentWakeupRequests.payload}->>'issueId' = ${ids.issueId}`,
      ));

    // The PATCH left the deciding run running, so the new owner's wake is held
    // behind it and starts once that run ends on its own.
    await vi.waitFor(async () => {
      expect(await wakesForIssue(ids.nextAgentId)).toEqual([
        expect.objectContaining({ status: "deferred_issue_execution", runId: null }),
      ]);
    }, { timeout: 10_000, interval: 50 });
    expect(await runsFor(ids.nextAgentId, ids.issueId, "execution_changes_requested")).toHaveLength(0);
    await endDecidingRun(ids, { sweep: true });
    await vi.waitFor(async () => {
      expect(await runsFor(ids.nextAgentId, ids.issueId, "execution_changes_requested")).toHaveLength(1);
    }, { timeout: 10_000, interval: 50 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    // A finished test run without a comment gets its own `missing_issue_comment`
    // follow-up, which is not a duplicate of the hand-off wake.
    const wakes = (await wakesForIssue(ids.nextAgentId)).filter((wake) => wake.reason !== "missing_issue_comment");
    // The release of the held wake adds a row that coalesces into the same run.
    expect(wakes.filter((wake) => wake.status === "deferred_issue_execution")).toHaveLength(0);
    expect(wakes.every((wake) => wake.reason === "issue_execution_deferred")).toBe(true);
    const allRuns = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.agentId, ids.nextAgentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${ids.issueId}`,
        sql`${heartbeatRuns.contextSnapshot}->>'wakeReason' <> 'missing_issue_comment'`,
      ));
    expect(allRuns).toHaveLength(1);
    expect(wakes.every((wake) => wake.runId === allRuns[0]!.id)).toBe(true);
  }, 30_000);
});
