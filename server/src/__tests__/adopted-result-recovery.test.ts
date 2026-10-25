import { beforeEach, describe, expect, it, vi } from "vitest";

const decide = vi.hoisted(() => vi.fn());
vi.mock("../services/adopted-run-result.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/adopted-run-result.js")>()),
  decideAdoptedRunResult: decide,
}));
const loggerSpies = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: loggerSpies }));

import type { Db } from "@paperclipai/db";
import {
  createAdoptedResultRecovery,
  type AdoptedResultRecoveryDependencies,
} from "../services/heartbeat/adopted-result-recovery.js";
import {
  LOCAL_RESULT_RECOVERY_CONTEXT_KEY,
  adapterOutputRecoveryContextFromSnapshot,
  readLocalResultRecoverySnapshot,
} from "../services/heartbeat/local-result-recovery.js";

type Run = Parameters<ReturnType<typeof createAdoptedResultRecovery>["recover"]>[0];

const snapshot = {
  version: 1,
  adapterType: "codex_local",
  taskKey: "task-1",
  configuredModel: "m",
  session: {
    previousParams: null,
    dispatched: { sessionId: null, sessionDisplayId: null, params: null },
    taskSessionReused: false,
    rotated: false,
    rotationReason: null,
    config: { version: 1, fingerprint: "fp", categories: [], categoryFingerprints: {}, aiCredentialIdentity: null },
  },
  configFreshness: {},
  invocation: {
    number: 1,
    firstSeq: 1,
    startedAt: "2026-10-23T00:00:00.000Z",
    engine: "cli",
    sessionIdBefore: null,
    freshSessionRetry: false,
    sessionParams: null,
    accounting: { provider: "openai", biller: "openai", model: "m", billingType: "api" },
  },
};

const runRow = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "run-1",
    companyId: "company-1",
    agentId: "agent-1",
    status: "running",
    contextSnapshot: { issueId: null },
    usageJson: null,
    resultJson: null,
    stdoutExcerpt: null,
    stderrExcerpt: null,
    ...overrides,
  }) as unknown as Run;

const recoveredDecision = {
  kind: "recovered" as const,
  outcome: "succeeded" as const,
  result: { exitCode: null, signal: null, timedOut: false, summary: "done" },
  snapshot,
  resultRecovery: { version: 1, source: "run_log", decision: "recovered", invocation: { adapterType: "codex_local" } },
};

