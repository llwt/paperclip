import { createHash } from "node:crypto";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents } from "@paperclipai/db";
import type {
  AdapterExecutionResult,
  AdapterOutputRecoveryRecord,
  AdapterOutputRecoveryResult,
  ServerAdapterModule,
} from "../adapters/types.js";
import {
  adapterOutputRecoveryContextFromSnapshot,
  readLocalResultRecoverySnapshot,
  type LocalResultRecoverySnapshot,
} from "./heartbeat/local-result-recovery.js";
import type { RunLogStore } from "./run-log-store.js";

// Reads what a run whose parent process was lost left behind: its persisted
// run log (output) and the tail's completion receipt. Nothing here decides
// whether the run succeeded; an adapter hook parses the provider output.

export const ADOPTED_OUTPUT_MAX_LINE_BYTES = 8 * 1024 * 1024;
// A persisted outer record holds one chunk of at most 64 KiB chars. Escaping
// can multiply that, so the outer cap is far above any record the tail or the
// runner writes and only stops a damaged file from growing the buffer.
const ADOPTED_OUTPUT_MAX_OUTER_LINE_BYTES = 2 * ADOPTED_OUTPUT_MAX_LINE_BYTES;
const ADOPTED_OUTPUT_PAGE_BYTES = 1024 * 1024;

// Marker written by heartbeat.ts compactRunLogChunk when it drops the middle
// of a chunk. It always sits on its own line, so a provider line that merely
// quotes the text (escaped newlines inside JSON) does not match.
const TRUNCATED_CHUNK_MARKER = /\n\[paperclip truncated run log chunk: omitted \d+ chars\]\n/;

export type AdoptedRunOutputInconclusiveReason =
  | "identity_mismatch"
  | "log_unavailable"
  | "malformed_outer_record"
  | "conflicting_duplicate_sequence"
  | "sequence_gap"
  | "compaction_marker"
  | "over_limit_line"
  | "unterminated_final_line";

export class AdoptedRunOutputInconclusiveError extends Error {
  constructor(
    readonly reason: AdoptedRunOutputInconclusiveReason,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "AdoptedRunOutputInconclusiveError";
  }
}

export interface AdoptedRunIdentity {
  companyId: string;
  agentId: string;
  runId: string;
}

// The persisted heartbeat_runs columns the reader needs.
export interface AdoptedRunLogRow {
  id: string;
  companyId: string;
  agentId: string;
  logStore: string | null;
  logRef: string | null;
}

export type AdoptedRunOutputReadOutcome =
  | { kind: "intact"; records: number; lastSeq: number | null }
  | { kind: "inconclusive"; reason: AdoptedRunOutputInconclusiveReason; detail?: string };

export interface AdoptedRunOutputReader {
  /** Complete provider lines in log order, per stream. Single use. */
  output: AsyncIterable<AdapterOutputRecoveryRecord>;
  /**
   * Reads whatever the consumer left unread, then says whether the whole log
   * was intact. A hook that returns early or swallows an error from `output`
   * cannot make a damaged log look complete.
   */
  settle(): Promise<AdoptedRunOutputReadOutcome>;
}

export interface OpenAdoptedRunOutputInput {
  runLogStore: RunLogStore;
  run: AdoptedRunLogRow;
  expected: AdoptedRunIdentity;
  /** First seq to read (default 1); records below it are skipped and the first kept record must be this seq. */
  fromSeq?: number;
  limits?: {
    pageBytes?: number;
    maxLineBytes?: number;
    maxOuterLineBytes?: number;
  };
}

// Mirrors the segment sanitizing of RunLogStore.begin, which names the file.
function expectedLogRef(identity: AdoptedRunIdentity) {
  const safe = (segment: string) => segment.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(safe(identity.companyId), safe(identity.agentId), `${safe(identity.runId)}.ndjson`);
}

