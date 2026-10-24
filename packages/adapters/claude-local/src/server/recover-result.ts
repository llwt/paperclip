import type {
  AdapterExecutionResult,
  AdapterOutputRecoveryInput,
  AdapterOutputRecoveryResult,
} from "@paperclipai/adapter-utils";
import {
  iterateOutputRecoveryLines,
  OutputRecoveryLineTooLargeError,
} from "@paperclipai/adapter-utils/output-recovery-lines";
import { asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  classifyClaudeTerminalResult,
  claudeModelUsageTotals,
  claudeResultUsageTotals,
  describeClaudeFailure,
  detectClaudeLoginRequired,
  extractClaudeRetryNotBefore,
  isClaudeMaxTurnsResult,
  isClaudeModelNotFoundError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeProviderQuotaError,
  isClaudeRefusalResult,
  isClaudeTransientUpstreamError,
} from "./parse.js";

const TEXT_CAP_CHARS = 256 * 1024;
const FRESH_SESSION_RETRY_RE = /^\[paperclip\] Claude resume session ".*" .*; retrying with a fresh session\.$/;

/** Collects lines up to a size cap; keepTail drops the oldest, otherwise it stops and flags overflow. */
class BoundedLines {
  private parts: string[] = [];
  private size = 0;
  overflowed = false;

  constructor(private readonly keepTail: boolean) {}

  push(line: string) {
    if (!this.keepTail && this.overflowed) return;
    this.parts.push(line);
    this.size += line.length + 1;
    if (this.size <= TEXT_CAP_CHARS) return;
    if (!this.keepTail) {
      this.overflowed = true;
      return;
    }
    while (this.size > TEXT_CAP_CHARS && this.parts.length > 1) {
      this.size -= (this.parts.shift() ?? "").length + 1;
    }
  }

  join(separator: string) {
    return this.parts.join(separator);
  }
}

interface InvocationState {
  sessionId: string | null;
  model: string;
  assistantTexts: BoundedLines;
  plainStdout: BoundedLines;
  stderr: BoundedLines;
  terminal: Record<string, unknown> | null;
  conflict: string | null;
}

function newInvocation(): InvocationState {
  return {
    sessionId: null,
    model: "",
    assistantTexts: new BoundedLines(false),
    plainStdout: new BoundedLines(true),
    stderr: new BoundedLines(true),
    terminal: null,
    conflict: null,
  };
}

