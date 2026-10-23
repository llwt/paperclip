import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  agentRuntimeState,
  agents,
  agentTaskSessions,
  agentWakeupRequests,
  authUsers,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Pins the post-run handling after adapter.execute() (outcome, terminal write,
// effects, accounting, task session) so moving it into finalizeAdapterRun
// cannot change it (SX-1745).

const { adapterExecute, runningProcesses, terminateLocalService } = vi.hoisted(() => ({
  adapterExecute: vi.fn<(ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>>(),
  runningProcesses: new Map<string, { child: ChildProcess; graceSec: number; processGroupId: number | null }>(),
  terminateLocalService: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}));
vi.mock("../adapters/index.js", () => {
  const adapterFor = (type: string) => ({ type, execute: adapterExecute, testEnvironment: vi.fn(), supportsLocalAgentJwt: false });
  return { getServerAdapter: adapterFor, findActiveServerAdapter: adapterFor, runningProcesses };
});
vi.mock("../services/local-service-supervisor.js", async () => ({
  ...await vi.importActual<typeof import("../services/local-service-supervisor.js")>("../services/local-service-supervisor.js"),
  terminateLocalService,
}));
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeSupported = support.supported ? describe : describe.skip;

describeSupported("heartbeat run finalization", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-finalization-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    runningProcesses.clear();
    vi.clearAllMocks();
    adapterExecute.mockReset();
    terminateLocalService.mockImplementation(async () => {});
  });
  afterAll(async () => {
    await db.$client.end();
    await database.cleanup();
  });

  async function seed(opts: { adapterType?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const userId = `user-${companyId}`;
    const prefix = `F${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Finalization", status: "active",
      issuePrefix: prefix, defaultResponsibleUserId: userId });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle",
      adapterType: opts.adapterType ?? "process", adapterConfig: { model: "model-at-start" }, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finalize", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: userId, identifier: `${prefix}-1` });
    return { companyId, agentId, issueId };
  }

  async function runToEnd(ids: { agentId: string; issueId: string }) {
    const run = await heartbeat.wakeup(ids.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain(latest?.status);
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return run!.id;
  }

  async function observe(runId: string, ids: { agentId: string; issueId: string }) {
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const events = await db.select().from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId)).orderBy(asc(heartbeatRunEvents.seq));
    const costs = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, ids.agentId));
    const sessions = await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, ids.agentId));
    const [agent] = await db.select().from(agents).where(eq(agents.id, ids.agentId));
    const [wakeup] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
    const comments = await db.select().from(issueComments)
      .where(and(eq(issueComments.issueId, ids.issueId), eq(issueComments.createdByRunId, runId)));
    return {
      run,
      lifecycle: events.filter((event) => event.eventType === "lifecycle" || event.eventType === "run.presentation.resolved")
        .map((event) => event.message),
      costs,
      runtime,
      sessions,
      agent,
      wakeup,
      comments,
    };
  }

  const usage = { inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 200 };

  // Closes the issue first, so no follow-up wake runs the adapter again.
  function closingIssue(fn: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>) {
    return async (ctx: AdapterExecutionContext) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, String(ctx.context.issueId)));
      return fn(ctx);
    };
  }

  it("records a successful run with its usage, one cost event, its session and the response comment", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async () => ({
      exitCode: 0, signal: null, timedOut: false, summary: "All done.",
      usage, usageBasis: "per_run", costUsd: 0.5, provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-x",
      sessionId: "session-1", sessionParams: { sessionId: "session-1" }, sessionDisplayId: "session-1",
    })));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);

    expect(seen.run).toMatchObject({
      status: "succeeded", error: null, errorCode: null, exitCode: 0, signal: null, sessionIdAfter: "session-1",
    });
    expect(seen.run.usageJson).toMatchObject({
      inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 200, usageSource: "per_run",
      provider: "openai", biller: "openai", model: "gpt-x", costUsd: 0.5, billingType: "metered_api",
      persistedSessionId: "session-1", freshSession: true, sessionReused: false, taskSessionReused: false,
    });
    expect(seen.run.resultJson).toMatchObject({ summary: "All done." });
    expect(seen.lifecycle).toEqual(["run started", "run succeeded", "run presentation resolved", "run scratch cleaned"]);
    expect(seen.run.resultJson).toMatchObject({ presentationDecision: { commentAction: "create" } });
    expect(seen.costs).toHaveLength(1);
    expect(seen.costs[0]).toMatchObject({ inputTokens: 1_000, cachedInputTokens: 100, outputTokens: 200, costCents: 50,
      provider: "openai", model: "gpt-x", billingType: "metered_api", issueId: ids.issueId });
    expect(seen.runtime).toMatchObject({ adapterType: "process", lastRunId: runId, lastRunStatus: "succeeded",
      totalInputTokens: 1_000, totalCachedInputTokens: 100, totalOutputTokens: 200, totalCostCents: 50 });
    expect(seen.sessions).toHaveLength(1);
    expect(seen.sessions[0]).toMatchObject({ adapterType: "process", taskKey: ids.issueId,
      sessionDisplayId: "session-1", lastRunId: runId, lastError: null });
    expect(seen.sessions[0].sessionParamsJson).toMatchObject({ sessionId: "session-1" });
    expect(seen.agent.status).toBe("idle");
    expect(seen.wakeup.status).toBe("completed");
    expect(seen.comments.map((comment) => comment.body)).toEqual(["All done."]);
  });

  it("treats a null exit code without an error as success, as before", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: null, signal: null, timedOut: false, summary: "Ok." })));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "succeeded", exitCode: null, error: null, errorCode: null });
    expect(seen.costs).toHaveLength(0);
    expect(seen.runtime).toMatchObject({ lastRunStatus: "succeeded", totalInputTokens: 0, totalCostCents: 0 });
  });

  it("fails a null exit code that carries an error message with the default code", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: null, signal: null, timedOut: false, errorMessage: "provider broke" })));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "failed", exitCode: null, error: "provider broke", errorCode: "adapter_failed" });
    expect(seen.lifecycle).toContain("run failed");
    expect(seen.wakeup.status).toBe("failed");
    expect(seen.agent.status).toBe("error");
  });

  it("fails a nonzero exit, keeps its usage and clears the task session the adapter asks to clear", async () => {
    const ids = await seed();
    adapterExecute.mockImplementationOnce(closingIssue(async () => ({
      exitCode: 0, signal: null, timedOut: false, sessionId: "session-2", sessionParams: { sessionId: "session-2" },
    })));
    await runToEnd(ids);
    expect(await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.agentId, ids.agentId))).toHaveLength(1);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, ids.issueId));

    adapterExecute.mockImplementationOnce(closingIssue(async () => ({
      exitCode: 3, signal: null, timedOut: false, errorMessage: "provider refused", errorCode: "provider_refused",
      clearSession: true, usage, usageBasis: "per_run", provider: "openai", model: "gpt-x",
      sessionId: "session-2", sessionParams: { sessionId: "session-2" },
    })));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "failed", exitCode: 3, errorCode: "provider_refused", error: "provider refused",
      sessionIdAfter: null, sessionIdBefore: "session-2" });
    // Usage still belongs to the session the run reported.
    expect(seen.run.usageJson).toMatchObject({ inputTokens: 1_000, sessionReused: true, taskSessionReused: true });
    expect(seen.costs).toHaveLength(1);
    expect(seen.sessions).toHaveLength(0);
    expect(seen.runtime).toMatchObject({ lastRunId: runId, lastRunStatus: "failed", totalInputTokens: 1_000 });
  });

  it("records a timeout with the timeout code", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: null, signal: "SIGTERM", timedOut: true })));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "timed_out", errorCode: "timeout", error: "Timed out", signal: "SIGTERM" });
    expect(seen.wakeup.status).toBe("timed_out");
    expect(seen.lifecycle).toContain("run timed_out");
  });

  it("does nothing when Stop wins the terminal write before the run finishes", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async (ctx) => {
      // Another path (Stop, a reaper) ends the run first.
      await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(), error: "Stopped elsewhere",
        errorCode: "cancelled" }).where(eq(heartbeatRuns.id, ctx.runId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Late result.", usage, usageBasis: "per_run",
        costUsd: 0.5, provider: "openai", model: "gpt-x", sessionId: "session-3", sessionParams: { sessionId: "session-3" } };
    }));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "cancelled", error: "Stopped elsewhere", sessionIdAfter: null, usageJson: null });
    expect(seen.run.resultJson ?? {}).not.toHaveProperty("summary");
    expect(seen.lifecycle).toEqual(["run started", "run scratch cleaned"]);
    expect(seen.costs).toHaveLength(0);
    expect(seen.runtime ?? { totalInputTokens: 0, lastRunId: null }).toMatchObject({ totalInputTokens: 0 });
    expect(seen.runtime?.lastRunId ?? null).not.toBe(runId);
    expect(seen.sessions).toHaveLength(0);
    expect(seen.comments).toHaveLength(0);
  });

  it("does not account a run twice when Stop arrives after the run finished", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: 0, signal: null, timedOut: false, usage, usageBasis: "per_run",
      costUsd: 0.5, provider: "openai", model: "gpt-x" })));
    const runId = await runToEnd(ids);
    await heartbeat.cancelRun(runId, "Too late");
    const seen = await observe(runId, ids);
    expect(seen.run.status).toBe("succeeded");
    expect(seen.costs).toHaveLength(1);
    expect(seen.runtime).toMatchObject({ totalInputTokens: 1_000, totalCostCents: 50 });
  });

  it("keeps the session, usage and accounting of an owned process that Stop ended", async () => {
    const ids = await seed();
    let release!: () => void;
    const childEnded = new Promise<void>((resolve) => { release = resolve; });
    let runIdSeen: string | null = null;
    terminateLocalService.mockImplementation(async () => {
      release();
      // Hold Stop open until the executor reaches the cancellation barrier;
      // it sets the control deadline just before that.
      await vi.waitFor(async () => {
        const [row] = await db.select({ deadline: heartbeatRuns.executionControlDeadlineAt })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, runIdSeen!));
        expect(row?.deadline).not.toBeNull();
      }, { timeout: 10_000, interval: 20 });
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    adapterExecute.mockImplementation(closingIssue(async (ctx) => {
      runIdSeen = ctx.runId;
      runningProcesses.set(ctx.runId, { child: { pid: 2_147_483_000 } as ChildProcess, graceSec: 1, processGroupId: null });
      await childEnded;
      return { exitCode: null, signal: "SIGTERM", timedOut: false, errorMessage: "terminated", usage, usageBasis: "per_run",
        costUsd: 0.5, provider: "openai", model: "gpt-x", sessionId: "session-4", sessionParams: { sessionId: "session-4" } };
    }));
    const run = await heartbeat.wakeup(ids.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId } });
    await vi.waitFor(() => expect(runningProcesses.has(run!.id)).toBe(true), { timeout: 15_000 });
    await heartbeat.cancelRun(run!.id, "Stopped by operator");
    await vi.waitFor(async () => expect((await heartbeat.getRun(run!.id))?.status).toBe("cancelled"), { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const seen = await observe(run!.id, ids);
    expect(seen.run).toMatchObject({ status: "cancelled", error: "Stopped by operator", sessionIdAfter: "session-4" });
    expect(seen.run.usageJson).toMatchObject({ inputTokens: 1_000 });
    expect(seen.lifecycle).toContain("run cancelled");
    expect(seen.costs).toHaveLength(1);
    expect(seen.sessions[0]).toMatchObject({ sessionDisplayId: "session-4", lastRunId: run!.id });
  });

  it("finalizes with the adapter and model the run started with after the agent config changes", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async () => {
      await db.update(agents).set({ adapterType: "http", adapterConfig: { model: "model-changed" } })
        .where(eq(agents.id, ids.agentId));
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "session-5", sessionParams: { sessionId: "session-5" } };
    }));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run.status).toBe("succeeded");
    expect(seen.sessions).toHaveLength(1);
    expect(seen.sessions[0]).toMatchObject({ adapterType: "process", sessionDisplayId: "session-5" });
    expect(seen.sessions[0].sessionParamsJson).toMatchObject({ __paperclipConfiguredModel: "model-at-start" });
    expect(seen.runtime.adapterType).toBe("process");
  });
});
