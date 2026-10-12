import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";
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