function checkIdentity(run: AdoptedRunLogRow, expected: AdoptedRunIdentity) {
  if (run.id !== expected.runId) {
    throw new AdoptedRunOutputInconclusiveError("identity_mismatch", "run id");
  }
  if (run.companyId !== expected.companyId) {
    throw new AdoptedRunOutputInconclusiveError("identity_mismatch", "company id");
  }
  if (run.agentId !== expected.agentId) {
    throw new AdoptedRunOutputInconclusiveError("identity_mismatch", "agent id");
  }
  if (run.logStore !== "local_file" || !run.logRef) {
    throw new AdoptedRunOutputInconclusiveError("log_unavailable", "run has no readable log");
  }
  if (run.logRef !== expectedLogRef(expected)) {
    throw new AdoptedRunOutputInconclusiveError("identity_mismatch", "log reference");
  }
}

interface OuterRecord {
  stream: "stdout" | "stderr" | "system";
  chunk: string;
  seq: number;
}

function parseOuterRecord(line: string): OuterRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new AdoptedRunOutputInconclusiveError("malformed_outer_record", "not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdoptedRunOutputInconclusiveError("malformed_outer_record", "not an object");
  }
  const record = value as Record<string, unknown>;
  const { stream, chunk, seq } = record;
  if (stream !== "stdout" && stream !== "stderr" && stream !== "system") {
    throw new AdoptedRunOutputInconclusiveError("malformed_outer_record", "stream");
  }
  if (typeof chunk !== "string") {
    throw new AdoptedRunOutputInconclusiveError("malformed_outer_record", "chunk");
  }
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new AdoptedRunOutputInconclusiveError("malformed_outer_record", "seq");
  }
  return { stream, chunk, seq };
}

// Splits the log into outer JSONL lines. Pages are cut at the last newline, so
// a line split across a page, and a UTF-8 character split by the byte-ranged
// read, are read again whole from the next page.
async function* readOuterLines(
  runLogStore: RunLogStore,
  logRef: string,
  limits: { pageBytes: number; maxOuterLineBytes: number },
): AsyncGenerator<string> {
  const handle = { store: "local_file" as const, logRef };
  let offset = 0;
  let limitBytes = limits.pageBytes;
  for (;;) {
    const page = await runLogStore.read(handle, { offset, limitBytes });
    const text = page.content;
    if (page.nextOffset === undefined) {
      for (const line of text.split("\n")) {
        if (line.length > 0) yield line;
      }
      return;
    }
    const cut = text.lastIndexOf("\n");
    if (cut === -1) {
      if (limitBytes >= limits.maxOuterLineBytes) {
        throw new AdoptedRunOutputInconclusiveError("over_limit_line", "outer record");
      }
      limitBytes = Math.min(limitBytes * 2, limits.maxOuterLineBytes);
      continue;
    }
    const consumed = text.slice(0, cut + 1);
    for (const line of consumed.split("\n")) {
      if (line.length > 0) yield line;
    }
    offset += Buffer.byteLength(consumed, "utf8");
    limitBytes = limits.pageBytes;
  }
}

function digestRecord(record: OuterRecord) {
  return createHash("sha1").update(record.stream).update("\0").update(record.chunk).digest("base64");
}

