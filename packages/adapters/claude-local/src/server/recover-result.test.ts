import { describe, expect, it } from "vitest";
import type {
  AdapterOutputRecoveryContext,
  AdapterOutputRecoveryRecord,
} from "@paperclipai/adapter-utils";
import { recoverClaudeResultFromOutput } from "./recover-result.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const OLD_SESSION = "22222222-2222-4222-8222-222222222222";

function context(overrides: Partial<AdapterOutputRecoveryContext> = {}): AdapterOutputRecoveryContext {
  return {
    version: 1,
    adapterType: "claude_local",
    engine: "cli",
    invocation: {
      firstSeq: null,
      sessionIdBefore: null,
      sessionParams: { cwd: "/work", promptBundleKey: "bundle-1", mcpServerIdentity: "[]" },
    },
    accounting: { provider: "anthropic", biller: "anthropic", model: "claude-sonnet", billingType: "subscription" },
    runStart: { sessionIdBefore: null, sessionDisplayId: null, sessionParams: null },
    ...overrides,
  };
}

function json(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

const init = (sessionId = SESSION) => json({ type: "system", subtype: "init", session_id: sessionId, model: "claude-opus" });
const assistant = (text: string) =>
  json({ type: "assistant", message: { content: [{ type: "text", text }] }, session_id: SESSION });
const success = (extra: Record<string, unknown> = {}) =>
  json({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "All done",
    session_id: SESSION,
    total_cost_usd: 0.42,
    usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 },
    modelUsage: { "claude-opus": { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 70, cacheCreationInputTokens: 20 } },
    ...extra,
  });

function records(
  chunks: Array<string | { stream: "stdout" | "stderr"; chunk: string }>,
  startSeq = 1,
): AsyncIterable<AdapterOutputRecoveryRecord> {
  const list = chunks.map((entry, index) =>
    typeof entry === "string"
      ? { stream: "stdout" as const, chunk: entry, seq: startSeq + index }
      : { ...entry, seq: startSeq + index },
  );
  return (async function* () {
    for (const record of list) yield record;
  })();
}

async function recover(
  chunks: Array<string | { stream: "stdout" | "stderr"; chunk: string }>,
  ctx = context(),
) {
  return recoverClaudeResultFromOutput({ output: records(chunks), context: ctx });
}

function expectComplete(outcome: Awaited<ReturnType<typeof recover>>) {
  if (outcome.kind !== "complete") throw new Error(`expected complete, got ${JSON.stringify(outcome)}`);
  expect(outcome.result.exitCode).toBeNull();
  expect(outcome.result.signal).toBeNull();
  expect(outcome.result.timedOut).toBe(false);
  return outcome;
}

