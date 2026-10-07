import { and, eq } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { readProcessStartedAt } from "./hot-restart.js";
import { terminalLegacyControllerMayOwn } from "./legacy-controller-lease.js";

// A run that a recovery path ended has no finalizer in this server, so nothing
// releases its environment lease. This module decides when such a lease is
// safe to release. It proves that execution ended; it never ends execution.
// Every unknown answer keeps the lease.

type Run = typeof heartbeatRuns.$inferSelect;

const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);

export type TerminalRunLeaseHoldReason =
  | "run_not_found"
  | "run_not_terminal"
  | "run_not_legacy"
  | "local_execution_active"
  | "no_active_lease"
  | "non_local_lease"
  | "controller_lease_live"
  | "missing_process_metadata"
  | "process_may_be_alive"
  | "process_identity_unreadable"
  | "process_group_may_be_alive"
  | "process_group_unverifiable"
  | "snapshot_changed";

export type TerminalRunLeaseReleaseDecision =
  | { release: true; run: Run; leaseIds: string[] }
  | { release: false; reason: TerminalRunLeaseHoldReason };

export interface TerminalRunLeaseProbes {
  /** `process.kill(target, 0)`: throws when the target cannot be signalled. */
  signalZero(target: number): void;
  readProcessStartedAt(pid: number): Promise<string | null>;
  platform: NodeJS.Platform;
}

const defaultProbes: TerminalRunLeaseProbes = {
  signalZero: (target) => {
    process.kill(target, 0);
  },
  readProcessStartedAt: (pid) => readProcessStartedAt(pid),
  platform: process.platform,
};

/** Only ESRCH proves that the target is gone. EPERM and every unexpected
 * error mean the target may still be alive. */
function targetIsGone(probes: TerminalRunLeaseProbes, target: number): boolean {
  try {
    probes.signalZero(target);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ESRCH";
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** Null means the recorded local process and process group are both gone. */
export async function localProcessHoldReason(
  run: Pick<Run, "processPid" | "processGroupId" | "processStartedAt">,
  probes: TerminalRunLeaseProbes = defaultProbes,
): Promise<TerminalRunLeaseHoldReason | null> {
  const pid = isPositiveInteger(run.processPid) ? run.processPid : null;
  const processGroupId = isPositiveInteger(run.processGroupId)
    ? run.processGroupId
    : null;
  // A run that never recorded a process gives no evidence of exit.
  if (pid === null && processGroupId === null) return "missing_process_metadata";

  // Check the group first: a recycled pid never overrides a live group.
  if (processGroupId !== null) {
    if (probes.platform === "win32") return "process_group_unverifiable";
    if (!targetIsGone(probes, -processGroupId)) return "process_group_may_be_alive";
  }

  if (pid !== null && !targetIsGone(probes, pid)) {
    // The pid answers. Only a readable, different start time proves that the
    // pid now belongs to another process.
    if (!run.processStartedAt) return "process_may_be_alive";
    let observed: string | null;
    try {
      observed = await probes.readProcessStartedAt(pid);
    } catch {
      // The process can exit between the signal and the read.
      return targetIsGone(probes, pid) ? null : "process_identity_unreadable";
    }
    if (!observed) return "process_identity_unreadable";
    const observedMs = new Date(observed).getTime();
    if (!Number.isFinite(observedMs)) return "process_identity_unreadable";
    if (observedMs === run.processStartedAt.getTime()) return "process_may_be_alive";
  }
  return null;
}

function sameOwnershipSnapshot(a: Run, b: Run): boolean {
  return (
    a.status === b.status &&
    a.runtimeMode === b.runtimeMode &&
    a.processPid === b.processPid &&
    a.processGroupId === b.processGroupId &&
    (a.processStartedAt?.getTime() ?? null) ===
      (b.processStartedAt?.getTime() ?? null) &&
    a.controllerBootId === b.controllerBootId
  );
}

async function readRun(db: Db, input: { runId: string; companyId: string }) {
  const [run] = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.id, input.runId),
        eq(heartbeatRuns.companyId, input.companyId),
      ),
    );
  return run ?? null;
}

/** Decide whether the active leases of a terminal run can be released. The
 * repair covers local leases of legacy runs on this host only. Remote and
 * native execution keep their own lifecycle owners. */
export async function decideTerminalRunLeaseRelease(
  db: Db,
  input: { runId: string; companyId: string },
  deps: {
    /** True while this server still executes, finalizes or controls the run. */
    hasLocalExecution(runId: string): boolean;
    probes?: TerminalRunLeaseProbes;
  },
): Promise<TerminalRunLeaseReleaseDecision> {
  const run = await readRun(db, input);
  if (!run) return { release: false, reason: "run_not_found" };
  if (!TERMINAL_RUN_STATUSES.has(run.status))
    return { release: false, reason: "run_not_terminal" };
  if (run.runtimeMode !== "legacy")
    return { release: false, reason: "run_not_legacy" };
  if (deps.hasLocalExecution(run.id))
    return { release: false, reason: "local_execution_active" };

  // The release helper releases every active lease of the run, so every one
  // of them must be local.
  const leases = await db
    .select({ id: environmentLeases.id, provider: environmentLeases.provider })
    .from(environmentLeases)
    .where(
      and(
        eq(environmentLeases.companyId, run.companyId),
        eq(environmentLeases.heartbeatRunId, run.id),
        eq(environmentLeases.status, "active"),
      ),
    );
  if (leases.length === 0) return { release: false, reason: "no_active_lease" };
  if (leases.some((lease) => lease.provider !== "local"))
    return { release: false, reason: "non_local_lease" };

  if (await terminalLegacyControllerMayOwn(db, run))
    return { release: false, reason: "controller_lease_live" };

  const processHold = await localProcessHoldReason(run, deps.probes);
  if (processHold) return { release: false, reason: processHold };

  // The probes awaited. Another path may have claimed the run meanwhile.
  const current = await readRun(db, input);
  if (
    !current ||
    !sameOwnershipSnapshot(run, current) ||
    deps.hasLocalExecution(run.id)
  )
    return { release: false, reason: "snapshot_changed" };

  return { release: true, run: current, leaseIds: leases.map((lease) => lease.id) };
}
