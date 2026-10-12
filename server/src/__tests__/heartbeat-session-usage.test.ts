import { describe, expect, it, vi } from "vitest";
import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";
import cliSessionUsage from "../../../packages/adapters/codex-local/src/server/__fixtures__/cli-session-usage.json" with { type: "json" };
import { resolveNormalizedUsageForSession } from "../services/heartbeat.js";

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