export function openAdoptedRunOutput(input: OpenAdoptedRunOutputInput): AdoptedRunOutputReader {
  const pageBytes = input.limits?.pageBytes ?? ADOPTED_OUTPUT_PAGE_BYTES;
  const maxLineBytes = input.limits?.maxLineBytes ?? ADOPTED_OUTPUT_MAX_LINE_BYTES;
  const maxOuterLineBytes = Math.max(
    input.limits?.maxOuterLineBytes ?? ADOPTED_OUTPUT_MAX_OUTER_LINE_BYTES,
    pageBytes,
  );
  // The log writers in heartbeat.ts number the first record of a run 1.
  const firstSeq = input.fromSeq ?? 1;

  let failure: AdoptedRunOutputInconclusiveError | null = null;
  let records = 0;
  let lastSeq: number | null = null;
  let finished = false;

  async function* scan(): AsyncGenerator<AdapterOutputRecoveryRecord> {
    checkIdentity(input.run, input.expected);
    const pending = {
      stdout: { parts: [] as string[], bytes: 0 },
      stderr: { parts: [] as string[], bytes: 0 },
    };
    // One digest per seq, so memory grows with the record count.
    const seen = new Map<number, string>();
    let previousSeq: number | null = null;

    for await (const line of readOuterLines(input.runLogStore, input.run.logRef!, {
      pageBytes,
      maxOuterLineBytes,
    })) {
      const outer = parseOuterRecord(line);
      if (outer.seq < firstSeq) continue;

      const digest = digestRecord(outer);
      if (previousSeq !== null && outer.seq <= previousSeq) {
        // Every seq in [firstSeq, previousSeq] was seen: records are contiguous.
        const earlier = seen.get(outer.seq);
        if (earlier !== digest) {
          throw new AdoptedRunOutputInconclusiveError("conflicting_duplicate_sequence", `seq ${outer.seq}`);
        }
        continue;
      }
      if (previousSeq === null && outer.seq !== firstSeq) {
        throw new AdoptedRunOutputInconclusiveError(
          "sequence_gap",
          `first record is seq ${outer.seq}, expected seq ${firstSeq}`,
        );
      }
      if (previousSeq !== null && outer.seq !== previousSeq + 1) {
        throw new AdoptedRunOutputInconclusiveError("sequence_gap", `after seq ${previousSeq}`);
      }
      seen.set(outer.seq, digest);
      previousSeq = outer.seq;
      lastSeq = outer.seq;

      if (TRUNCATED_CHUNK_MARKER.test(outer.chunk)) {
        throw new AdoptedRunOutputInconclusiveError("compaction_marker", `seq ${outer.seq}`);
      }
      if (outer.stream === "system") continue;

      const buffer = pending[outer.stream];
      let start = 0;
      for (;;) {
        const newline = outer.chunk.indexOf("\n", start);
        if (newline === -1) break;
        const segment = outer.chunk.slice(start, newline + 1);
        const bytes = buffer.bytes + Buffer.byteLength(segment, "utf8") - 1;
        if (bytes > maxLineBytes) {
          throw new AdoptedRunOutputInconclusiveError("over_limit_line", `${outer.stream} seq ${outer.seq}`);
        }
        const text = buffer.parts.length > 0 ? buffer.parts.join("") + segment : segment;
        buffer.parts = [];
        buffer.bytes = 0;
        start = newline + 1;
        records += 1;
        yield { stream: outer.stream, chunk: text, seq: outer.seq };
      }
      if (start < outer.chunk.length) {
        const rest = start === 0 ? outer.chunk : outer.chunk.slice(start);
        buffer.parts.push(rest);
        buffer.bytes += Buffer.byteLength(rest, "utf8");
        if (buffer.bytes > maxLineBytes) {
          throw new AdoptedRunOutputInconclusiveError("over_limit_line", `${outer.stream} seq ${outer.seq}`);
        }
      }
    }

    for (const stream of ["stdout", "stderr"] as const) {
      if (pending[stream].bytes > 0) {
        throw new AdoptedRunOutputInconclusiveError("unterminated_final_line", stream);
      }
    }
  }

  const iterator = scan();
  const advance = async () => {
    try {
      const step = await iterator.next();
      if (step.done) finished = true;
      return step;
    } catch (error) {
      finished = true;
      failure ??=
        error instanceof AdoptedRunOutputInconclusiveError
          ? error
          : new AdoptedRunOutputInconclusiveError(
              "log_unavailable",
              error instanceof Error ? error.message : String(error),
            );
      throw failure;
    }
  };

  return {
    // No return(): leaving a for-await loop early must not end the scan, so
    // settle() can still read the rest.
    output: {
      [Symbol.asyncIterator]: () => ({
        next: () => (finished && failure ? Promise.reject(failure) : advance()),
      }),
    },
    async settle() {
      while (!finished) {
        try {
          await advance();
        } catch {
          break;
        }
      }
      if (failure) {
        return { kind: "inconclusive", reason: failure.reason, detail: failure.detail };
      }
      return { kind: "intact", records, lastSeq };
    },
  };
}

