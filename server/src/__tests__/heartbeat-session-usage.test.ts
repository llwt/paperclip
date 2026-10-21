import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";
import { parseClaudeStreamJson } from "../../../packages/adapters/claude-local/src/server/parse.js";
import cliSessionUsage from "../../../packages/adapters/codex-local/src/server/__fixtures__/cli-session-usage.json" with { type: "json" };
import { getLatestSessionUsageJson, resolveNormalizedUsageForSession } from "../services/heartbeat.js";

function parseTurn(turn: "fresh" | "resumed") {
  return parseCodexJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "fixture-session" }),
    JSON.stringify(cliSessionUsage[turn].completed),
  ].join("\n"));
}

function requestTotals(turn: "fresh" | "resumed") {
  return cliSessionUsage[turn].requests.reduce((totals, usage) => ({
    inputTokens: totals.inputTokens + usage.input_tokens,
    cachedInputTokens: totals.cachedInputTokens + usage.cached_input_tokens,
    outputTokens: totals.outputTokens + usage.output_tokens,
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
}

describe("resolveNormalizedUsageForSession", () => {
  it("stores a fresh CLI run unchanged when there is no previous run", async () => {
    const parsed = parseTurn("fresh");
    const getPreviousUsageJson = vi.fn(async () => null);
    const result = await resolveNormalizedUsageForSession({
      sessionId: parsed.sessionId,
      rawUsage: parsed.usage,
      usageBasis: parsed.usageBasis,
      getPreviousUsageJson,
    });

    expect(result.normalizedUsage).toEqual(parsed.usage);
    expect(result.normalizedUsage).toEqual(requestTotals("fresh"));
    expect(result.derivedFromSessionTotals).toBe(false);
    expect(getPreviousUsageJson).toHaveBeenCalledWith("fixture-session");
  });

  it("stores only the resumed CLI turn's tokens, matching its nine request records", async () => {
    const parsed = parseTurn("resumed");
    const result = await resolveNormalizedUsageForSession({
      sessionId: parsed.sessionId,
      rawUsage: parsed.usage,
      usageBasis: parsed.usageBasis,
      // Legacy rows without raw fields used to store the session totals directly.
      getPreviousUsageJson: async () => parseTurn("fresh").usage,
    });

    expect(cliSessionUsage.resumed.requests).toHaveLength(9);
    expect(result.normalizedUsage).toEqual({
      inputTokens: 1_108_431,
      cachedInputTokens: 1_085_824,
      outputTokens: 3_402,
    });
    expect(result.normalizedUsage).toEqual(requestTotals("resumed"));
    expect(result.normalizedUsage!.cachedInputTokens).toBeLessThanOrEqual(result.normalizedUsage!.inputTokens);
    expect(result.derivedFromSessionTotals).toBe(true);
  });

  it("uses saved raw counters rather than the previous run's normalized counters", async () => {
    const previous = parseTurn("resumed").usage;
    const result = await resolveNormalizedUsageForSession({
      sessionId: "fixture-session",
      rawUsage: {
        inputTokens: previous.inputTokens + 100,
        cachedInputTokens: previous.cachedInputTokens + 80,
        outputTokens: previous.outputTokens + 20,
      },
      usageBasis: "session_cumulative",
      getPreviousUsageJson: async () => ({
        ...requestTotals("resumed"),
        rawInputTokens: previous.inputTokens,
        rawCachedInputTokens: previous.cachedInputTokens,
        rawOutputTokens: previous.outputTokens,
      }),
    });

    expect(result.normalizedUsage).toEqual({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 });
    expect(result.previousRawUsage).toEqual(previous);
  });

  it("keeps each new counter after a reset instead of producing negative usage", async () => {
    const rawUsage = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 };
    const result = await resolveNormalizedUsageForSession({
      sessionId: "fixture-session",
      rawUsage,
      usageBasis: "session_cumulative",
      getPreviousUsageJson: async () => parseTurn("resumed").usage,
    });

    // Existing reset policy: use the current value for each counter that decreased.
    expect(result.normalizedUsage).toEqual(rawUsage);
    expect(Object.values(result.normalizedUsage!).every((value) => value >= 0)).toBe(true);
    expect(result.normalizedUsage!.cachedInputTokens).toBeLessThanOrEqual(result.normalizedUsage!.inputTokens);
  });

  it("does not subtract session counters for Codex ACP or other per-run adapters", async () => {
    const rawUsage = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20 };
    const getPreviousUsageJson = vi.fn(async () => ({ inputTokens: 90, cachedInputTokens: 70, outputTokens: 15 }));
    const result = await resolveNormalizedUsageForSession({
      sessionId: "fixture-session",
      rawUsage,
      usageBasis: "per_run",
      getPreviousUsageJson,
    });

    expect(result.normalizedUsage).toEqual(rawUsage);
    expect(result.derivedFromSessionTotals).toBe(false);
    expect(getPreviousUsageJson).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: null, rawUsage: parseTurn("fresh").usage },
    { sessionId: "fixture-session", rawUsage: null },
  ])("skips previous usage lookup without a session or usage: %j", async (input) => {
    const getPreviousUsageJson = vi.fn(async () => null);
    const result = await resolveNormalizedUsageForSession({
      ...input,
      usageBasis: "session_cumulative",
      getPreviousUsageJson,
    });
    expect(result.normalizedUsage).toEqual(input.rawUsage);
    expect(getPreviousUsageJson).not.toHaveBeenCalled();
  });
});