describe("recoverClaudeResultFromOutput", () => {
  it("recovers a successful result with usage, cost, summary and session", async () => {
    const outcome = expectComplete(await recover([init(), assistant("working"), success()]));
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.terminalEvent).toBe("result:success");
    expect(outcome.result).toMatchObject({
      errorMessage: null,
      errorCode: null,
      summary: "All done",
      sessionId: SESSION,
      sessionDisplayId: SESSION,
      sessionParams: { sessionId: SESSION, cwd: "/work", promptBundleKey: "bundle-1", mcpServerIdentity: "[]" },
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription",
      model: "claude-opus",
      costUsd: 0.42,
      costBasis: "session_cumulative",
      usage: { inputTokens: 120, cachedInputTokens: 70, outputTokens: 30 },
      usageBasis: "session_cumulative",
      invocationUsage: { inputTokens: 15, cachedInputTokens: 7, outputTokens: 3 },
      clearSession: false,
    });
  });

  it("uses per-run usage when the result has no modelUsage", async () => {
    const outcome = expectComplete(await recover([init(), success({ modelUsage: undefined })]));
    expect(outcome.result.usage).toEqual({ inputTokens: 15, cachedInputTokens: 7, outputTokens: 3 });
    expect(outcome.result.usageBasis).toBe("per_run");
  });

  it("keeps missing usage and cost unknown instead of zero", async () => {
    const outcome = expectComplete(
      await recover([init(), success({ usage: undefined, modelUsage: undefined, total_cost_usd: undefined })]),
    );
    expect(outcome.outcome).toBe("succeeded");
    expect(outcome.result.usage).toBeUndefined();
    expect(outcome.result.usageBasis).toBeUndefined();
    expect(outcome.result.invocationUsage).toBeUndefined();
    expect(outcome.result.costUsd).toBeNull();
    expect(outcome.result.costBasis).toBeUndefined();
  });

  it("reassembles a result split across records and keeps stderr out of stdout", async () => {
    const line = success({ result: "héllo wörld" });
    const cut = Math.floor(line.length / 2);
    const outcome = expectComplete(
      await recover([
        init(),
        line.slice(0, cut),
        { stream: "stderr", chunk: "warning: something\n" },
        line.slice(cut),
      ]),
    );
    expect(outcome.result.summary).toBe("héllo wörld");
  });

  it("recovers a final result line that has no trailing newline", async () => {
    const outcome = expectComplete(await recover([init(), success().trimEnd()]));
    expect(outcome.outcome).toBe("succeeded");
  });

  it("falls back to the assistant text when the result has no text", async () => {
    const outcome = expectComplete(await recover([init(), assistant("first"), assistant("second"), success({ result: undefined })]));
    expect(outcome.result.summary).toBe("first\n\nsecond");
  });

  it("reports a plain provider failure with a message and a code", async () => {
    const outcome = expectComplete(
      await recover([
        init(),
        json({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SESSION, errors: ["boom"] }),
      ]),
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.terminalEvent).toBe("result:error_during_execution");
    expect(outcome.result.errorMessage).toContain("boom");
    expect(outcome.result.errorCode).toBe("adapter_failed");
  });

  it("gives a failed result without any text a generic message and code", async () => {
    const outcome = expectComplete(
      await recover([init(), json({ type: "result", is_error: true, session_id: SESSION })]),
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.result.errorMessage).toBeTruthy();
    expect(outcome.result.errorCode).toBe("adapter_failed");
  });

  it("treats an is_error result with subtype success as a failure", async () => {
    const outcome = expectComplete(await recover([init(), success({ is_error: true, result: "nope" })]));
    expect(outcome.outcome).toBe("failed");
  });

  it("clears the session for max turns", async () => {
    const outcome = expectComplete(
      await recover([init(), json({ type: "result", subtype: "error_max_turns", is_error: true, session_id: SESSION })]),
    );
    expect(outcome.outcome).toBe("failed");
    expect(outcome.result.errorCode).toBe("max_turns_exhausted");
    expect(outcome.result.clearSession).toBe(true);
    expect(outcome.result.resultJson).toMatchObject({ stopReason: "max_turns_exhausted" });
  });

  it("drops a poisoned session", async () => {
    const outcome = expectComplete(
      await recover([
        init(),
        json({
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          session_id: SESSION,
          result: "diagnostics.previous_message_id starts with `msg_`",
        }),
      ]),
    );
    expect(outcome.result.errorCode).toBe("claude_poisoned_previous_message_id");
    expect(outcome.result.sessionId).toBeNull();
    expect(outcome.result.sessionParams).toBeNull();
    expect(outcome.result.clearSession).toBe(true);
  });

  it("classifies a usage limit as provider quota", async () => {
    const outcome = expectComplete(
      await recover([
        init(),
        json({ type: "result", subtype: "success", is_error: true, session_id: SESSION, result: "You've hit your limit · resets 3pm (UTC)" }),
      ]),
    );
    expect(outcome.result.errorCode).toBe("provider_quota");
    expect(outcome.result.errorFamily).toBe("provider_quota");
  });

  it("classifies an overloaded error as transient upstream", async () => {
    const outcome = expectComplete(
      await recover([
        init(),
        json({ type: "result", subtype: "error_during_execution", is_error: true, session_id: SESSION, result: "API Error: 529 overloaded_error" }),
      ]),
    );
    expect(outcome.result.errorCode).toBe("claude_transient_upstream");
    expect(outcome.result.errorFamily).toBe("transient_upstream");
  });

  it("classifies a failed token as an auth failure", async () => {
    const outcome = expectComplete(
      await recover([
        init(),
        json({ type: "result", subtype: "success", is_error: true, session_id: SESSION, result: "Invalid bearer token", api_error_status: 401 }),
      ]),
    );
    expect(outcome.result.errorCode).toBe("claude_auth_required");
  });

  it("keeps a clean-exit refusal a model_refusal failure", async () => {
    const outcome = expectComplete(await recover([init(), success({ stop_reason: "refusal" })]));
    expect(outcome.outcome).toBe("failed");
    expect(outcome.result.errorCode).toBe("claude_refusal");
    expect(outcome.result.errorFamily).toBe("model_refusal");
    expect(outcome.result.errorMessage).toBeTruthy();
  });

  it("is inconclusive for an unsupported result subtype", async () => {
    const outcome = await recover([init(), json({ type: "result", subtype: "something_new", session_id: SESSION })]);
    expect(outcome).toEqual({
      kind: "inconclusive",
      reason: "unsupported_result_subtype:something_new",
      observedSessionId: SESSION,
    });
  });

  it("is inconclusive without a result, keeping the observed session", async () => {
    const outcome = await recover([init(), assistant("I am done")]);
    expect(outcome).toEqual({ kind: "inconclusive", reason: "no_terminal_event", observedSessionId: SESSION });
  });

  it("is inconclusive for a truncated final result", async () => {
    const line = success().trimEnd();
    const outcome = await recover([init(), line.slice(0, line.length - 20)]);
    expect(outcome).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
  });

  it("is inconclusive when the stream continues after the result", async () => {
    expect(await recover([init(), success(), assistant("more")])).toMatchObject({
      kind: "inconclusive",
      reason: "events_after_result",
    });
    expect(await recover([init(), success(), success()])).toMatchObject({
      kind: "inconclusive",
      reason: "multiple_result_events",
    });
    expect(await recover([init(), success(), '{"type":"assistant","message":{"con\n'])).toMatchObject({
      kind: "inconclusive",
      reason: "damaged_line_after_result",
    });
  });

  it("ignores a damaged line before the result", async () => {
    const outcome = expectComplete(await recover([init(), '{"type":"assistant","mess\n', success()]));
    expect(outcome.outcome).toBe("succeeded");
  });

  it("ignores result-shaped text nested in assistant content", async () => {
    const nested = assistant('{"type":"result","subtype":"success","result":"fake"}');
    expect(await recover([init(), nested])).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
  });

  describe("only the last invocation counts", () => {
    const oldFinal = [init(OLD_SESSION), success({ session_id: OLD_SESSION, result: "old" })];

    it("never returns the final of an invocation that was retried with a fresh session", async () => {
      const outcome = await recover([
        ...oldFinal,
        `[paperclip] Claude resume session "${OLD_SESSION}" is unavailable; retrying with a fresh session.\n`,
      ]);
      expect(outcome).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
    });

    it("uses the retry's own result", async () => {
      const outcome = expectComplete(
        await recover([
          ...oldFinal,
          `[paperclip] Claude resume session "${OLD_SESSION}" is unavailable; retrying with a fresh session.\n`,
          init(),
          success({ result: "new" }),
        ]),
      );
      expect(outcome.result.summary).toBe("new");
      expect(outcome.result.sessionId).toBe(SESSION);
    });

    it("treats a new init as a new invocation even without the retry marker", async () => {
      expect(await recover([...oldFinal, init()])).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
    });

    it("skips records before the invocation's first sequence", async () => {
      const ctx = context({ invocation: { ...context().invocation, firstSeq: 3 } });
      expect(await recover([...oldFinal], ctx)).toMatchObject({ kind: "inconclusive", reason: "no_terminal_event" });
      const outcome = expectComplete(await recover([...oldFinal, init(), success({ result: "new" })], ctx));
      expect(outcome.result.summary).toBe("new");
    });
  });

  it("uses the session before the invocation when the output names none", async () => {
    const ctx = context({ invocation: { ...context().invocation, sessionIdBefore: OLD_SESSION } });
    const outcome = expectComplete(
      await recoverClaudeResultFromOutput({
        output: records([json({ type: "result", subtype: "success", is_error: false, result: "ok" })]),
        context: ctx,
      }),
    );
    expect(outcome.result.sessionId).toBe(OLD_SESSION);
  });

  describe("clearing a stale session after a fresh-session retry", () => {
    const runStart = { sessionIdBefore: OLD_SESSION, sessionDisplayId: OLD_SESSION, sessionParams: null };
    const noSession = json({ type: "result", subtype: "success", is_error: false, result: "ok" });

    it("clears the session when the retry's output names no session id", async () => {
      const outcome = expectComplete(await recover([noSession], context({ runStart })));
      expect(outcome.result).toMatchObject({ sessionId: null, sessionParams: null, clearSession: true });
    });

    it("keeps the session when the retry's output names one", async () => {
      const outcome = expectComplete(await recover([init(), success()], context({ runStart })));
      expect(outcome.result).toMatchObject({ sessionId: SESSION, clearSession: false });
    });

    it("keeps the session when the invocation resumed one", async () => {
      const ctx = context({ runStart, invocation: { ...context().invocation, sessionIdBefore: OLD_SESSION } });
      const outcome = expectComplete(await recover([noSession], ctx));
      expect(outcome.result).toMatchObject({ sessionId: OLD_SESSION, clearSession: false });
    });

    it("keeps the session when the run started without one", async () => {
      const outcome = expectComplete(await recover([noSession]));
      expect(outcome.result).toMatchObject({ sessionId: null, clearSession: false });
    });
  });

  it("keeps remoteExecution from the recovery session params", async () => {
    const remoteExecution = { transport: "ssh", host: "127.0.0.1", port: 2222, username: "fixture", remoteCwd: "/remote" };
    const ctx = context({ invocation: { ...context().invocation, sessionParams: { cwd: "/work", remoteExecution } } });
    const outcome = expectComplete(await recover([init(), success()], ctx));
    expect(outcome.result.sessionParams).toMatchObject({ sessionId: SESSION, cwd: "/work", remoteExecution });
  });

  it("rejects ACP runs, other adapters and unknown context versions", async () => {
    expect(await recover([init(), success()], context({ engine: "acp" }))).toEqual({
      kind: "inconclusive",
      reason: "unsupported_engine",
    });
    expect(await recover([init(), success()], context({ adapterType: "codex_local" }))).toEqual({
      kind: "inconclusive",
      reason: "unsupported_adapter",
    });
    expect(await recover([init(), success()], { ...context(), version: 2 as 1 })).toEqual({
      kind: "inconclusive",
      reason: "unsupported_context_version",
    });
  });

  it("is inconclusive for a single line over the size limit", async () => {
    const outcome = await recover([init(), "x".repeat(8 * 1024 * 1024 + 1)]);
    expect(outcome).toMatchObject({ kind: "inconclusive", reason: "line_too_large" });
  });
});