function asEvent(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inconclusive(reason: string, observedSessionId?: string | null): AdapterOutputRecoveryResult {
  return observedSessionId ? { kind: "inconclusive", reason, observedSessionId } : { kind: "inconclusive", reason };
}

function applyAssistantText(state: InvocationState, event: Record<string, unknown>) {
  const message = parseObject(event.message);
  const content = Array.isArray(message.content) ? message.content : [];
  for (const entry of content) {
    const block = asEvent(entry);
    if (block && asString(block.type, "") === "text") {
      const text = asString(block.text, "");
      if (text) state.assistantTexts.push(text);
    }
  }
}

/**
 * Reads the final result of the latest Claude CLI invocation from a run's
 * persisted output. A parser only: success needs a complete top-level `result`
 * event with nothing conflicting after it; anything else is inconclusive.
 */
export async function recoverClaudeResultFromOutput(
  input: AdapterOutputRecoveryInput,
): Promise<AdapterOutputRecoveryResult> {
  const { context } = input;
  if (context.version !== 1) return inconclusive("unsupported_context_version");
  if (context.adapterType !== "claude_local") return inconclusive("unsupported_adapter");
  if (context.engine !== "cli") return inconclusive("unsupported_engine");

  let state = newInvocation();
  try {
    for await (const line of iterateOutputRecoveryLines(input.output, {
      firstSeq: context.invocation.firstSeq,
    })) {
      const text = line.text.trim();
      if (!text) continue;

      if (line.stream === "stderr") {
        state.stderr.push(text);
        continue;
      }

      if (text.startsWith("[paperclip]")) {
        // A fresh-session retry starts a new child, so nothing seen so far counts.
        if (FRESH_SESSION_RETRY_RE.test(text)) state = newInvocation();
        continue;
      }

      const event = asEvent(parseJson(text));
      if (!event) {
        // A JSON-looking line that does not parse is damaged output; after the
        // result it may have been the real ending.
        if (text.startsWith("{")) {
          if (state.terminal) state.conflict ??= "damaged_line_after_result";
        } else {
          state.plainStdout.push(text);
        }
        continue;
      }

      const type = asString(event.type, "");
      if (type === "system" && asString(event.subtype, "") === "init") {
        state = newInvocation();
        state.sessionId = asString(event.session_id, "") || null;
        state.model = asString(event.model, "");
        continue;
      }

      if (type === "result") {
        if (state.terminal) state.conflict ??= "multiple_result_events";
        else state.terminal = event;
        state.sessionId = asString(event.session_id, state.sessionId ?? "") || state.sessionId;
        continue;
      }

      if (type === "assistant" || type === "user" || type === "stream_event") {
        if (state.terminal) {
          state.conflict ??= "events_after_result";
          continue;
        }
        if (type === "assistant") {
          state.sessionId = asString(event.session_id, state.sessionId ?? "") || state.sessionId;
          applyAssistantText(state, event);
        }
      }
    }
  } catch (error) {
    if (error instanceof OutputRecoveryLineTooLargeError) return inconclusive("line_too_large", state.sessionId);
    throw error;
  }

  if (!state.terminal) return inconclusive("no_terminal_event", state.sessionId);
  if (state.conflict) return inconclusive(state.conflict, state.sessionId);

  const parsed = state.terminal;
  const verdict = classifyClaudeTerminalResult(parsed);
  if (verdict.verdict === "unsupported") {
    return inconclusive(`unsupported_result_subtype:${verdict.subtype || "none"}`, state.sessionId);
  }

  const failed = verdict.verdict === "failed";
  const hardFailed = failed && !verdict.refusalOnly;
  const stdout = state.plainStdout.join("\n");
  const stderr = state.stderr.join("\n");
  const subtype = asString(parsed.subtype, "").trim();

  const loginMeta = detectClaudeLoginRequired({ parsed, stdout, stderr });
  const maxTurns = isClaudeMaxTurnsResult(parsed);
  const poisoned = isClaudePoisonedPreviousMessageIdError(parsed);
  const refusal = isClaudeRefusalResult(parsed);
  const errorMessage = !failed
    ? null
    : hardFailed
    ? describeClaudeFailure(parsed) ?? "Claude reported a failed result"
    : "Claude declined the request (model refusal)";
  const classifyInput = { parsed, stdout, stderr, errorMessage };
  const providerQuota =
    hardFailed && !loginMeta.requiresLogin && !maxTurns && !poisoned && isClaudeProviderQuotaError(classifyInput);
  const transientUpstream =
    hardFailed &&
    !loginMeta.requiresLogin &&
    !maxTurns &&
    !poisoned &&
    !providerQuota &&
    isClaudeTransientUpstreamError(classifyInput);
  const retryNotBefore =
    providerQuota || transientUpstream ? extractClaudeRetryNotBefore(classifyInput) : null;

  const errorCode = !failed
    ? null
    : loginMeta.requiresLogin
    ? "claude_auth_required"
    : hardFailed && isClaudeModelNotFoundError(classifyInput)
    ? "model_not_found"
    : hardFailed && maxTurns
    ? "max_turns_exhausted"
    : hardFailed && poisoned
    ? "claude_poisoned_previous_message_id"
    : providerQuota
    ? "provider_quota"
    : transientUpstream
    ? "claude_transient_upstream"
    : refusal
    ? "claude_refusal"
    : "adapter_failed";
  const errorFamily = providerQuota
    ? ("provider_quota" as const)
    : transientUpstream
    ? ("transient_upstream" as const)
    : refusal
    ? ("model_refusal" as const)
    : null;

  const sessionId = poisoned
    ? null
    : state.sessionId ?? (asString(parsed.session_id, "") || context.invocation.sessionIdBefore);
  const sessionParams = sessionId
    ? { ...(context.invocation.sessionParams ?? {}), sessionId }
    : null;

  const modelUsageTotals = claudeModelUsageTotals(parsed.modelUsage);
  const hasResultUsage = Object.keys(parseObject(parsed.usage)).length > 0;
  const invocationUsage = hasResultUsage ? claudeResultUsageTotals(parsed.usage) : null;
  const usage = modelUsageTotals ?? invocationUsage;
  const costRaw = parsed.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;

  const resultText = asString(parsed.result, "").trim();
  const summary = resultText || (state.assistantTexts.overflowed ? "" : state.assistantTexts.join("\n\n").trim());
  const model = state.model || asString(parsed.model, "") || context.accounting.model;

  const resultJson: Record<string, unknown> = {
    ...parsed,
    ...(failed && maxTurns ? { stopReason: "max_turns_exhausted" } : {}),
    ...(failed && poisoned ? { stopReason: "claude_poisoned_previous_message_id" } : {}),
    ...(refusal ? { stopReason: "refusal", errorFamily: "model_refusal" } : {}),
    ...(errorFamily ? { errorFamily } : {}),
    ...(retryNotBefore
      ? { retryNotBefore: retryNotBefore.toISOString(), transientRetryNotBefore: retryNotBefore.toISOString() }
      : {}),
    ...(providerQuota && retryNotBefore ? { providerQuotaRetryNotBefore: retryNotBefore.toISOString() } : {}),
  };

  const result: AdapterExecutionResult = {
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage,
    errorCode,
    errorFamily,
    retryNotBefore: retryNotBefore ? retryNotBefore.toISOString() : null,
    ...(usage ? { usage } : {}),
    ...(usage ? { usageBasis: modelUsageTotals ? ("session_cumulative" as const) : ("per_run" as const) } : {}),
    ...(costUsd !== null ? { costBasis: "session_cumulative" as const } : {}),
    ...(invocationUsage ? { invocationUsage } : {}),
    sessionId,
    sessionParams,
    sessionDisplayId: sessionId,
    provider: context.accounting.provider,
    biller: context.accounting.biller,
    model: model || null,
    billingType: context.accounting.billingType,
    costUsd,
    resultJson,
    summary,
    // Same as execute(): a fresh-session retry that never produced a session id leaves the old session stale.
    clearSession:
      maxTurns ||
      poisoned ||
      (!sessionId && context.invocation.sessionIdBefore === null && context.runStart.sessionIdBefore !== null),
  };

  return {
    kind: "complete",
    outcome: failed ? "failed" : "succeeded",
    result,
    terminalEvent: `result:${subtype || "unknown"}`,
  };
}