// Claude CLI result events on --resume: modelUsage and total_cost_usd are the
// session totals so far, while result.usage covers only this invocation.
// Figures are synthetic but follow that shape (SX-1378).
const claudeTurns = {
  first: { input: 200_000, cacheRead: 9_000_000, output: 34_000, costUsd: 4.75, invocationOutput: 34_000 },
  resumed: { input: 213_000, cacheRead: 10_000_000, output: 37_500, costUsd: 5.25, invocationOutput: 3_500 },
};

function parseClaudeTurn(turn: keyof typeof claudeTurns, sessionId = "claude-session") {
  const figures = claudeTurns[turn];
  return parseClaudeStreamJson(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: sessionId,
    result: "done",
    total_cost_usd: figures.costUsd,
    usage: { input_tokens: 2, output_tokens: figures.invocationOutput, cache_read_input_tokens: 0 },
    modelUsage: {
      "claude-opus-5-5": {
        inputTokens: 100,
        cacheCreationInputTokens: figures.input - 100,
        cacheReadInputTokens: figures.cacheRead,
        outputTokens: figures.output,
        costUSD: figures.costUsd,
      },
    },
  }));
}

/** usage_json as the server stored it for a Claude run before SX-1378. */
function preFixClaudeUsageJson(turn: keyof typeof claudeTurns) {
  const parsed = parseClaudeTurn(turn);
  return {
    ...parsed.usage,
    rawInputTokens: parsed.usage!.inputTokens,
    rawCachedInputTokens: parsed.usage!.cachedInputTokens,
    rawOutputTokens: parsed.usage!.outputTokens,
    usageSource: "per_run",
    costUsd: parsed.costUsd,
  };
}

function resolveClaudeTurn(
  turn: keyof typeof claudeTurns,
  getPreviousUsageJson: (sessionId: string) => Promise<unknown>,
) {
  const parsed = parseClaudeTurn(turn);
  return resolveNormalizedUsageForSession({
    sessionId: parsed.sessionId,
    rawUsage: parsed.usage,
    usageBasis: parsed.usageBasis,
    costBasis: parsed.costBasis,
    rawCostUsd: parsed.costUsd,
    getPreviousUsageJson,
  });
}

