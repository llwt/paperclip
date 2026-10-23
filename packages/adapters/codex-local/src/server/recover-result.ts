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
  classifyCodexAuthRefreshFailure,
  extractCodexRetryNotBefore,
  isCodexProviderQuotaError,
  isCodexReconnectNotice,
  isCodexTransientUpstreamError,
  readCodexTurnUsage,
} from "./parse.js";

const STDERR_CAP_CHARS = 64 * 1024;
const FRESH_SESSION_RETRY_RE = /^\[paperclip\] Codex resume session ".*" .*; retrying with a fresh session\.$/;

type Terminal =
  | { kind: "completed"; event: Record<string, unknown>; usage: ReturnType<typeof readCodexTurnUsage> }
  | { kind: "failed"; event: Record<string, unknown>; message: string };

interface InvocationState {
  sessionId: string | null;
  finalMessage: string | null;
  terminal: Terminal | null;
  /** Latest top-level `error` event that is not a reconnect notice. */
  lastError: { event: Record<string, unknown>; message: string } | null;
  conflict: string | null;
  stderr: string[];
  stderrSize: number;
}

function newInvocation(): InvocationState {
  return {
    sessionId: null,
    finalMessage: null,
    terminal: null,
    lastError: null,
    conflict: null,
    stderr: [],
    stderrSize: 0,
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

/**
 * Reads the final result of the latest Codex CLI invocation from a run's
 * persisted output. A parser only: `turn.completed` is success, `turn.failed`
 * or a final top-level `error` is failure, and anything missing, conflicting
 * or later than the ending is inconclusive.
 */
export async function recoverCodexResultFromOutput(
  input: AdapterOutputRecoveryInput,
): Promise<AdapterOutputRecoveryResult> {
  const { context } = input;
  if (context.version !== 1) return inconclusive("unsupported_context_version");
  if (context.adapterType !== "codex_local") return inconclusive("unsupported_adapter");
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
        state.stderrSize += text.length + 1;
        while (state.stderrSize > STDERR_CAP_CHARS && state.stderr.length > 1) {
          state.stderrSize -= (state.stderr.shift() ?? "").length + 1;
        }
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
        // ending it may have been a later event.
        if (text.startsWith("{") && (state.terminal || state.lastError)) {
          state.conflict ??= "damaged_line_after_ending";
        }
        continue;
      }

      const type = asString(event.type, "");
      if (type === "thread.started") {
        state = newInvocation();
        state.sessionId = asString(event.thread_id, "") || null;
        continue;
      }

      if (type === "turn.started" || type.startsWith("item.")) {
        if (state.terminal) {
          state.conflict ??= "work_after_turn_end";
          continue;
        }
        // Work after an `error` event means that error was not the end.
        state.lastError = null;
        if (type === "turn.started") {
          state.finalMessage = null;
        } else if (type === "item.completed") {
          const item = parseObject(event.item);
          if (asString(item.type, "") === "agent_message") {
            const message = asString(item.text, "");
            if (message) state.finalMessage = message;
          }
        }
        continue;
      }

      if (type === "turn.completed" || type === "turn.failed") {
        if (state.terminal) {
          state.conflict ??= "multiple_turn_endings";
          continue;
        }
        if (type === "turn.completed") {
          // An earlier `error` was resolved by this successful ending.
          state.lastError = null;
          state.terminal = { kind: "completed", event, usage: readCodexTurnUsage(event) };
        } else {
          const message = asString(parseObject(event.error).message, "").trim();
          state.terminal = { kind: "failed", event, message };
        }
        continue;
      }

      if (type === "error") {
        const message = asString(event.message, "").trim();
        if (isCodexReconnectNotice(message)) continue;
        if (state.terminal?.kind === "completed") {
          state.conflict ??= "error_after_turn_completed";
          continue;
        }
        state.lastError = { event, message };
      }
    }
  } catch (error) {
    if (error instanceof OutputRecoveryLineTooLargeError) return inconclusive("line_too_large", state.sessionId);
    throw error;
  }

  if (state.conflict) return inconclusive(state.conflict, state.sessionId);
  const ending = state.terminal ?? null;
  if (!ending && !state.lastError) return inconclusive("no_terminal_event", state.sessionId);

  const sessionId = state.sessionId ?? context.invocation.sessionIdBefore;
  const sessionParams = sessionId ? { ...(context.invocation.sessionParams ?? {}), sessionId } : null;
  // Same as execute(): a fresh-session retry that never produced a session id leaves the old session stale.
  const clearSession =
    !sessionId && context.invocation.sessionIdBefore === null && context.runStart.sessionIdBefore !== null;
  const base = {
    exitCode: null,
    signal: null,
    timedOut: false,
    sessionId,
    sessionParams,
    sessionDisplayId: sessionId,
    provider: context.accounting.provider,
    biller: context.accounting.biller,
    model: context.accounting.model,
    billingType: context.accounting.billingType,
    costUsd: null,
    summary: state.finalMessage?.trim() ?? "",
  } satisfies Partial<AdapterExecutionResult>;

  if (ending?.kind === "completed") {
    const usage = ending.usage;
    return {
      kind: "complete",
      outcome: "succeeded",
      terminalEvent: "turn.completed",
      result: {
        ...base,
        errorMessage: null,
        errorCode: null,
        errorFamily: null,
        retryNotBefore: null,
        ...(usage ? { usage, usageBasis: "session_cumulative" as const } : {}),
        resultJson: { terminalEvent: ending.event },
        clearSession,
      },
    };
  }

  const failure =
    ending?.kind === "failed"
      ? { event: ending.event, message: ending.message || state.lastError?.message || "", name: "turn.failed" }
      : { event: state.lastError!.event, message: state.lastError!.message, name: "error" };
  const errorMessage = failure.message || "Codex reported a failed turn";
  const stderr = state.stderr.join("\n");
  const classifyInput = { stderr, errorMessage };
  const authRefreshFailure = classifyCodexAuthRefreshFailure(classifyInput);
  const providerQuota = !authRefreshFailure && isCodexProviderQuotaError(classifyInput);
  const transientUpstream = !authRefreshFailure && !providerQuota && isCodexTransientUpstreamError(classifyInput);
  const retryNotBefore = extractCodexRetryNotBefore(classifyInput);
  const errorFamily =
    authRefreshFailure ?? (providerQuota ? "provider_quota" : transientUpstream ? "transient_upstream" : null);
  const errorCode =
    authRefreshFailure ??
    (providerQuota ? "provider_quota" : transientUpstream ? "codex_transient_upstream" : "adapter_failed");

  return {
    kind: "complete",
    outcome: "failed",
    terminalEvent: failure.name,
    result: {
      ...base,
      errorMessage,
      errorCode,
      errorFamily,
      retryNotBefore: retryNotBefore ? retryNotBefore.toISOString() : null,
      resultJson: {
        terminalEvent: failure.event,
        ...(errorFamily ? { errorFamily } : {}),
        ...(retryNotBefore
          ? { retryNotBefore: retryNotBefore.toISOString(), transientRetryNotBefore: retryNotBefore.toISOString() }
          : {}),
        ...(providerQuota && retryNotBefore ? { providerQuotaRetryNotBefore: retryNotBefore.toISOString() } : {}),
      },
      clearSession,
    },
  };
}