// ---------------------------------------------------------------------------
// Tail completion receipt
// ---------------------------------------------------------------------------

// Messages and payload of the lifecycle events the adopted-output tail in
// heartbeat.ts writes when it stops. This is the one place that reads them.
export const ADOPTED_OUTPUT_DRAINED_MESSAGE = "Child output relay reached the end of the child's output";
export const ADOPTED_OUTPUT_STOPPED_EARLY_MESSAGE =
  "Child output relay stopped before the end of the child's output; later output is not captured";
const ADOPTED_OUTPUT_GAVE_UP_REASON = "output_tail_failed";

export interface AdoptedRunLifecycleEvent {
  seq: number;
  level: string | null;
  message: string | null;
  payload: Record<string, unknown> | null;
}

export interface AdoptedOutputReceiptScope extends AdoptedRunIdentity {
  /** When known, events of another relay do not count. */
  relayPid?: number;
}

export type AdoptedOutputReceipt =
  | { kind: "drained"; eventSeq: number }
  | { kind: "stopped_early"; eventSeq: number }
  | { kind: "gave_up"; eventSeq: number }
  | { kind: "absent" };

// Only the latest tail ending counts: a give-up followed by a later full drain
// of the same relay files is a receipt, a drain followed by a give-up is not.
export function classifyAdoptedOutputReceipt(
  events: readonly AdoptedRunLifecycleEvent[],
  relayPid?: number,
): AdoptedOutputReceipt {
  let latest: AdoptedOutputReceipt = { kind: "absent" };
  let latestSeq = -Infinity;
  for (const event of events) {
    if (event.seq <= latestSeq) continue;
    const payload = event.payload ?? {};
    let kind: "drained" | "stopped_early" | "gave_up" | null = null;
    if (event.level === "info" && event.message === ADOPTED_OUTPUT_DRAINED_MESSAGE) {
      kind = "drained";
    } else if (event.level === "warn" && event.message === ADOPTED_OUTPUT_STOPPED_EARLY_MESSAGE) {
      kind = "stopped_early";
    } else if (event.level === "warn" && payload.reason === ADOPTED_OUTPUT_GAVE_UP_REASON) {
      kind = "gave_up";
    }
    if (!kind) continue;
    if (
      kind !== "gave_up" &&
      relayPid !== undefined &&
      payload.relayPid !== undefined &&
      payload.relayPid !== null &&
      payload.relayPid !== relayPid
    ) {
      continue;
    }
    latest = { kind, eventSeq: event.seq };
    latestSeq = event.seq;
  }
  return latest;
}

export async function listAdoptedRunLifecycleEvents(
  db: Db,
  scope: AdoptedRunIdentity,
): Promise<AdoptedRunLifecycleEvent[]> {
  const rows = await db
    .select({
      seq: heartbeatRunEvents.seq,
      level: heartbeatRunEvents.level,
      message: heartbeatRunEvents.message,
      payload: heartbeatRunEvents.payload,
    })
    .from(heartbeatRunEvents)
    .where(
      and(
        eq(heartbeatRunEvents.companyId, scope.companyId),
        eq(heartbeatRunEvents.agentId, scope.agentId),
        eq(heartbeatRunEvents.runId, scope.runId),
        eq(heartbeatRunEvents.eventType, "lifecycle"),
      ),
    )
    .orderBy(asc(heartbeatRunEvents.seq));
  return rows.map((row) => ({
    seq: row.seq,
    level: row.level,
    message: row.message,
    payload:
      row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (row.payload as Record<string, unknown>)
        : null,
  }));
}

export async function readAdoptedOutputReceipt(
  db: Db,
  scope: AdoptedOutputReceiptScope,
): Promise<AdoptedOutputReceipt> {
  const events = await listAdoptedRunLifecycleEvents(db, scope);
  return classifyAdoptedOutputReceipt(events, scope.relayPid);
}