describe("adopted result recovery", () => {
  const pending = new Set<string>();
  const completeRun = vi.fn();
  const getRun = vi.fn();

  function build(overrides: Partial<AdoptedResultRecoveryDependencies> = {}) {
    return createAdoptedResultRecovery({} as Db, {
      pending,
      runLogStore: {} as never,
      getRun,
      getAgent: vi.fn(async () => ({ id: "agent-1", companyId: "company-1", adapterType: "codex_local" }) as never),
      getIssueExecutionContext: vi.fn(async () => null as never),
      getCurrentUserRedactionOptions: vi.fn(async () => ({ enabled: false })),
      resolveLedgerScopeForRun: vi.fn(async () => ({})),
      getSessionCodec: vi.fn(() => null as never),
      findAdapter: vi.fn(() => null),
      completeRun,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    pending.clear();
    decide.mockResolvedValue(recoveredDecision);
    getRun.mockResolvedValue(runRow());
  });

  it("finalizes through the shared finalizer with the recovered verdict and no exit code", async () => {
    completeRun.mockResolvedValue({ won: true, lateWrite: false, run: runRow({ status: "succeeded" }), outcome: "succeeded" });
    const outcome = await build().recover(runRow());
    expect(outcome).toMatchObject({ kind: "finalized", outcome: "succeeded" });
    expect(completeRun).toHaveBeenCalledTimes(1);
    const input = completeRun.mock.calls[0]![0];
    expect(input).toMatchObject({
      source: "adopted_output",
      recoveredOutcome: "succeeded",
      resultRecovery: recoveredDecision.resultRecovery,
      adapterResult: { exitCode: null },
      providerTraceCapture: false,
    });
    expect(input.signal.aborted).toBe(false);
  });

  it("leaves a run that Stop or an earlier sweep ended before the write", async () => {
    getRun.mockResolvedValue(runRow({ status: "cancelled" }));
    expect(await build().recover(runRow())).toEqual({ kind: "lost" });
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("does nothing when the finalizer lost the terminal write", async () => {
    completeRun.mockResolvedValue({ won: false, lateWrite: false, run: null, outcome: "cancelled" });
    expect(await build().recover(runRow())).toEqual({ kind: "lost" });
  });

  it("returns the fallback provenance when the decision is not a recovered result", async () => {
    decide.mockResolvedValue({ kind: "fallback", reason: "tail_gave_up", resultRecovery: { reason: "tail_gave_up" } });
    expect(await build().recover(runRow())).toEqual({
      kind: "fallback",
      reason: "tail_gave_up",
      resultRecovery: { reason: "tail_gave_up" },
    });
    expect(completeRun).not.toHaveBeenCalled();
  });

  it("treats an adapter changed to another company's agent as a different adapter", async () => {
    const recovery = build({ getAgent: vi.fn(async () => ({ id: "agent-1", companyId: "other", adapterType: "codex_local" }) as never) });
    decide.mockResolvedValue({ kind: "fallback", reason: "adapter_changed", resultRecovery: {} });
    await recovery.recover(runRow());
    expect(decide.mock.calls[0]![0].agentAdapterType).toBe("");
  });

  it("logs an error after the terminal write and keeps the recovered result", async () => {
    const written = runRow({
      status: "succeeded",
      resultJson: { hotRestart: { resultRecovery: { source: "run_log", decision: "recovered" } } },
    });
    getRun.mockResolvedValueOnce(runRow()).mockResolvedValue(written);
    completeRun.mockRejectedValue(new Error("comment failed"));
    const outcome = await build().recover(runRow());
    expect(outcome).toMatchObject({ kind: "finalization_error", run: written });
    expect(loggerSpies.error).toHaveBeenCalledTimes(1);
  });

  it("falls back to process loss when the finalizer failed before any write", async () => {
    getRun.mockResolvedValue(runRow());
    completeRun.mockRejectedValue(new Error("db down"));
    const outcome = await build().recover(runRow());
    expect(outcome).toMatchObject({
      kind: "fallback",
      reason: "finalization_error",
      resultRecovery: { decision: "inconclusive", reason: "finalization_error", exitCodeKnown: false },
    });
  });

  it("does not report an error when another writer ended the run during a failed attempt", async () => {
    getRun.mockResolvedValueOnce(runRow()).mockResolvedValue(runRow({ status: "cancelled" }));
    completeRun.mockRejectedValue(new Error("write conflict"));
    expect(await build().recover(runRow())).toEqual({ kind: "lost" });
    expect(loggerSpies.error).not.toHaveBeenCalled();
  });

  it("marks the run pending while it works and refuses a concurrent attempt", async () => {
    let release!: () => void;
    decide.mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ kind: "fallback", reason: "tail_gave_up", resultRecovery: {} }); }),
    );
    const recovery = build();
    const first = recovery.recover(runRow());
    await vi.waitFor(() => expect(pending.has("run-1")).toBe(true));
    expect(await recovery.recover(runRow())).toEqual({ kind: "lost" });
    expect(decide).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(pending.has("run-1")).toBe(false);
  });

  it("clears the pending mark when the attempt throws", async () => {
    decide.mockRejectedValue(new Error("boom"));
    await expect(build().recover(runRow())).rejects.toThrow("boom");
    expect(pending.has("run-1")).toBe(false);
  });
});

describe("local result recovery snapshot reader", () => {
  it("reads back a snapshot as written, and passes the fresh-session retry flag to the hook context", () => {
    const stored = { [LOCAL_RESULT_RECOVERY_CONTEXT_KEY]: { ...snapshot, invocation: { ...snapshot.invocation, freshSessionRetry: true } } };
    const read = readLocalResultRecoverySnapshot(stored);
    expect(read?.invocation.freshSessionRetry).toBe(true);
    expect(adapterOutputRecoveryContextFromSnapshot(read!)?.invocation.freshSessionRetry).toBe(true);
  });

  it("reads a snapshot written before the flag existed as not a retry", () => {
    const { freshSessionRetry: _flag, ...invocation } = snapshot.invocation;
    const read = readLocalResultRecoverySnapshot({ [LOCAL_RESULT_RECOVERY_CONTEXT_KEY]: { ...snapshot, invocation } });
    expect(read).not.toBeNull();
    expect(adapterOutputRecoveryContextFromSnapshot(read!)?.invocation.freshSessionRetry).toBe(false);
  });

  it.each([
    ["no snapshot", undefined],
    ["another version", { ...snapshot, version: 2 }],
    ["no adapter type", { ...snapshot, adapterType: "" }],
    ["a damaged session", { ...snapshot, session: { ...snapshot.session, rotated: "no" } }],
    ["a damaged config", { ...snapshot, session: { ...snapshot.session, config: { version: 1 } } }],
    ["a fractional first seq", { ...snapshot, invocation: { ...snapshot.invocation, firstSeq: 1.5 } }],
    ["no accounting", { ...snapshot, invocation: { ...snapshot.invocation, accounting: null } }],
  ])("returns nothing for %s", (_name, value) => {
    expect(readLocalResultRecoverySnapshot(value === undefined ? {} : { [LOCAL_RESULT_RECOVERY_CONTEXT_KEY]: value })).toBeNull();
  });
});
