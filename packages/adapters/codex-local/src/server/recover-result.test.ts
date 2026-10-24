import { describe, expect, it } from "vitest";
import type {
  AdapterOutputRecoveryContext,
  AdapterOutputRecoveryRecord,
} from "@paperclipai/adapter-utils";
import { recoverCodexResultFromOutput } from "./recover-result.js";

const THREAD = "019a0000-0000-7000-8000-000000000001";
const OLD_THREAD = "019a0000-0000-7000-8000-000000000002";

function context(overrides: Partial<AdapterOutputRecoveryContext> = {}): AdapterOutputRecoveryContext {
  return {
    version: 1,
    adapterType: "codex_local",
    engine: "cli",
    invocation: {
      firstSeq: null,
      sessionIdBefore: null,
      sessionParams: { cwd: "/work", workspaceId: "ws-1" },
    },
    accounting: { provider: "openai", biller: "chatgpt", model: "gpt-5", billingType: "subscription" },
    runStart: { sessionIdBefore: null, sessionDisplayId: null, sessionParams: null },
    ...overrides,
  };
}

function json(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

const started = (id = THREAD) => json({ type: "thread.started", thread_id: id });
const turnStarted = json({ type: "turn.started" });
const message = (text: string) => json({ type: "item.completed", item: { type: "agent_message", text } });
const completed = (usage: unknown = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 }) =>
  json({ type: "turn.completed", ...(usage ? { usage } : {}) });
const failed = (text = "stream disconnected") => json({ type: "turn.failed", error: { message: text } });
const errorEvent = (text: string) => json({ type: "error", message: text });

function records(
  chunks: Array<string | { stream: "stdout" | "stderr"; chunk: string }>,
): AsyncIterable<AdapterOutputRecoveryRecord> {
  const list = chunks.map((entry, index) =>
    typeof entry === "string"
      ? { stream: "stdout" as const, chunk: entry, seq: index + 1 }
      : { ...entry, seq: index + 1 },
  );
  return (async function* () {
    for (const record of list) yield record;
  })();
}

async function recover(
  chunks: Array<string | { stream: "stdout" | "stderr"; chunk: string }>,
  ctx = context(),
) {
  return recoverCodexResultFromOutput({ output: records(chunks), context: ctx });
}

function expectComplete(outcome: Awaited<ReturnType<typeof recover>>) {
  if (outcome.kind !== "complete") throw new Error(`expected complete, got ${JSON.stringify(outcome)}`);
  expect(outcome.result.exitCode).toBeNull();
  expect(outcome.result.signal).toBeNull();
  expect(outcome.result.timedOut).toBe(false);
  return outcome;
}

