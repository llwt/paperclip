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
  runAdapterExecutionTargetProcess: processResult,
}));

import { execute } from "../../../packages/adapters/codex-local/src/server/execute.js";
import { applyCapturedUsage, createRunUsageRecorder } from "../services/usage-receipts.js";
import { accountRunCost } from "../services/run-cost-accounting.js";
import { getLatestSessionUsageJson, resolveNormalizedUsageForSession } from "../services/heartbeat.js";

// Fork #31 (SX-2057): the Codex CLI reports session totals on every resume.
// These tests run the real adapter, usage recorder and ledger on one session.
type Totals = { inputTokens: number; cachedInputTokens: number; outputTokens: number };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Codex session totals through receipts and ledger", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const directories: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("codex-session-usage-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => {
    vi.clearAllMocks();
    await db.execute(sql`TRUNCATE companies CASCADE`);
    for (const directory of directories.splice(0)) await fs.rm(directory, { force: true, recursive: true });
  });
  afterAll(async () => { await database?.cleanup(); });

  async function session() {
    const companyId = randomUUID(), agentId = randomUUID(), sessionId = `codex-${randomUUID()}`;
    await db.insert(companies).values({ id: companyId, name: "Codex session usage", issuePrefix: `C${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Codex", role: "engineer", status: "idle", adapterType: "codex_local" });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-session-usage-"));
    directories.push(dir);
    const command = path.join(dir, "codex");
    await fs.writeFile(command, "#!/bin/sh\nprintf 'codex test\\n'\n", { mode: 0o755 });
    let minute = 0;
    const at = () => new Date(Date.UTC(2026, 9, 24, 12, minute++));

    async function previousRun(usageJson: Record<string, unknown>) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(), companyId, agentId, invocationSource: "on_demand", status: "succeeded",
        sessionIdAfter: sessionId, createdAt: at(), usageJson,
      });
    }

    /** Resume the session; the CLI reports these exclusive session totals. */
    async function resume(totals: Totals, options: { timedOut?: boolean } = {}) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "on_demand", status: "running", createdAt: at() });
      const recorder = await createRunUsageRecorder(db, { companyId, runId, adapterType: "codex_local" }, dir);
      // `codex exec resume` reports the session's running totals, cache hits included in input.
      const stdout = JSON.stringify({ type: "turn.completed", usage: {
        input_tokens: totals.inputTokens + totals.cachedInputTokens,
        cached_input_tokens: totals.cachedInputTokens,
        output_tokens: totals.outputTokens,
      } }) + "\n";
      processResult.mockImplementationOnce(async (_run, _target, _command, _args, processOptions) => {
        await processOptions.onLog("stdout", stdout);
        return options.timedOut
          ? { exitCode: null, signal: "SIGTERM", timedOut: true, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() }
          : { exitCode: 0, signal: null, timedOut: false, stdout, stderr: "", pid: 123, startedAt: new Date().toISOString() };
      });
      const result = await execute({
        runId, agent: { id: agentId, companyId, name: "Codex", adapterType: "codex_local", adapterConfig: {} },
        runtime: { sessionId, sessionParams: { sessionId, cwd: dir }, sessionDisplayId: sessionId, taskKey: null },
        config: { engine: "cli", command, cwd: dir, model: "gpt-6.1-sol", paperclipRuntimeSkills: [],
          env: { XDG_CONFIG_HOME: dir, OPENAI_API_KEY: "test-placeholder" } },
        context: {}, onLog: async () => {},
        onUsage: async (receipt) => { await recorder.capture(receipt); },
      });
      return { runId, result, recorder };
    }

    /** The heartbeat's own token and cost resolution for the final result. */
    async function heartbeatUsage(runId: string, usage: Totals | undefined, costUsd: number | null | undefined, legacy = true) {
      return resolveNormalizedUsageForSession({
        sessionId, rawUsage: usage ?? null, usageBasis: "session_cumulative", costBasis: "per_run",
        rawCostUsd: costUsd ?? null, legacyRawInputIncludesCached: legacy,
        getPreviousUsageJson: (id) => getLatestSessionUsageJson(db, { companyId, agentId, sessionId: id, excludeRunId: runId }),
      });
    }

    async function ledger(runId: string, status: string) {
      await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      expect(await accountRunCost(db, runId)).toBe(true);
      return db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
    }

    return { sessionId, previousRun, resume, heartbeatUsage, ledger };
  }

  const baseline = {
    inputTokens: 200, cachedInputTokens: 800, outputTokens: 100,
    rawInputTokens: 200, rawInputIncludesCached: false, rawCachedInputTokens: 800, rawOutputTokens: 100,
  };

  it("prices and books only a resumed run's own tokens, from the parser to the ledger", async () => {
    const { previousRun, resume, heartbeatUsage, ledger } = await session();
    await previousRun(baseline);
    const { runId, result, recorder } = await resume({ inputTokens: 1_000_200, cachedInputTokens: 200_800, outputTokens: 100_100 });
    expect(result).toMatchObject({ usageBasis: "session_cumulative", billingType: "api", biller: "openai", costUsd: null });

    const captured = await recorder.complete(result);
    expect(captured).toMatchObject({
      usage: { inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000 },
      sessionUsage: { inputTokens: 1_000_200, cachedInputTokens: 200_800, outputTokens: 100_100 },
      usageBasis: "per_run", costStatus: "estimated", complete: true,
    });
    expect(Number(captured.costUsdExact)).toBe(3.02);
    // The heartbeat stores the session totals as the next baseline and gets
    // the same tokens; the receipt's price is already this run's own.
    const resolved = await heartbeatUsage(runId, captured.sessionUsage, 3.02);
    expect(resolved.normalizedUsage).toEqual(captured.usage);
    expect(resolved.sessionRawUsage).toEqual(captured.sessionUsage);
    expect(resolved.normalizedCostUsd).toBe(3.02);

    const [event] = await ledger(runId, "succeeded");
    expect(event).toMatchObject({ inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 100_000, costCents: 302, costStatus: "estimated" });
  });

  it("counts only a resumed timeout's own tokens", async () => {
    const { previousRun, resume, heartbeatUsage, ledger } = await session();
    await previousRun(baseline);
    const { runId, result, recorder } = await resume({ inputTokens: 400, cachedInputTokens: 900, outputTokens: 150 }, { timedOut: true });
    expect(result).toMatchObject({ timedOut: true, usageBasis: "session_cumulative" });

    const captured = await recorder.complete(result as AdapterExecutionResult);
    expect(captured.usage).toEqual({ inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 });
    // What the heartbeat receives: session totals for its baseline, a per-run
    // price, and no session taken from the receipt.
    const merged = applyCapturedUsage(result, captured);
    expect(merged).toMatchObject({ usage: { inputTokens: 400, cachedInputTokens: 900, outputTokens: 150 }, usageBasis: "session_cumulative", costBasis: "per_run", usageComplete: true });
    expect(merged.sessionId).toBeUndefined();
    expect(merged).not.toHaveProperty("sessionUsage");
    expect((await heartbeatUsage(runId, merged.usage, merged.costUsd)).normalizedUsage).toEqual(captured.usage);
    const [event] = await ledger(runId, "timed_out");
    expect(event).toMatchObject({ inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 });
  });

  it("books each token once when a run is lost after a checkpoint and the session resumes", async () => {
    const { previousRun, resume, heartbeatUsage, ledger } = await session();
    await previousRun(baseline);
    // The server stops after the checkpoint: no final result, no session after.
    const lost = await resume({ inputTokens: 400, cachedInputTokens: 900, outputTokens: 150 });
    const [lostRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, lost.runId));
    expect(lostRun.sessionIdAfter).toBeNull();
    expect(lostRun.usageJson).toMatchObject({ inputTokens: 200, cachedInputTokens: 100, outputTokens: 50, accountingReceiptReady: true, rawInputTokens: 400 });
    const [lostEvent] = await ledger(lost.runId, "failed");
    expect(lostEvent).toMatchObject({ inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 });

    const next = await resume({ inputTokens: 700, cachedInputTokens: 1_000, outputTokens: 200 });
    const captured = await next.recorder.complete(next.result);
    expect(captured.usage).toEqual({ inputTokens: 300, cachedInputTokens: 100, outputTokens: 50 });
    expect((await heartbeatUsage(next.runId, captured.sessionUsage, captured.costUsd)).normalizedUsage).toEqual(captured.usage);
    const [nextEvent] = await ledger(next.runId, "succeeded");
    // Together: the session's growth since the last completed run, once.
    expect(lostEvent.inputTokens + nextEvent.inputTokens).toBe(500);
    expect(lostEvent.cachedInputTokens + nextEvent.cachedInputTokens).toBe(200);
    expect(lostEvent.outputTokens + nextEvent.outputTokens).toBe(100);
  });

  it("subtracts a baseline saved before the upgrade, whose input included cache hits", async () => {
    const { previousRun, resume, heartbeatUsage } = await session();
    // Written by somnex-main before v2026.1023.0: raw Codex input, no marker.
    await previousRun({ inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 100, rawInputTokens: 1_000, rawCachedInputTokens: 800, rawOutputTokens: 100 });
    const { runId, result, recorder } = await resume({ inputTokens: 400, cachedInputTokens: 900, outputTokens: 150 });
    const captured = await recorder.complete(result);
    expect(captured.usage).toEqual({ inputTokens: 200, cachedInputTokens: 100, outputTokens: 50 });
    expect((await heartbeatUsage(runId, captured.sessionUsage, captured.costUsd)).normalizedUsage).toEqual(captured.usage);
    // Other adapters' rows keep their stored input.
    expect((await heartbeatUsage(runId, captured.sessionUsage, captured.costUsd, false)).normalizedUsage)
      .toEqual({ inputTokens: 400, cachedInputTokens: 100, outputTokens: 50 });
  });
});