// ---------------------------------------------------------------------------
// Deciding the result of an adopted run from its output
// ---------------------------------------------------------------------------

// Why a run was not finalized from its output. Each stays a process_lost run
// with the existing one-retry rule; the reason only says why.
export type AdoptedResultFallbackReason =
  | "not_adopted"
  | "snapshot_unavailable"
  | "adapter_changed"
  | "adapter_unavailable"
  | "no_recovery_hook"
  | "no_recovery_context"
  | "output_not_captured"
  | "tail_not_drained"
  | "tail_stopped_early"
  | "tail_gave_up"
  | "log_inconclusive"
  | "hook_error"
  | "hook_inconclusive"
  | "unexpected_result"
  | "finalization_error";

export interface AdoptedRunRecoveryRow extends AdoptedRunLogRow {
  resultJson: Record<string, unknown> | null;
  contextSnapshot: Record<string, unknown> | null;
}

export type AdoptedResultDecision =
  | {
      kind: "recovered";
      outcome: "succeeded" | "failed";
      result: AdapterExecutionResult;
      snapshot: LocalResultRecoverySnapshot;
      resultRecovery: Record<string, unknown>;
    }
  | {
      kind: "fallback";
      reason: AdoptedResultFallbackReason;
      resultRecovery: Record<string, unknown>;
    };

export interface DecideAdoptedRunResultInput {
  db: Db;
  runLogStore: RunLogStore;
  run: AdoptedRunRecoveryRow;
  /** The agent's adapter today; a run started with another one is not parsed. */
  agentAdapterType: string;
  findAdapter: (type: string) => ServerAdapterModule | null;
  now?: () => Date;
}