describe("recoverCodexResultFromOutput", () => {
  it("recovers a completed turn with session totals and the final message", async () => {
    const outcome = expectComplete(
      await recover([started(), turnStarted, message("draft"), message("final answer"), completed()]),
    );
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.terminalEvent).toBe("turn.completed");
    expect(outcome.result).toMatchObject({
      errorMessage: null,
      errorCode: null,
      summary: "final answer",
      sessionId: THREAD,
      sessionDisplayId: THREAD,
      sessionParams: { sessionId: THREAD, cwd: "/work", workspaceId: "ws-1" },
      provider: "openai",
      biller: "chatgpt",
      model: "gpt-5",
      billingType: "subscription",
      costUsd: null,
      usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 9 },
      usageBasis: "session_cumulative",
      clearSession: false,
    });
  });

  it("keeps missing usage unknown instead of zero", async () => {
    const outcome = expectComplete(await recover([started(), turnStarted, message("ok"), completed(null)]));
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.result.usage).toBeUndefined();
    expect(outcome.result.usageBasis).toBeUndefined();
    expect(outcome.result.costUsd).toBeNull();
  });

  it("reassembles events split across records and ignores stderr noise", async () => {
    const line = completed();
    const cut = Math.floor(line.length / 2);
    const outcome = expectComplete(
      await recover([
        started(),
        turnStarted,
        line.slice(0, cut),
        { stream: "stderr", chunk: "WARN rollout noise\n" },
        line.slice(cut),
      ]),
    );
    expect(outcome.outcome).toBe("succeeded");
  });

  it("treats turn.failed as a provider failure with a message and a code", async () => {
    const outcome = expectComplete(await recover([started(), turnStarted, failed("model exploded")]));
    expect(outcome.outcome).toBe("failed");
    expect(outcome.terminalEvent).toBe("turn.failed");
    expect(outcome.result.errorMessage).toBe("model exploded");
    expect(outcome.result.errorCode).toBe("adapter_failed");
    expect(outcome.result.usage).toBeUndefined();
  });

  it("gives a failure without text a generic message", async () => {
    const outcome = expectComplete(await recover([started(), json({ type: "turn.failed" })]));
    expect(outcome.outcome).toBe("failed");
    expect(outcome.result.errorMessage).toBeTruthy();
    expect(outcome.result.errorCode).toBe("adapter_failed");
  });

  it("treats a final top-level error as a failure", async () => {
    const outcome = expectComplete(await recover([started(), turnStarted, errorEvent("fatal: bad request")]));
    expect(outcome.outcome).toBe("failed");
    expect(outcome.terminalEvent).toBe("error");
    expect(outcome.result.errorMessage).toBe("fatal: bad request");
  });

  it("does not take a reconnect notice for the end of the run", async () => {
    expect(await recover([started(), turnStarted, errorEvent("Reconnecting... 2/5")])).toMatchObject({
      kind: "inconclusive",
      reason: "no_terminal_event",
      observedSessionId: THREAD,
    });
  });

  it("lets a later completion resolve an earlier error", async () => {
    const outcome = expectComplete(
      await recover([started(), turnStarted, errorEvent("temporary hiccup"), message("fine"), completed()]),
    );
    expect(outcome.outcome).toBe("succeeded");
  });

  it("is inconclusive when work follows the ending or the endings conflict", async () => {
    expect(await recover([started(), turnStarted, completed(), turnStarted])).toMatchObject({
      reason: "work_after_turn_end",
    });
    expect(await recover([started(), turnStarted, failed(), completed()])).toMatchObject({
      reason: "multiple_turn_endings",
    });
    expect(await recover([started(), turnStarted, completed(), errorEvent("late failure")])).toMatchObject({
      reason: "error_after_turn_completed",
    });
    expect(await recover([started(), turnStarted, completed(), '{"type":"item.comp\n'])).toMatchObject({
      reason: "damaged_line_after_ending",
    });
  });

  it("is inconclusive without an ending or with a truncated one", async () => {
    expect(await recover([started(), turnStarted, message("working")])).toEqual({
      kind: "inconclusive",
      reason: "no_terminal_event",
      observedSessionId: THREAD,
    });
    const line = completed().trimEnd();
    expect(await recover([started(), turnStarted, line.slice(0, line.length - 8)])).toMatchObject({
      kind: "inconclusive",
      reason: "no_terminal_event",
    });
  });

  it("classifies provider quota, transient and auth failures from the error text", async () => {
    const quota = expectComplete(
      await recover([started(), failed("You've hit your usage limit for GPT-5. Switch to another model now, or try again at 3:30 PM.")]),
    );
    expect(quota.result.errorCode).toBe("provider_quota");
    expect(quota.result.errorFamily).toBe("provider_quota");
    expect(quota.result.retryNotBefore).toBeTruthy();

    const transient = expectComplete(
      await recover([started(), failed("We're currently experiencing high demand, which may cause temporary errors.")]),
    );
    expect(transient.result.errorCode).toBe("codex_transient_upstream");
    expect(transient.result.errorFamily).toBe("transient_upstream");

    const auth = expectComplete(
      await recover([started(), failed("Your refresh token was already used: refresh_token_reused")]),
    );
    expect(auth.result.errorCode).toBe("refresh_token_reused");
    expect(auth.result.errorFamily).toBe("refresh_token_reused");
  });

  describe("only the last invocation counts", () => {
    const oldRun = [started(OLD_THREAD), turnStarted, message("old"), completed()];
    const marker = `[paperclip] Codex resume session "${OLD_THREAD}" is unavailable; retrying with a fresh session.\n`;

    it("never returns the final of an invocation that was retried", async () => {
      expect(await recover([...oldRun, marker])).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
      expect(await recover([...oldRun, started()])).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
    });

    it("uses the retry's own ending", async () => {
      const outcome = expectComplete(
        await recover([...oldRun, marker, started(), turnStarted, message("new"), completed()]),
      );
      expect(outcome.result.summary).toBe("new");
      expect(outcome.result.sessionId).toBe(THREAD);
    });

    it("skips records before the invocation's first sequence", async () => {
      const ctx = context({ invocation: { ...context().invocation, firstSeq: 5 } });
      expect(await recover([...oldRun], ctx)).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
    });
  });

  it("falls back to the session before the invocation", async () => {
    const ctx = context({ invocation: { ...context().invocation, sessionIdBefore: OLD_THREAD } });
    const outcome = expectComplete(await recover([turnStarted, completed()], ctx));
    expect(outcome.result.sessionId).toBe(OLD_THREAD);
  });

  describe("clearing a stale session after a fresh-session retry", () => {
    const runStart = { sessionIdBefore: OLD_THREAD, sessionDisplayId: OLD_THREAD, sessionParams: null };

    it("clears the session when the retry's output names no thread", async () => {
      const outcome = expectComplete(await recover([turnStarted, completed()], context({ runStart })));
      expect(outcome.result).toMatchObject({ sessionId: null, sessionParams: null, clearSession: true });
      const failure = expectComplete(await recover([turnStarted, failed()], context({ runStart })));
      expect(failure.result).toMatchObject({ sessionId: null, sessionParams: null, clearSession: true });
    });

    it("keeps the session when the retry's output names a thread", async () => {
      const outcome = expectComplete(await recover([started(), turnStarted, completed()], context({ runStart })));
      expect(outcome.result).toMatchObject({ sessionId: THREAD, clearSession: false });
    });

    it("keeps the session when the invocation resumed one", async () => {
      const ctx = context({ runStart, invocation: { ...context().invocation, sessionIdBefore: OLD_THREAD } });
      const outcome = expectComplete(await recover([turnStarted, completed()], ctx));
      expect(outcome.result).toMatchObject({ sessionId: OLD_THREAD, clearSession: false });
    });

    it("keeps the session when the run started without one", async () => {
      const outcome = expectComplete(await recover([turnStarted, completed()]));
      expect(outcome.result).toMatchObject({ sessionId: null, clearSession: false });
    });
  });

  it("keeps remoteExecution from the recovery session params", async () => {
    const remoteExecution = { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote" };
    const ctx = context({ invocation: { ...context().invocation, sessionParams: { cwd: "/work", remoteExecution } } });
    const outcome = expectComplete(await recover([started(), turnStarted, completed()], ctx));
    expect(outcome.result.sessionParams).toMatchObject({ sessionId: THREAD, cwd: "/work", remoteExecution });
  });

  it("rejects ACP runs, other adapters and unknown context versions", async () => {
    expect(await recover([started(), completed()], context({ engine: "acp" }))).toEqual({
      kind: "inconclusive",
      reason: "unsupported_engine",
    });
    expect(await recover([started(), completed()], context({ adapterType: "claude_local" }))).toEqual({
      kind: "inconclusive",
      reason: "unsupported_adapter",
    });
    expect(await recover([started(), completed()], { ...context(), version: 2 as 1 })).toEqual({
      kind: "inconclusive",
      reason: "unsupported_context_version",
    });
  });

  it("is inconclusive for a single line over the size limit", async () => {
    expect(await recover([started(), "x".repeat(8 * 1024 * 1024 + 1)])).toMatchObject({
      kind: "inconclusive",
      reason: "line_too_large",
    });
  });
});
