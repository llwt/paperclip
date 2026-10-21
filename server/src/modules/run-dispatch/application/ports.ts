import type { Db } from "@paperclipai/db";
import type { GateDecision } from "../domain/policy.js";
import type {
  CancelStaleQueuedRunOutcome,
  PromoteScheduledRetryOutcome,
} from "./types.js";

export type DueRetryRun = {
  runId: string;
  companyId: string;
};

export type ListDueRetriesInput = {
  now: Date;
  cutoff: Date | null;
  limit: number;
};

export type EvaluateScheduledRetryGateInput = {
  runId: string;
  companyId: string;
  retryReasonOverride: string;
  now: Date;
};

/** Read-only scheduled-retry operations exposed to application use cases. */
export interface ScheduledRetryReader {
  evaluateScheduledRetryGate(input: EvaluateScheduledRetryGateInput): Promise<GateDecision>;
  listDueRetries(input: ListDueRetriesInput): Promise<DueRetryRun[]>;
}

export type PromoteOrCancelDueRetryInput = {
  runId: string;
  companyId: string;
  now: Date;
};

export type CancelStaleQueuedRunInput = {
  runId: string;
  companyId: string;
  now: Date;
  expectedStatus: "queued" | "running";
};

export type DispatchResolvedInteractionInput<T> = CancelStaleQueuedRunInput & {
  dispatch: (markDispatchStarted: () => void) => Promise<T>;
};

export type DispatchResolvedInteractionOutcome<T> =
  | { dispatched: true; resultPromise: Promise<T> }
  | { dispatched: false; cancellation: CancelStaleQueuedRunOutcome };

/** Semantic database operations; persistence rows and transaction handles stay inside the adapter. */
export interface RunDispatchWriter {
  promoteOrCancelDueRetry(input: PromoteOrCancelDueRetryInput): Promise<PromoteScheduledRetryOutcome>;
  cancelStaleQueuedRun(input: CancelStaleQueuedRunInput): Promise<CancelStaleQueuedRunOutcome>;
  /**
   * The one operation that runs on a caller's transaction: the queued-run
   * claim already holds the issue lock, and the owner check must run under
   * that same lock or a reassignment can land between check and claim.
   */
  cancelStaleQueuedRunUnderIssueLock(
    tx: Db,
    input: Omit<CancelStaleQueuedRunInput, "expectedStatus">,
  ): Promise<CancelStaleQueuedRunOutcome>;
  dispatchResolvedInteractionIfCurrent<T>(
    input: DispatchResolvedInteractionInput<T>,
  ): Promise<DispatchResolvedInteractionOutcome<T>>;
}