const OBSERVED_SESSION_ID_PATTERN = /^[\x21-\x7e]{1,256}$/;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function observedSessionIdFrom(result: AdapterOutputRecoveryResult | null): string | null {
  if (!result) return null;
  const candidate =
    result.kind === "inconclusive"
      ? result.observedSessionId
      : result.result.sessionId ?? objectOrEmpty(result.result.sessionParams).sessionId;
  return typeof candidate === "string" && OBSERVED_SESSION_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Reads the final result of an adopted local CLI run from its persisted run
 * log, once the caller has established that the child and its process group
 * are gone and that no output tail is still writing. Returns a recovered
 * result only when the output tail drained to the end of the child's output,
 * the whole log from the latest invocation is intact, and the adapter's hook
 * found a complete provider verdict. Everything else is a fallback with a
 * distinct reason. Never throws and writes nothing.
 */
export async function decideAdoptedRunResult(
  input: DecideAdoptedRunResultInput,
): Promise<AdoptedResultDecision> {
  const { db, runLogStore, run } = input;
  const decidedAt = (input.now?.() ?? new Date()).toISOString();
  const hotRestart = objectOrEmpty(objectOrEmpty(run.resultJson).hotRestart);
  const outputCapture = objectOrEmpty(hotRestart.outputCapture);
  const relayCaptured = outputCapture.mode === "relay";
  const relayPid = typeof outputCapture.relayPid === "number" ? outputCapture.relayPid : undefined;
  const base = { version: 1, source: "run_log", exitCodeKnown: false, decidedAt };

  const fallback = (
    decision: "inconclusive" | "unsupported",
    reason: AdoptedResultFallbackReason,
    extra: Record<string, unknown> = {},
  ): AdoptedResultDecision => ({
    kind: "fallback",
    reason,
    resultRecovery: { ...base, decision, reason, ...extra },
  });

  if (hotRestart.adopted !== true) return fallback("unsupported", "not_adopted");
  const snapshot = readLocalResultRecoverySnapshot(run.contextSnapshot);
  if (!snapshot) return fallback("unsupported", "snapshot_unavailable");
  const invocation = {
    adapterType: snapshot.adapterType,
    invocationNumber: snapshot.invocation.number,
    firstSeq: snapshot.invocation.firstSeq,
  };
  if (snapshot.adapterType !== input.agentAdapterType) {
    return fallback("unsupported", "adapter_changed", { invocation });
  }
  const adapter = input.findAdapter(snapshot.adapterType);
  if (!adapter) return fallback("unsupported", "adapter_unavailable", { invocation });
  const recover = adapter.recoverResultFromOutput;
  if (!recover) return fallback("unsupported", "no_recovery_hook", { invocation });
  const context = adapterOutputRecoveryContextFromSnapshot(snapshot);
  if (!context) return fallback("unsupported", "no_recovery_context", { invocation });

  const identity: AdoptedRunIdentity = { companyId: run.companyId, agentId: run.agentId, runId: run.id };
  let receipt: AdoptedOutputReceipt = { kind: "absent" };
  if (relayCaptured) {
    try {
      receipt = await readAdoptedOutputReceipt(db, { ...identity, relayPid });
    } catch {
      return fallback("inconclusive", "tail_not_drained", { invocation, receipt: "unreadable" });
    }
  }
  const drained = relayCaptured && receipt.kind === "drained";
  const receiptEvidence = relayCaptured ? { receipt: receipt.kind, receiptEventSeq: receipt.kind === "absent" ? null : receipt.eventSeq } : {};

  // Parse the output with the hook. Without a drained tail the verdict is not
  // trusted; the parse then only looks for a session id to keep as evidence.
  let hookResult: AdapterOutputRecoveryResult | null = null;
  let hookError = false;
  const reader = openAdoptedRunOutput({
    runLogStore,
    run,
    expected: identity,
    fromSeq: snapshot.invocation.firstSeq,
  });
  try {
    hookResult = await recover({ output: reader.output, context });
  } catch {
    hookError = true;
  }
  const readOutcome = await reader.settle();
  const intact = readOutcome.kind === "intact";
  const observedSessionId = intact ? observedSessionIdFrom(hookResult) : null;
  const evidence = {
    invocation,
    ...receiptEvidence,
    ...(observedSessionId
      ? { observedSession: { sessionId: observedSessionId, source: "pre_restart_output" } }
      : {}),
  };

  if (!relayCaptured) return fallback("unsupported", "output_not_captured", evidence);
  if (!drained) {
    const reason =
      receipt.kind === "stopped_early"
        ? "tail_stopped_early"
        : receipt.kind === "gave_up"
          ? "tail_gave_up"
          : "tail_not_drained";
    return fallback("inconclusive", reason, evidence);
  }
  if (readOutcome.kind === "inconclusive") {
    return fallback("inconclusive", "log_inconclusive", { ...evidence, logReason: readOutcome.reason });
  }
  if (hookError || !hookResult) return fallback("inconclusive", "hook_error", evidence);
  if (hookResult.kind === "inconclusive") {
    return fallback("inconclusive", "hook_inconclusive", {
      ...evidence,
      hookReason: String(hookResult.reason ?? "").slice(0, 200),
    });
  }
  const { result } = hookResult;
  if (
    (hookResult.outcome !== "succeeded" && hookResult.outcome !== "failed") ||
    result.exitCode !== null ||
    result.signal ||
    result.timedOut
  ) {
    return fallback("inconclusive", "unexpected_result", evidence);
  }
  return {
    kind: "recovered",
    outcome: hookResult.outcome,
    result,
    snapshot,
    resultRecovery: {
      ...base,
      decision: "recovered",
      outcome: hookResult.outcome,
      terminalEvent: hookResult.terminalEvent,
      invocation,
      receipt: receipt.kind,
      receiptEventSeq: receipt.kind === "drained" ? receipt.eventSeq : null,
      recordsRead: readOutcome.records,
      lastSeq: readOutcome.lastSeq,
      known: {
        summary: typeof result.summary === "string" && result.summary.length > 0,
        session: Boolean(result.sessionId ?? result.sessionDisplayId ?? result.sessionParams),
        usage: result.usage != null,
        costUsd: result.costUsd != null,
      },
    },
  };
}
