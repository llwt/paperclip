import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionResult } from "@paperclipai/adapter-utils";
import { agents, companies, costEvents, createDb, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const processResult = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/execution-target", async (original) => ({
  ...await original<typeof import("@paperclipai/adapter-utils/execution-target")>(),
  ensureAdapterExecutionTargetCommandResolvable: async () => undefined,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: async () => undefined,
  resolveAdapterExecutionTargetCommandForLogs: async () => "claude",
  runAdapterExecutionTargetProcess: processResult,
}));

import { execute } from "../../../packages/adapters/claude-local/src/server/execute.js";
import { applyCapturedUsage, createRunUsageRecorder } from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { getLatestSessionUsageJson, resolveNormalizedUsageForSession } from "../services/heartbeat.js";
import { normalizeUsageTotals } from "../services/heartbeat/run-state.js";

// SX-1378 (kept through SX-2057): on --resume the Claude CLI reports
// modelUsage and total_cost_usd as session totals; only result.usage covers
// the invocation. These tests run the real adapter, usage recorder and ledger.
type Totals = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
type Result = { session?: Totals; invocation: Totals; costUsd: number };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Claude session totals through receipts and ledger", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("claude-session-usage-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function session() {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Claude session usage", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude", role: "engineer", status: "idle", adapterType: "claude_local" });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-session-usage-"));
    directories.push(dir);
    let minute = 0;
    const at = () => new Date(Date.UTC(2026, 9, 24, 12, minute++));

    async function previousRun(usageJson: Record<string, unknown>) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: "succeeded",
        sessionIdAfter: sessionId, createdAt: at(), usageJson,
      });
    }

    /** One CLI invocation in the session. Without `session` the result has no modelUsage. */
    async function run(reported: Result, options: { timedOut?: boolean } = {}) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", createdAt: at() });
      const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "claude_local" }, dir);
      const stdout = [
        { type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" },
        {
          type: "result", subtype: "success", session_id: sessionId, result: "done", total_cost_usd: reported.costUsd,
          usage: { input_tokens: reported.invocation.inputTokens, cache_read_input_tokens: reported.invocation.cachedInputTokens, output_tokens: reported.invocation.outputTokens },
          ...(reported.session ? { modelUsage: { "claude-sonnet-5": {
            inputTokens: reported.session.inputTokens, cacheReadInputTokens: reported.session.cachedInputTokens,
            outputTokens: reported.session.outputTokens, costUSD: reported.costUsd,
          } } } : {}),
        },
      ].map(record => JSON.stringify(record)).join("\n") + "\n";
      processResult.mockImplementationOnce(async (_run, _target, _command, _args, processOptions) => {
        await processOptions.onLog("stdout", stdout);
        return options.timedOut
          ? { exitCode: null, signal: "SIGTERM", timedOut: true, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() }
          : { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() };
      });
      const result = await execute({
        runId, agent: { id: agentId, companyId, name: "Claude", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command: "claude", cwd: dir, model: "claude-sonnet-5", paperclipRuntimeSkills: [],
          env: { CLAUDE_CONFIG_DIR: dir, HOME: dir, ANTHROPIC_API_KEY: "test-placeholder" } },
        context: {}, onLog: async () => {},
        onUsage: async (receipt) => { await recorder.capture(receipt); },
      } as never);
      return { runId, result, recorder };
    }

    /** What the heartbeat books for the final result, after applyCapturedUsage. */
    async function heartbeatUsage(runId: string, merged: AdapterExecutionResult) {
      return resolveNormalizedUsageForSession({
        sessionId, rawUsage: normalizeUsageTotals(merged.usage), usageBasis: merged.usageBasis ?? null,
        costBasis: merged.costBasis ?? merged.usageBasis ?? null, rawCostUsd: merged.costUsd ?? null,
        invocationUsage: normalizeUsageTotals(merged.invocationUsage),
        getPreviousUsageJson: (id) => getLatestSessionUsageJson(db, { companyId, agentId, sessionId: id, excludeRunId: runId }),
      });
    }

    async function ledger(runId: string, status: string) {
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      expect(await accountRunCost(db, runId)).toBe(true);
      return db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    }

    async function usageJson(runId: string) {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return row.usageJson;
    }

    return { sessionId, previousRun, run, heartbeatUsage, ledger, usageJson };
  }

  // The heartbeat's row for the session's last completed run.
  const baseline = {
    inputTokens: 100, cachedInputTokens: 200, outputTokens: 50, costUsd: 1,
    rawInputTokens: 100, rawInputIncludesCached: false, rawCachedInputTokens: 200, rawOutputTokens: 50, rawCostUsd: 1,
  };
  const ownPart = { inputTokens: 30, cachedInputTokens: 20, outputTokens: 10 };

  it("books only this run's part when a resumed run is lost after its result checkpoint, then resumes", async () => {
    const { sessionId, previousRun, run, heartbeatUsage, ledger, usageJson } = await session();
    await previousRun(baseline);
    const lost = await run({ session: { inputTokens: 130, cachedInputTokens: 220, outputTokens: 60 }, invocation: ownPart, costUsd: 1.5 });
    expect(await usageJson(lost.runId)).toMatchObject({
      ...ownPart, costUsd: 0.5, accountingReceiptReady: true, usageSource: "per_run",
      rawUsageSessionId: sessionId, rawInputTokens: 130, rawCachedInputTokens: 220, rawOutputTokens: 60, rawCostUsd: 1.5,
    });
    const [lostEvent] = await ledger(lost.runId, "failed");
    expect(lostEvent).toMatchObject({ ...ownPart, costCents: 50 });

    const next = await run({ session: { inputTokens: 170, cachedInputTokens: 250, outputTokens: 75 }, invocation: { inputTokens: 40, cachedInputTokens: 30, outputTokens: 15 }, costUsd: 2.25 });
    expect(next.result).toMatchObject({ usageBasis: "session_cumulative", costBasis: "session_cumulative", costUsd: 2.25 });
    const captured = await next.recorder.complete(next.result);
    expect(captured).toMatchObject({ usage: { inputTokens: 40, cachedInputTokens: 30, outputTokens: 15 }, costUsd: 0.75, rawCostUsd: 2.25, usageBasis: "per_run" });
    // Session-total parts cannot be split per model once a baseline is subtracted.
    expect(captured.usageByModel).toBeUndefined();
    // The heartbeat gets the CLI's own totals back and reaches the same part.
    const merged = applyCapturedUsage(next.result, captured);
    expect(merged).toMatchObject({ usage: { inputTokens: 170, cachedInputTokens: 250, outputTokens: 75 }, usageBasis: "session_cumulative", costBasis: "session_cumulative", costUsd: 2.25 });
    expect(merged).not.toHaveProperty("rawCostUsd");
    const resolved = await heartbeatUsage(next.runId, merged);
    expect(resolved.normalizedUsage).toEqual(captured.usage);
    expect(resolved.normalizedCostUsd).toBe(0.75);
    const [nextEvent] = await ledger(next.runId, "succeeded");
    expect(nextEvent).toMatchObject({ inputTokens: 40, cachedInputTokens: 30, outputTokens: 15, costCents: 75 });
  });

  it("books only a resumed timeout's own part", async () => {
    const { previousRun, run, heartbeatUsage, ledger } = await session();
    await previousRun(baseline);
    const { runId, result, recorder } = await run({ session: { inputTokens: 130, cachedInputTokens: 220, outputTokens: 60 }, invocation: ownPart, costUsd: 1.5 }, { timedOut: true });
    expect(result).toMatchObject({ timedOut: true, usageBasis: "session_cumulative", costBasis: "session_cumulative", invocationUsage: ownPart });
    const captured = await recorder.complete(result);
    expect(captured).toMatchObject({ usage: ownPart, costUsd: 0.5 });
    const resolved = await heartbeatUsage(runId, applyCapturedUsage(result, captured));
    expect(resolved.normalizedUsage).toEqual(ownPart);
    expect(resolved.normalizedCostUsd).toBe(0.5);
    const [event] = await ledger(runId, "timed_out");
    expect(event).toMatchObject({ ...ownPart, costCents: 50 });
  });

  it("subtracts only the session cost without modelUsage, and keeps a lost run's lower-bound baseline", async () => {
    const { sessionId, previousRun, run, heartbeatUsage, ledger, usageJson } = await session();
    await previousRun(baseline);
    // No modelUsage: tokens are this invocation's main loop, the cost is the session total.
    const lost = await run({ invocation: ownPart, costUsd: 1.5 });
    expect(await usageJson(lost.runId)).toMatchObject({
      ...ownPart, costUsd: 0.5, accountingReceiptReady: true,
      rawUsageSessionId: sessionId, rawInputTokens: 130, rawCachedInputTokens: 220, rawOutputTokens: 60, rawCostUsd: 1.5, rawUsageIncomplete: true,
    });
    const [lostEvent] = await ledger(lost.runId, "failed");
    expect(lostEvent).toMatchObject({ ...ownPart, costCents: 50 });

    // The next result has modelUsage again; the lower-bound baseline makes it
    // book its own result.usage instead of a delta.
    const invocation = { inputTokens: 40, cachedInputTokens: 30, outputTokens: 15 };
    const next = await run({ session: { inputTokens: 200, cachedInputTokens: 300, outputTokens: 90 }, invocation, costUsd: 2.25 });
    const captured = await next.recorder.complete(next.result);
    expect(captured).toMatchObject({ usage: invocation, costUsd: 0.75 });
    const resolved = await heartbeatUsage(next.runId, applyCapturedUsage(next.result, captured));
    expect(resolved.normalizedUsage).toEqual(invocation);
    expect(resolved.normalizedCostUsd).toBe(0.75);
    const [nextEvent] = await ledger(next.runId, "succeeded");
    expect(nextEvent).toMatchObject({ ...invocation, costCents: 75 });
  });

  it("subtracts only the session cost of a resumed timeout without modelUsage", async () => {
    const { previousRun, run, heartbeatUsage, ledger } = await session();
    await previousRun(baseline);
    const { runId, result, recorder } = await run({ invocation: ownPart, costUsd: 1.5 }, { timedOut: true });
    expect(result).toMatchObject({ timedOut: true, usageBasis: "per_run", costBasis: "session_cumulative" });
    const captured = await recorder.complete(result);
    expect(captured).toMatchObject({ usage: ownPart, costUsd: 0.5, sessionUsageIncomplete: true });
    const resolved = await heartbeatUsage(runId, applyCapturedUsage(result, captured));
    expect(resolved).toMatchObject({ normalizedUsage: ownPart, normalizedCostUsd: 0.5, sessionRawUsageIncomplete: true });
    const [event] = await ledger(runId, "timed_out");
    expect(event).toMatchObject({ ...ownPart, costCents: 50 });
  });

  it("keeps a fresh session's own totals and cost", async () => {
    const { run, ledger, usageJson } = await session();
    const totals = { inputTokens: 130, cachedInputTokens: 220, outputTokens: 60 };
    const lost = await run({ session: totals, invocation: totals, costUsd: 1.5 });
    expect(await usageJson(lost.runId)).toMatchObject({ ...totals, costUsd: 1.5, rawCostUsd: 1.5, accountingReceiptReady: true });
    const events = await ledger(lost.runId, "failed");
    expect(events.reduce((sum, event) => sum + event.costCents, 0)).toBe(150);
  });
});