/** A Claude result event without modelUsage: invocation tokens, session cost. */
function parseClaudeFallbackTurn(input: {
  inputTokens: number;
  costUsd: number;
  cacheCreationInputTokens?: number;
}) {
  return parseClaudeStreamJson(JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "claude-session",
    result: "done",
    total_cost_usd: input.costUsd,
    usage: {
      input_tokens: input.inputTokens,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      ...(input.cacheCreationInputTokens !== undefined
        ? { cache_creation_input_tokens: input.cacheCreationInputTokens }
        : {}),
    },
  }));
}

/** The usage_json fields the heartbeat stores from a resolution. */
function storedUsageJson(
  result: Awaited<ReturnType<typeof resolveNormalizedUsageForSession>>,
  rawCostUsd: number,
) {
  return {
    ...result.normalizedUsage,
    rawInputTokens: result.sessionRawUsage!.inputTokens,
    rawCachedInputTokens: result.sessionRawUsage!.cachedInputTokens,
    rawOutputTokens: result.sessionRawUsage!.outputTokens,
    costUsd: result.normalizedCostUsd,
    rawCostUsd,
  };
}

describe("resolveNormalizedUsageForSession for Claude CLI session totals", () => {
  it("labels modelUsage figures as session totals", () => {
    expect(parseClaudeTurn("resumed").usageBasis).toBe("session_cumulative");
  });

  it("stores a fresh session's full tokens and cost", async () => {
    const result = await resolveClaudeTurn("first", async () => null);
    expect(result.normalizedUsage).toEqual(parseClaudeTurn("first").usage);
    expect(result.normalizedCostUsd).toBe(4.75);
    expect(result.derivedFromSessionTotals).toBe(false);
  });

  it("stores only a resumed run's own tokens and cost against a pre-fix row", async () => {
    const result = await resolveClaudeTurn("resumed", async () => preFixClaudeUsageJson("first"));
    expect(result.normalizedUsage).toEqual({
      inputTokens: 13_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 3_500,
    });
    // The output delta matches the invocation's own result.usage block.
    expect(result.normalizedUsage!.outputTokens).toBe(claudeTurns.resumed.invocationOutput);
    expect(result.normalizedCostUsd).toBe(0.5);
    expect(result.previousRawCostUsd).toBe(4.75);
    expect(result.derivedFromSessionTotals).toBe(true);
  });

  it("subtracts the saved raw cost, not the previous run's delta cost", async () => {
    const result = await resolveClaudeTurn("resumed", async () => ({
      ...preFixClaudeUsageJson("first"),
      inputTokens: 1,
      costUsd: 0.25,
      rawCostUsd: 4.75,
      usageSource: "session_delta",
    }));
    expect(result.normalizedCostUsd).toBe(0.5);
  });

  it("stores zero for a failed run that repeats the previous session snapshot", async () => {
    const result = await resolveClaudeTurn("resumed", async () => preFixClaudeUsageJson("resumed"));
    expect(result.normalizedUsage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(result.normalizedCostUsd).toBe(0);
  });

  it("keeps the current cost if the session cost went down", async () => {
    const result = await resolveClaudeTurn("first", async () => preFixClaudeUsageJson("resumed"));
    expect(result.normalizedCostUsd).toBe(4.75);
  });

  it("deltas the session cost of a run without modelUsage and keeps the token baseline", async () => {
    const previous = {
      inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0,
      rawInputTokens: 1_000, rawCachedInputTokens: 0, rawOutputTokens: 0,
      costUsd: 4.75, rawCostUsd: 4.75,
    };
    const fallback = parseClaudeFallbackTurn({ inputTokens: 10, costUsd: 5.25 });
    expect(fallback.usageBasis).toBe("per_run");
    const fallbackResult = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: fallback.usage,
      usageBasis: fallback.usageBasis,
      costBasis: fallback.costBasis,
      rawCostUsd: fallback.costUsd,
      getPreviousUsageJson: async () => previous,
    });
    expect(fallbackResult.normalizedUsage).toEqual({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 0 });
    expect(fallbackResult.normalizedCostUsd).toBe(0.5);
    // Stored raw counters stay a session total: 1000 before plus 10 now.
    expect(fallbackResult.sessionRawUsage).toEqual({ inputTokens: 1_010, cachedInputTokens: 0, outputTokens: 0 });

    // The next run reports session totals again: input 1200, cost 5.50.
    const next = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: { inputTokens: 1_200, cachedInputTokens: 0, outputTokens: 0 },
      usageBasis: "session_cumulative",
      costBasis: "session_cumulative",
      rawCostUsd: 5.5,
      getPreviousUsageJson: async () => storedUsageJson(fallbackResult, 5.25),
    });
    expect(next.normalizedUsage!.inputTokens).toBe(190);
    expect(next.normalizedCostUsd).toBe(0.25);
    // Both resumes together add up to the session's real increment.
    expect(next.normalizedUsage!.inputTokens + fallbackResult.normalizedUsage!.inputTokens).toBe(200);
  });

  it("counts cache writes of a run without modelUsage like modelUsage does", async () => {
    const previous = {
      inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0,
      rawInputTokens: 1_000, rawCachedInputTokens: 0, rawOutputTokens: 0,
      costUsd: 4.75, rawCostUsd: 4.75,
    };
    const fallback = parseClaudeFallbackTurn({ inputTokens: 10, cacheCreationInputTokens: 100, costUsd: 5.25 });
    const fallbackResult = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: fallback.usage,
      usageBasis: fallback.usageBasis,
      costBasis: fallback.costBasis,
      rawCostUsd: fallback.costUsd,
      getPreviousUsageJson: async () => previous,
    });
    expect(fallbackResult.normalizedUsage).toEqual({ inputTokens: 110, cachedInputTokens: 0, outputTokens: 0 });
    expect(fallbackResult.sessionRawUsage).toEqual({ inputTokens: 1_110, cachedInputTokens: 0, outputTokens: 0 });

    // A failed run then reports the unchanged session snapshot through
    // modelUsage (1010 input plus 100 cache writes) and the same cost.
    const failed = parseClaudeStreamJson(JSON.stringify({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "claude-session",
      total_cost_usd: 5.25,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      modelUsage: {
        "claude-fable-5": {
          inputTokens: 1_010,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 100,
        },
      },
    }));
    const next = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: failed.usage,
      usageBasis: failed.usageBasis,
      costBasis: failed.costBasis,
      rawCostUsd: failed.costUsd,
      getPreviousUsageJson: async () => storedUsageJson(fallbackResult, 5.25),
    });
    expect(next.normalizedUsage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(next.normalizedCostUsd).toBe(0);
  });

  it("stores zero for a failed run without modelUsage that did no work", async () => {
    const failed = parseClaudeFallbackTurn({ inputTokens: 0, costUsd: 5.25 });
    const result = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: failed.usage,
      usageBasis: failed.usageBasis,
      costBasis: failed.costBasis,
      rawCostUsd: failed.costUsd,
      getPreviousUsageJson: async () => preFixClaudeUsageJson("resumed"),
    });
    expect(result.normalizedUsage).toEqual({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
    expect(result.normalizedCostUsd).toBe(0);
    expect(result.sessionRawUsage).toEqual(parseClaudeTurn("resumed").usage);
  });

  it("stores a fresh session's full cost when modelUsage is absent", async () => {
    const fresh = parseClaudeFallbackTurn({ inputTokens: 10, costUsd: 0.4 });
    const result = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: fresh.usage,
      usageBasis: fresh.usageBasis,
      costBasis: fresh.costBasis,
      rawCostUsd: fresh.costUsd,
      getPreviousUsageJson: async () => null,
    });
    expect(result.normalizedCostUsd).toBe(0.4);
    expect(result.sessionRawUsage).toEqual(fresh.usage);
  });

  it.each(["per_run", null] as const)("does not subtract cost for usage basis %s", async (usageBasis) => {
    const result = await resolveNormalizedUsageForSession({
      sessionId: "claude-session",
      rawUsage: parseClaudeTurn("resumed").usage,
      usageBasis,
      rawCostUsd: 5.25,
      getPreviousUsageJson: async () => preFixClaudeUsageJson("first"),
    });
    expect(result.normalizedCostUsd).toBe(5.25);
    expect(result.previousRawCostUsd).toBeNull();
  });
});

