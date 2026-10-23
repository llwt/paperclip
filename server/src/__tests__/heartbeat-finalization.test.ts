import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { and, asc, eq, sql } from "drizzle-orm";
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
import { sessionCodec as claudeSessionCodec } from "@paperclipai/adapter-claude-local/server";
import { sessionCodec as codexSessionCodec } from "@paperclipai/adapter-codex-local/server";
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
import {
  adapterOutputRecoveryContextFromSnapshot,
  buildLocalResultRecoverySnapshot,
  heartbeatService,
  LOCAL_RESULT_RECOVERY_CONTEXT_KEY,
  type LocalResultRecoverySnapshot,
} from "../services/heartbeat.js";

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

  it("records the recovery snapshot before every invocation, a fresh-session retry included", async () => {
    const ids = await seed();
    await db.update(agents).set({
      adapterConfig: { model: "model-at-start", env: { OPENAI_API_KEY: "sk-config-secret" } },
      runtimeConfig: { env: { RUNTIME_TOKEN: "runtime-secret" } },
    }).where(eq(agents.id, ids.agentId));
    const seenAtInvocation: Array<LocalResultRecoverySnapshot | undefined> = [];
    const readSnapshot = async (runId: string) => {
      const [row] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return (row?.context as Record<string, unknown> | null)?.[LOCAL_RESULT_RECOVERY_CONTEXT_KEY] as LocalResultRecoverySnapshot | undefined;
    };
    adapterExecute.mockImplementation(closingIssue(async (ctx) => {
      const invoke = async (sessionId: string | null) => {
        await ctx.onMeta!({
          adapterType: "process", command: "cli", env: { OPENAI_API_KEY: "sk-meta-secret" }, prompt: "secret prompt text",
          recovery: { version: 1, engine: "cli", sessionIdBefore: sessionId,
            sessionParams: sessionId ? { sessionId, token: "nested-secret", nested: { a: 1 } } : null,
            accounting: { provider: "openai", biller: "openai", model: "gpt-x", billingType: "subscription" } },
        });
        // The child would start here.
        seenAtInvocation.push(await readSnapshot(ctx.runId));
      };
      await invoke("old-session");
      await ctx.onLog("stdout", "first child output\n");
      await ctx.onLog("stdout", "first child final\n");
      await invoke(null);
      await ctx.onLog("stdout", "second child output\n");
      return { exitCode: 0, signal: null, timedOut: false, sessionId: "new-session", sessionParams: { sessionId: "new-session" } };
    }));
    const runId = await runToEnd(ids);

    expect(seenAtInvocation).toHaveLength(2);
    const [first, second] = seenAtInvocation;
    expect(first).toMatchObject({ version: 1, adapterType: "process", taskKey: ids.issueId, configuredModel: "model-at-start",
      invocation: { number: 1, engine: "cli", sessionIdBefore: "old-session", sessionParams: { sessionId: "old-session" },
        accounting: { provider: "openai", biller: "openai", model: "gpt-x", billingType: "subscription" } } });
    expect(second).toMatchObject({ invocation: { number: 2, sessionIdBefore: null, sessionParams: null } });
    // The retry starts after the first child's two output records.
    expect(second!.invocation.firstSeq).toBe(first!.invocation.firstSeq + 2);
    // Without an adapter session codec only the session id is kept.
    expect(first!.invocation.sessionParams).toEqual({ sessionId: "old-session" });
    for (const snapshot of [first, second]) {
      const text = JSON.stringify(snapshot);
      for (const secret of ["sk-config-secret", "runtime-secret", "sk-meta-secret", "secret prompt text", "nested-secret"]) {
        expect(text).not.toContain(secret);
      }
      expect(Object.keys(snapshot!).sort()).toEqual(
        ["adapterType", "configFreshness", "configuredModel", "invocation", "session", "taskKey", "version"]);
    }
    const seen = await observe(runId, ids);
    expect(seen.run.status).toBe("succeeded");
    // Later contextSnapshot writes keep the latest invocation's snapshot.
    expect((seen.run.contextSnapshot as Record<string, unknown>)[LOCAL_RESULT_RECOVERY_CONTEXT_KEY])
      .toMatchObject({ invocation: { number: 2 } });
  });

  // Effects that need the issue to stay open; later wakes of the agent end it.
  async function runOpenIssue(ids: { agentId: string; issueId: string }, first: (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>) {
    adapterExecute.mockImplementationOnce(first);
    adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: 0, signal: null, timedOut: false })));
    const run = await heartbeat.wakeup(ids.agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      contextSnapshot: { issueId: ids.issueId, taskId: ids.issueId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      expect(["succeeded", "failed", "cancelled", "timed_out"]).toContain((await heartbeat.getRun(run!.id))?.status);
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    return run!.id;
  }

  async function followUps(runId: string, agentId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId)).orderBy(asc(heartbeatRuns.createdAt));
    return rows.filter((row) => row.id !== runId).map((row) => ({
      status: row.status, retryOfRunId: row.retryOfRunId, scheduledRetryReason: row.scheduledRetryReason,
      scheduledRetryAttempt: row.scheduledRetryAttempt, wakeReason: parseWakeReason(row.contextSnapshot),
    }));
  }
  const parseWakeReason = (context: unknown) => (context as Record<string, unknown> | null)?.wakeReason ?? null;

  // A fault in the database while the run is finalized: the trigger raises
  // for the rows the condition selects.
  async function injectFault(table: "heartbeat_runs" | "cost_events", event: "insert" | "update", condition: string, message: string) {
    const name = `finalization_fault_${randomUUID().replaceAll("-", "")}`;
    await db.execute(sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin raise exception '${message}'; end $$`));
    await db.execute(sql.raw(`create trigger ${name} before ${event} on ${table} for each row when (${condition}) execute function ${name}()`));
    return async () => {
      await db.execute(sql.raw(`drop trigger if exists ${name} on ${table}`));
      await db.execute(sql.raw(`drop function if exists ${name}()`));
    };
  }

  it("schedules the max-turn continuation of a failed run on its open issue", async () => {
    const ids = await seed();
    await db.update(agents).set({ runtimeConfig: { heartbeat: { maxTurnContinuation: { delayMs: 300_000 } } } })
      .where(eq(agents.id, ids.agentId));
    const runId = await runOpenIssue(ids, async () => ({
      exitCode: 1, signal: null, timedOut: false, errorMessage: "hit max turns", errorCode: "max_turns_exhausted",
      resultJson: { stopReason: "max_turns_exhausted" }, sessionId: "session-6", sessionParams: { sessionId: "session-6" },
    }));
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "failed", errorCode: "max_turns_exhausted", error: "hit max turns" });
    expect(await followUps(runId, ids.agentId)).toEqual([{ status: "scheduled_retry", retryOfRunId: runId,
      scheduledRetryReason: "max_turns_continuation", scheduledRetryAttempt: 1, wakeReason: "max_turns_continuation_retry" }]);
    expect(seen.wakeup.status).toBe("failed");
    expect(seen.sessions[0]).toMatchObject({ sessionDisplayId: "session-6", lastRunId: runId });
  });

  it("holds a transient failure of a legacy process run for reconciliation instead of retrying it", async () => {
    const ids = await seed();
    const retryNotBefore = new Date(Date.now() + 3_600_000).toISOString();
    const runId = await runOpenIssue(ids, async () => ({
      exitCode: 1, signal: null, timedOut: false, errorMessage: "upstream overloaded", errorCode: "upstream_overloaded",
      errorFamily: "transient_upstream", retryNotBefore,
    }));
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "failed", errorCode: "upstream_overloaded" });
    expect(seen.run.resultJson).toMatchObject({ errorFamily: "transient_upstream", retryNotBefore, transientRetryNotBefore: retryNotBefore });
    const [issue] = await db.select().from(issues).where(eq(issues.id, ids.issueId));
    // Not a conversation adapter: the run needs reconciliation, so no retry run.
    expect(await followUps(runId, ids.agentId)).toEqual([]);
    expect(seen.lifecycle).toEqual(["run started", "run failed", "run presentation resolved", "run scratch cleaned"]);
    expect(issue.status).toBe("in_progress");
    expect(seen.wakeup.status).toBe("failed");
    expect(seen.agent.status).toBe("error");
  });

  it("starts the continuation wake of a successful run that left its issue open", async () => {
    const ids = await seed();
    const runId = await runOpenIssue(ids, async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "Partway." }));
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "succeeded" });
    expect(seen.comments.map((comment) => comment.body)).toEqual(["Partway."]);
    // The missing disposition is repaired by one follow-up wake.
    expect(await followUps(runId, ids.agentId)).toEqual([{ status: "succeeded", retryOfRunId: null,
      scheduledRetryReason: null, scheduledRetryAttempt: 0, wakeReason: "issue_disposition_repair" }]);
  });

  it("keeps the semantic result of a run that native reconciliation ended first, with its issue effects", async () => {
    const ids = await seed();
    adapterExecute.mockImplementation(closingIssue(async (ctx) => {
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, ctx.runId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Native done.", usage, usageBasis: "per_run",
        costUsd: 0.5, provider: "openai", model: "gpt-x", sessionId: "session-7", sessionParams: { sessionId: "session-7" },
        nativeFinalization: { terminal: { runTerminalState: "succeeded" } } as AdapterExecutionResult["nativeFinalization"] };
    }));
    const runId = await runToEnd(ids);
    const seen = await observe(runId, ids);
    expect(seen.run).toMatchObject({ status: "succeeded", sessionIdAfter: "session-7" });
    expect(seen.run.usageJson).toMatchObject({ inputTokens: 1_000, costUsd: 0.5 });
    expect(seen.run.resultJson).toMatchObject({ summary: "Native done." });
    expect(seen.lifecycle).toEqual(["run started", "run succeeded", "run presentation resolved", "run scratch cleaned"]);
    expect(seen.costs).toHaveLength(1);
    expect(seen.runtime).toMatchObject({ lastRunId: runId, lastRunStatus: "succeeded", totalInputTokens: 1_000, totalCostCents: 50 });
    expect(seen.sessions[0]).toMatchObject({ sessionDisplayId: "session-7", lastRunId: runId });
    expect(seen.comments.map((comment) => comment.body)).toEqual(["Native done."]);
    expect(seen.wakeup.status).toBe("completed");
  });

  it("fails the run through the executor's error path when the terminal write throws", async () => {
    const ids = await seed();
    const removeFault = await injectFault("heartbeat_runs", "update",
      `new.agent_id = '${ids.agentId}' and old.status = 'running' and new.status = 'succeeded'`, "terminal write exploded");
    try {
      adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "Lost.",
        usage, usageBasis: "per_run", costUsd: 0.5, provider: "openai", model: "gpt-x",
        sessionId: "session-8", sessionParams: { sessionId: "session-8" } })));
      const runId = await runToEnd(ids);
      const seen = await observe(runId, ids);
      expect(seen.run).toMatchObject({ status: "failed", errorCode: "adapter_failed", usageJson: null, sessionIdAfter: null });
      // The executor's catch records the failed query.
      expect(seen.run.error).toMatch(/^Failed query: update "heartbeat_runs"/);
      expect(seen.run.logBytes).toBeGreaterThan(0);
      expect(seen.wakeup.status).toBe("failed");
      expect(seen.costs).toHaveLength(0);
      expect(seen.sessions).toHaveLength(0);
      expect(seen.comments).toHaveLength(0);
      expect(seen.agent.status).toBe("error");
    } finally {
      await removeFault();
    }
  });

  it("keeps a terminal run as written when accounting throws after the terminal write", async () => {
    const ids = await seed();
    const removeFault = await injectFault("cost_events", "insert", `new.agent_id = '${ids.agentId}'`, "cost ledger exploded");
    try {
      adapterExecute.mockImplementation(closingIssue(async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "Done.",
        usage, usageBasis: "per_run", costUsd: 0.5, provider: "openai", model: "gpt-x",
        sessionId: "session-9", sessionParams: { sessionId: "session-9" } })));
      const runId = await runToEnd(ids);
      const seen = await observe(runId, ids);
      expect(seen.run).toMatchObject({ status: "succeeded", error: null, sessionIdAfter: "session-9" });
      expect(seen.run.usageJson).toMatchObject({ inputTokens: 1_000 });
      expect(seen.costs).toHaveLength(0);
      // Effects before the cost insert stay; the task session and agent status after it are not written.
      expect(seen.lifecycle).toEqual(["run started", "run succeeded", "run presentation resolved", "run scratch cleaned"]);
      expect(seen.comments.map((comment) => comment.body)).toEqual(["Done."]);
      expect(seen.wakeup.status).toBe("completed");
      expect(seen.runtime).toMatchObject({ lastRunStatus: "succeeded", totalInputTokens: 1_000 });
      expect(seen.sessions).toHaveLength(0);
      expect(seen.agent.status).toBe("running");
    } finally {
      await removeFault();
    }
  });

  describe("finalizeAdapterRun", () => {
    const sessionConfig = {
      version: 1, fingerprint: "fp", categories: [], categoryFingerprints: {}, fingerprints: {},
    } as unknown as Parameters<typeof buildLocalResultRecoverySnapshot>[0]["sessionConfig"];

    async function runningRun(ids: { companyId: string; agentId: string; issueId: string }) {
      // A closed issue gets no follow-up wake that would run the adapter mock.
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, ids.issueId));
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: ids.companyId, agentId: ids.agentId, invocationSource: "automation", status: "running",
        startedAt: new Date(), contextSnapshot: { issueId: ids.issueId, skipIssueComment: true },
      }).returning();
      const [agent] = await db.select().from(agents).where(eq(agents.id, ids.agentId));
      return { run: run!, agent: agent! };
    }

    function finalizeInput(
      row: Awaited<ReturnType<typeof runningRun>>,
      adapterResult: AdapterExecutionResult,
      source:
        | { source: "execute" }
        | { source: "adopted_output"; recoveredOutcome: "succeeded" | "failed"; resultRecovery?: Record<string, unknown> },
    ): Parameters<typeof heartbeat.finalizeAdapterRunForTests>[0] {
      return {
        ...source,
        run: row.run,
        agent: row.agent,
        adapterResult,
        session: {
          codec: { deserialize: (raw) => raw as Record<string, unknown> | null, serialize: (params) => params },
          taskKey: null, previousParams: null, dispatched: { sessionId: null, sessionDisplayId: null },
          taskSessionReused: false, rotated: false, rotationReason: null, configuredModel: null,
          configMetadata: sessionConfig, configFreshness: {},
        },
        issue: { id: null, ref: null, context: null },
        redaction: { enabled: false },
        isAborted: () => false,
        secretValues: () => [],
        onLog: async () => {},
        finalizeLog: async () => ({ summary: null, stdoutExcerpt: "", stderrExcerpt: "" }),
      };
    }

    const nullExit = { exitCode: null, signal: null, timedOut: false } as const;

    it("uses the recovered verdict of adopted output, not the null-exit rule", async () => {
      const ids = await seed();
      const row = await runningRun(ids);
      const result = await heartbeat.finalizeAdapterRunForTests(
        finalizeInput(row, { ...nullExit }, { source: "adopted_output", recoveredOutcome: "failed" }));
      expect(result).toMatchObject({ won: true, lateWrite: false, outcome: "failed" });
      expect(result.run).toMatchObject({ status: "failed", exitCode: null, errorCode: "adapter_failed", error: "Adapter failed" });
    });

    it("keeps the adoption, output-capture and leftover-sweep provenance of an adopted run, whatever the recovered outcome", async () => {
      const hotRestart = {
        adopted: true, adoptedAt: "2026-10-23T10:00:00.000Z", previousServerPid: 11, newServerPid: 22,
        previousServerVersion: "1.0.0", newServerVersion: "1.0.1", processPid: 33, processGroupId: 33,
        outputCapture: { mode: "relay", relayPid: 44, lastSeq: 9 },
      };
      const resultRecovery = { version: 1, source: "run_log", decision: "recovered", exitCodeKnown: false };
      // Written by the SX-1851 sweep when the adopted child ended, before finalization.
      const leftoverProcessSweep = { kind: "leftover_process_sweep", stopped: 1, processes: [{ pid: 55 }] };
      for (const recoveredOutcome of ["succeeded", "failed"] as const) {
        const ids = await seed();
        const row = await runningRun(ids);
        await db.update(heartbeatRuns).set({ resultJson: { hotRestart, leftoverProcessSweep } }).where(eq(heartbeatRuns.id, row.run.id));
        const result = await heartbeat.finalizeAdapterRunForTests(finalizeInput(row, {
          ...nullExit, summary: "Recovered.",
          // Adapter JSON cannot replace the server-owned record.
          resultJson: { result: "parsed", hotRestart: { adopted: false, outputCapture: null }, leftoverProcessSweep: null },
        }, { source: "adopted_output", recoveredOutcome, resultRecovery }));
        expect(result).toMatchObject({ won: true, outcome: recoveredOutcome });
        const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.run.id));
        expect(stored.status).toBe(recoveredOutcome);
        expect(stored.resultJson).toMatchObject({ result: "parsed", summary: "Recovered." });
        expect((stored.resultJson as Record<string, unknown>).hotRestart).toEqual({ ...hotRestart, resultRecovery });
        expect((stored.resultJson as Record<string, unknown>).leftoverProcessSweep).toEqual(leftoverProcessSweep);
      }
    });

    it("leaves resultJson without hotRestart for an adopted run that has none, and for the live executor", async () => {
      for (const source of [{ source: "execute" }, { source: "adopted_output", recoveredOutcome: "succeeded" }] as const) {
        const ids = await seed();
        const row = await runningRun(ids);
        await heartbeat.finalizeAdapterRunForTests(finalizeInput(row, { ...nullExit, resultJson: { result: "parsed" } }, source));
        const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.run.id));
        expect(stored.resultJson).toMatchObject({ result: "parsed" });
        expect(stored.resultJson).not.toHaveProperty("hotRestart");
      }
    });

    it("lets one of two racing finalizers win and accounts the run once", async () => {
      const ids = await seed();
      const row = await runningRun(ids);
      const result: AdapterExecutionResult = { ...nullExit, usage, usageBasis: "per_run", costUsd: 0.5, provider: "openai", model: "gpt-x" };
      const outcomes = await Promise.all([
        heartbeat.finalizeAdapterRunForTests(finalizeInput(row, result, { source: "adopted_output", recoveredOutcome: "succeeded" })),
        heartbeat.finalizeAdapterRunForTests(finalizeInput(row, result, { source: "adopted_output", recoveredOutcome: "succeeded" })),
      ]);
      expect(outcomes.map((outcome) => outcome.won).sort()).toEqual([false, true]);
      expect(outcomes.find((outcome) => !outcome.won)).toMatchObject({ lateWrite: false, run: null });
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, row.run.id))).toHaveLength(1);
      const [runtime] = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.agentId, ids.agentId));
      expect(runtime).toMatchObject({ totalInputTokens: 1_000, totalCostCents: 50 });
    });

    it("keeps the native late write for the live executor only", async () => {
      for (const source of [{ source: "execute" }, { source: "adopted_output", recoveredOutcome: "succeeded" }] as const) {
        const ids = await seed();
        const row = await runningRun(ids);
        // Native reconciliation committed the same terminal status first.
        await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, row.run.id));
        const result = await heartbeat.finalizeAdapterRunForTests(finalizeInput(row, {
          ...nullExit, usage, usageBasis: "per_run", provider: "openai", model: "gpt-x",
          nativeFinalization: { terminal: { runTerminalState: "succeeded" } } as AdapterExecutionResult["nativeFinalization"],
        }, source));
        const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, row.run.id));
        const costs = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, row.run.id));
        if (source.source === "execute") {
          expect(result).toMatchObject({ won: false, lateWrite: true });
          expect(stored.usageJson).toMatchObject({ inputTokens: 1_000 });
          expect(costs).toHaveLength(1);
        } else {
          expect(result).toMatchObject({ won: false, lateWrite: false, run: null });
          expect(stored.usageJson).toBeNull();
          expect(costs).toHaveLength(0);
        }
      }
    });
  });

  describe("recovery snapshot", () => {
    const sessionConfig = {
      version: 1, fingerprint: "fp", categories: ["adapter"], categoryFingerprints: { adapter: "a" },
      fingerprints: { secret: "do-not-copy" }, aiCredentialIdentity: "identity-1",
    } as unknown as Parameters<typeof buildLocalResultRecoverySnapshot>[0]["sessionConfig"];
    const codec = {
      deserialize: (raw: unknown) => raw as Record<string, unknown> | null,
      serialize: (params: Record<string, unknown> | null) => params ? { ...params, nested: { token: "nested-secret" } } : null,
    };

    function build(recovery: Parameters<typeof buildLocalResultRecoverySnapshot>[0]["recovery"]) {
      return buildLocalResultRecoverySnapshot({
        adapterType: "claude_local", codec, taskKey: "task-1", configuredModel: "opus",
        previousSessionParams: { sessionId: "s-0", cwd: "/w", __paperclipConfiguredModel: "opus" },
        dispatched: { sessionId: "s-0", sessionDisplayId: "s-0", sessionParams: { sessionId: "s-0", cwd: "/w" } },
        taskSessionReused: true, rotated: false, rotationReason: null, sessionConfig, configFreshness: { version: 1 },
        invocationNumber: 1, firstSeq: 7, startedAt: new Date("2026-10-23T00:00:00.000Z"), recovery,
      });
    }

    it("keeps only flat codec fields and the session config the finalizer attaches", () => {
      const snapshot = build({ version: 1, engine: "cli", sessionIdBefore: "s-0", sessionParams: { sessionId: "s-0", cwd: "/w" },
        accounting: { provider: "anthropic", biller: "anthropic", model: "opus", billingType: "subscription" } });
      expect(snapshot.session.previousParams).toEqual({ sessionId: "s-0", cwd: "/w" });
      expect(snapshot.invocation.sessionParams).toEqual({ sessionId: "s-0", cwd: "/w" });
      expect(snapshot.session.config).toEqual({ version: 1, fingerprint: "fp", categories: ["adapter"],
        categoryFingerprints: { adapter: "a" }, aiCredentialIdentity: "identity-1" });
      expect(JSON.stringify(snapshot)).not.toContain("nested-secret");
      expect(JSON.stringify(snapshot)).not.toContain("do-not-copy");
    });

    it("maps to the recovery hook context, and has none without a known engine", () => {
      const snapshot = build({ version: 1, engine: "cli", sessionIdBefore: "s-0", sessionParams: null,
        accounting: { provider: "anthropic", biller: null, model: "opus", billingType: "bogus" as never } });
      expect(adapterOutputRecoveryContextFromSnapshot(snapshot)).toEqual({
        version: 1, adapterType: "claude_local", engine: "cli",
        invocation: { firstSeq: 7, sessionIdBefore: "s-0", sessionParams: null },
        accounting: { provider: "anthropic", biller: null, model: "opus", billingType: null },
        runStart: { sessionIdBefore: "s-0", sessionDisplayId: "s-0", sessionParams: { sessionId: "s-0", cwd: "/w" } },
      });
      expect(adapterOutputRecoveryContextFromSnapshot(build(undefined))).toBeNull();
    });

    it("treats another version or a missing field as no recovery context", () => {
      const valid = { version: 1, engine: "cli", sessionIdBefore: "s-0", sessionParams: null,
        accounting: { provider: "anthropic", biller: null, model: "opus", billingType: null } } as const;
      const { accounting: _accounting, ...withoutAccounting } = valid;
      const { model: _model, ...accountingWithoutModel } = valid.accounting;
      const { sessionIdBefore: _sessionIdBefore, ...withoutSession } = valid;
      for (const recovery of [
        { ...valid, version: 2 }, withoutAccounting, withoutSession, { ...valid, accounting: accountingWithoutModel },
      ]) {
        const snapshot = build(recovery as never);
        expect(snapshot.invocation).toMatchObject({ engine: null, sessionIdBefore: null, sessionParams: null,
          accounting: { provider: null, biller: null, model: null, billingType: null } });
        expect(adapterOutputRecoveryContextFromSnapshot(snapshot)).toBeNull();
      }
      expect(build(valid).invocation).toMatchObject({ engine: "cli", sessionIdBefore: "s-0" });
    });

    // The id-less templates the Claude and Codex adapters send with each
    // invocation, through their real session codecs.
    const realTemplates = [
      {
        adapterType: "claude_local", codec: claudeSessionCodec,
        template: { cwd: "/w", promptBundleKey: "bundle-1", mcpServerIdentity: "[]", workspaceId: "ws-1",
          repoUrl: "https://example.test/repo.git", repoRef: "main" },
        provider: "anthropic",
      },
      {
        adapterType: "codex_local", codec: codexSessionCodec,
        template: { cwd: "/w", workspaceId: "ws-1", repoUrl: "https://example.test/repo.git", repoRef: "main" },
        provider: "openai",
      },
    ];
    for (const { adapterType, codec: realCodec, template, provider } of realTemplates) {
      it(`keeps the ${adapterType} invocation template on fresh, resumed and fresh-session retry invocations`, () => {
        const cases = [
          { name: "fresh", invocationNumber: 1, sessionIdBefore: null, dispatchedSessionId: null },
          { name: "resumed", invocationNumber: 1, sessionIdBefore: "s-1", dispatchedSessionId: "s-1" },
          { name: "fresh-session retry", invocationNumber: 2, sessionIdBefore: null, dispatchedSessionId: "s-1" },
        ];
        for (const entry of cases) {
          const dispatchedParams = entry.dispatchedSessionId ? { sessionId: entry.dispatchedSessionId, ...template } : null;
          const snapshot = buildLocalResultRecoverySnapshot({
            adapterType, codec: realCodec, taskKey: "task-1", configuredModel: "m",
            previousSessionParams: dispatchedParams,
            dispatched: { sessionId: entry.dispatchedSessionId, sessionDisplayId: entry.dispatchedSessionId,
              sessionParams: dispatchedParams },
            taskSessionReused: entry.dispatchedSessionId != null, rotated: false, rotationReason: null,
            sessionConfig, configFreshness: { version: 1 },
            invocationNumber: entry.invocationNumber, firstSeq: 3, startedAt: new Date("2026-10-23T00:00:00.000Z"),
            recovery: { version: 1, engine: "cli", sessionIdBefore: entry.sessionIdBefore,
              sessionParams: { ...template, apiKey: "template-secret" },
              accounting: { provider, biller: provider, model: "m", billingType: "subscription" } },
          });
          expect(snapshot.invocation.sessionParams, entry.name).toEqual(template);
          expect(JSON.stringify(snapshot), entry.name).not.toContain("template-secret");
          expect(snapshot.session.dispatched.params, entry.name).toEqual(dispatchedParams);
          expect(adapterOutputRecoveryContextFromSnapshot(snapshot)?.invocation, entry.name).toEqual({
            firstSeq: 3, sessionIdBefore: entry.sessionIdBefore, sessionParams: template,
          });
        }
      });
    }
  });
});