const postgresSupport = await getEmbeddedPostgresTestSupport();
const describePostgres = postgresSupport.supported ? describe : describe.skip;

if (!postgresSupport.supported) {
  console.warn(`Skipping session usage database tests: ${postgresSupport.reason}`);
}

describePostgres("session usage baseline lookup", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-session-usage-");
    db = createDb(database.connectionString);
  }, 20_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const excludeRunId = randomUUID();
    const beforeCreatedAt = new Date("2026-10-12T12:00:03Z");
    await db.insert(companies).values({
      id: companyId,
      name: "Usage fixture",
      issuePrefix: `U${companyId.slice(0, 8)}`,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Usage agent", adapterType: "codex_local",
    });
    const run = {
      companyId,
      agentId,
      sessionIdAfter: sessionId,
      status: "succeeded",
      createdAt: new Date("2026-10-12T12:00:00Z"),
    };
    await db.insert(heartbeatRuns).values({
      ...run,
      id: excludeRunId,
      createdAt: beforeCreatedAt,
      usageJson: parseTurn("resumed").usage,
    });
    const lookup = { companyId, agentId, sessionId, excludeRunId };
    async function resolve() {
      const parsed = parseTurn("resumed");
      return resolveNormalizedUsageForSession({
        sessionId,
        rawUsage: parsed.usage,
        usageBasis: parsed.usageBasis,
        getPreviousUsageJson: (id) => getLatestSessionUsageJson(db, { ...lookup, sessionId: id }),
      });
    }
    return { run, lookup, resolve };
  }

  it.each([
    {
      status: "failed",
      usageJson: {
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        rawInputTokens: 0, rawCachedInputTokens: 0, rawOutputTokens: 0,
      },
    },
    { status: "timed_out", usageJson: null },
  ])("uses the succeeded baseline through an intervening $status run without usable usage", async (missingRun) => {
    const { run, resolve } = await fixture();
    await db.insert(heartbeatRuns).values([
      { ...run, usageJson: parseTurn("fresh").usage },
      { ...run, ...missingRun, createdAt: new Date("2026-10-12T12:00:01Z") },
    ]);
    const result = await resolve();
    expect(result.previousRawUsage).toEqual(parseTurn("fresh").usage);
    expect(result.normalizedUsage).toEqual(requestTotals("resumed"));
    expect(result.derivedFromSessionTotals).toBe(true);
  });

  it.each([
    sql`'2026-10-12T12:00:00.000000Z'::timestamptz`,
    sql`'2026-10-12T12:00:00.123456Z'::timestamptz`,
  ])("walks batches with tied timestamps at full database precision (%s)", async (createdAt) => {
    const { run, lookup, resolve } = await fixture();
    await db.update(heartbeatRuns).set({ createdAt }).where(eq(heartbeatRuns.id, lookup.excludeRunId));
    await db.insert(heartbeatRuns).values([
      // Make the baseline sort last among rows with the same timestamp.
      { ...run, id: `00000000-0000-0000-0000-${randomUUID().slice(-12)}`, createdAt, usageJson: parseTurn("fresh").usage },
      ...Array.from({ length: 41 }, () => ({
        ...run,
        id: `ffffffff-ffff-ffff-ffff-${randomUUID().slice(-12)}`,
        status: "failed",
        usageJson: null,
        createdAt,
      })),
    ]);
    expect((await resolve()).normalizedUsage).toEqual(requestTotals("resumed"));
  });

  it("keeps usage unchanged if every earlier run has missing counters", async () => {
    const { run, resolve } = await fixture();
    await db.insert(heartbeatRuns).values({ ...run, status: "failed", usageJson: null });
    const result = await resolve();
    expect(result.normalizedUsage).toEqual(parseTurn("resumed").usage);
    expect(result.previousRawUsage).toBeNull();
    expect(result.derivedFromSessionTotals).toBe(false);
  });

  it("uses the newest usable counters even when that run failed", async () => {
    const { run, resolve } = await fixture();
    const previous = parseTurn("fresh").usage;
    await db.insert(heartbeatRuns).values([
      { ...run, usageJson: { inputTokens: 1, outputTokens: 1 } },
      {
        ...run,
        status: "failed",
        usageJson: {
          inputTokens: 1,
          rawInputTokens: previous.inputTokens,
          rawCachedInputTokens: previous.cachedInputTokens,
          rawOutputTokens: previous.outputTokens,
        },
        createdAt: new Date("2026-10-12T12:00:01Z"),
      },
    ]);
    expect((await resolve()).normalizedUsage).toEqual(requestTotals("resumed"));
  });

  it("uses the stored baseline for a cold Claude resume after a restart", async () => {
    // A new process has no in-memory state: the baseline comes only from the
    // stored rows, including one written before SX-1378.
    const { run, lookup } = await fixture();
    await db.update(heartbeatRuns).set({ usageJson: null }).where(eq(heartbeatRuns.id, lookup.excludeRunId));
    await db.insert(heartbeatRuns).values([
      { ...run, usageJson: preFixClaudeUsageJson("first") },
      // A failed run that repeated the snapshot: stored as zero, raw kept.
      {
        ...run,
        status: "failed",
        createdAt: new Date("2026-10-12T12:00:01Z"),
        usageJson: {
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
          rawInputTokens: parseClaudeTurn("first").usage!.inputTokens,
          rawCachedInputTokens: parseClaudeTurn("first").usage!.cachedInputTokens,
          rawOutputTokens: parseClaudeTurn("first").usage!.outputTokens,
          costUsd: 0,
          rawCostUsd: 4.75,
          usageSource: "session_delta",
        },
      },
    ]);
    // The parsed fixture names its own session; look up the fixture's rows.
    const result = await resolveClaudeTurn("resumed", () => getLatestSessionUsageJson(db, lookup));
    expect(result.normalizedUsage).toEqual({ inputTokens: 13_000, cachedInputTokens: 1_000_000, outputTokens: 3_500 });
    expect(result.normalizedCostUsd).toBe(0.5);
  });

  it("excludes other agents, sessions, later runs, and the current run", async () => {
    const { run, lookup, resolve } = await fixture();
    const otherCompanyId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values({ id: otherCompanyId, name: "Other usage company", issuePrefix: `U${otherCompanyId.slice(0, 8)}` });
    await db.insert(agents).values({ id: otherAgentId, companyId: otherCompanyId, name: "Other usage agent" });
    await db.insert(heartbeatRuns).values([
      { ...run, usageJson: parseTurn("fresh").usage },
      { ...run, usageJson: parseTurn("resumed").usage, createdAt: new Date("2026-10-12T12:00:01Z"), companyId: otherCompanyId, agentId: otherAgentId },
      { ...run, usageJson: parseTurn("resumed").usage, createdAt: new Date("2026-10-12T12:00:01Z"), sessionIdAfter: "other-session" },
      { ...run, usageJson: parseTurn("resumed").usage, createdAt: new Date("2026-10-12T12:00:04Z") },
    ]);
    expect((await resolve()).normalizedUsage).toEqual(requestTotals("resumed"));
    expect(await getLatestSessionUsageJson(db, { ...lookup, companyId: otherCompanyId })).toBeNull();
  });
});
