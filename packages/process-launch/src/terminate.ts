import { readFileSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { listPids, readBootId, readProcCgroup, readProcStat } from "./proc.js";
import { readScopeRecord, removeScopeRecord, type ScopeRecord, type ScopeRecordRef } from "./registry.js";
import { scopeUnitNamespace, sliceCgroupPath } from "./unit-names.js";

export interface TerminateOptions {
  /** The instance that owns the record; records of other instances are refused. */
  instanceId: string;
  /** Time between the first signal and SIGKILL. Default 5000 ms. */
  graceMs?: number;
  /** Time to wait for emptiness after SIGKILL. Default 5000 ms. */
  killWaitMs?: number;
  /** First signal. Default SIGTERM. */
  signal?: NodeJS.Signals;
  pollMs?: number;
  cgroupRoot?: string;
  procRoot?: string;
}

export type TerminateOutcome =
  /** Processes were signalled and are confirmed gone; the record is removed. */
  | "terminated"
  /** Nothing owned was still running; the record is removed. */
  | "already_empty"
  /** No record exists (for example a repeated call). Nothing was touched. */
  | "missing_record"
  /** Emptiness could not be confirmed; the record is kept for reconciliation. */
  | "unconfirmed";

export interface TerminateResult {
  outcome: TerminateOutcome;
  /** How the owned tree was found. */
  containment: "scope" | "process_group" | "process" | "none";
  signalled: number;
  reason?: string;
}

type Phase = { signalled: number; empty: boolean };

function isOwnedScopePath(record: ScopeRecord, cgroup: string | null): cgroup is string {
  if (!cgroup || !cgroup.startsWith("/")) return false;
  if (cgroup.split("/").some((segment) => segment === ".." || segment === ".")) return false;
  const { unit, slice } = record.manifest;
  return cgroup.endsWith(`${sliceCgroupPath(slice)}/${unit}`);
}

/** The exact scope cgroup this record may own, or null when it never had one. */
function scopeCandidate(record: ScopeRecord): string | null {
  const { manifest, status } = record;
  if (manifest.preflight) return null;
  if (status?.outcome === "enrolled") return status.cgroup;
  // A degraded status that says the scope may still appear, or no status at
  // all (the helper was stopped mid-enrollment): look at the expected path.
  if (!status || status.unitMayExist) {
    const expected = status?.expectedCgroup ?? manifest.expectedCgroup;
    return isOwnedScopePath(record, expected) ? expected : null;
  }
  return null;
}

function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function scopeIsEmpty(directory: string): boolean {
  let events: string;
  try {
    events = readFileSync(`${directory}/cgroup.events`, "utf8");
  } catch (error) {
    // A removed cgroup is empty by definition.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  return /^populated 0$/m.test(events);
}

function scopeMembers(directory: string): number[] {
  try {
    return readFileSync(`${directory}/cgroup.procs`, "utf8")
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

function sendSignal(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch {
    return false;
  }
}

/** Signal each member whose own cgroup is still exactly this scope at the moment of the signal. */
function signalScopeMembers(directory: string, cgroup: string, signal: NodeJS.Signals, procRoot: string): number {
  let signalled = 0;
  for (const pid of scopeMembers(directory)) {
    if (readProcCgroup(pid, procRoot) !== cgroup) continue;
    if (sendSignal(pid, signal)) signalled += 1;
  }
  return signalled;
}

async function waitFor(check: () => boolean, timeoutMs: number, pollMs: number, onPoll?: () => void): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return check();
    onPoll?.();
    await sleep(pollMs);
  }
}

async function terminateScope(cgroup: string, options: Required<Omit<TerminateOptions, "instanceId">>): Promise<Phase> {
  const directory = `${options.cgroupRoot}${cgroup}`;
  if (scopeIsEmpty(directory)) return { signalled: 0, empty: true };
  let signalled = signalScopeMembers(directory, cgroup, options.signal, options.procRoot);
  if (await waitFor(() => scopeIsEmpty(directory), options.graceMs, options.pollMs)) return { signalled, empty: true };

  // cgroup.kill kills every member atomically, including processes forked
  // after the listing above. Fall back to per-member SIGKILL without it.
  let killFile = true;
  try {
    writeFileSync(`${directory}/cgroup.kill`, "1");
  } catch {
    killFile = false;
  }
  const repeatKill = () => {
    if (!killFile) signalled += signalScopeMembers(directory, cgroup, "SIGKILL", options.procRoot);
  };
  repeatKill();
  const empty = await waitFor(() => scopeIsEmpty(directory), options.killWaitMs, options.pollMs, repeatKill);
  return { signalled: signalled + (killFile ? 1 : 0), empty };
}

/**
 * The members of process group `pgid` that are provably the recorded
 * group, tracked across polls. A process group exists, and its id cannot be
 * reused, while any member remains. So the group is still ours while the
 * verified leader exists (a zombie leader still reserves its PID) or while a
 * member seen earlier is still in it with the same start time. Once neither
 * holds, the recorded group has been empty at some point, and any process
 * now carrying that group id belongs to someone else.
 */
class TrackedGroup {
  private readonly known = new Map<number, string>();

  constructor(
    private readonly pgid: number,
    private readonly leaderAlive: () => boolean,
    private readonly procRoot: string,
  ) {}

  /** Refresh the members; returns how many still run, or null once the group is no longer provably ours. */
  live(): number | null {
    const current = new Map<number, { startTime: string; state: string }>();
    for (const pid of listPids(this.procRoot)) {
      const stat = readProcStat(pid, this.procRoot);
      if (stat && stat.pgrp === this.pgid) current.set(pid, stat);
    }
    const continuous =
      this.leaderAlive() ||
      [...this.known].some(([pid, startTime]) => current.get(pid)?.startTime === startTime);
    if (!continuous) {
      this.known.clear();
      return null;
    }
    this.known.clear();
    let running = 0;
    for (const [pid, stat] of current) {
      this.known.set(pid, stat.startTime);
      if (stat.state !== "Z") running += 1;
    }
    return running;
  }
}

/**
 * The degraded path has no scope: only the recorded root process, verified
 * by boot id and start time, and the process group it leads, if any. The
 * group is done only when none of its members still runs, not when the
 * leader alone has exited.
 */
async function terminateVerifiedProcess(
  record: ScopeRecord,
  options: Required<Omit<TerminateOptions, "instanceId">>,
): Promise<Phase & { containment: "process_group" | "process" | "none" }> {
  const pid = record.manifest.pid ?? record.status?.pid ?? null;
  const startTime = record.manifest.pidStartTime ?? record.status?.pidStartTime ?? null;
  const bootId = record.manifest.bootId ?? record.status?.bootId ?? null;
  if (pid === null || startTime === null) return { signalled: 0, empty: true, containment: "none" };
  if (bootId !== null && bootId !== readBootId(options.procRoot)) {
    return { signalled: 0, empty: true, containment: "none" };
  }
  const verified = () => {
    const stat = readProcStat(pid, options.procRoot);
    return stat !== null && stat.startTime === startTime ? stat : null;
  };
  const initial = verified();
  // Not running, or the PID now belongs to another process: never signal it.
  if (!initial || initial.state === "Z") return { signalled: 0, empty: true, containment: "none" };
  const leaderGone = () => {
    const stat = verified();
    return stat === null || stat.state === "Z";
  };

  if (initial.pgrp !== pid) {
    const signalRoot = (signal: NodeJS.Signals) => (leaderGone() ? 0 : sendSignal(pid, signal) ? 1 : 0);
    let signalled = signalRoot(options.signal);
    if (await waitFor(leaderGone, options.graceMs, options.pollMs)) return { signalled, empty: true, containment: "process" };
    signalled += signalRoot("SIGKILL");
    const empty = await waitFor(leaderGone, options.killWaitMs, options.pollMs);
    return { signalled, empty, containment: "process" };
  }

  const group = new TrackedGroup(pid, () => verified() !== null, options.procRoot);
  // Learn the members while the leader is verified, before any signal.
  if (!group.live()) return { signalled: 0, empty: true, containment: "none" };
  const groupDone = () => !group.live();
  const signalGroup = (signal: NodeJS.Signals) => {
    // Re-check right before each signal that the group id is still ours.
    if (groupDone()) return 0;
    return sendSignal(-pid, signal) ? 1 : 0;
  };
  let signalled = signalGroup(options.signal);
  if (await waitFor(groupDone, options.graceMs, options.pollMs)) return { signalled, empty: true, containment: "process_group" };
  signalled += signalGroup("SIGKILL");
  const empty = await waitFor(groupDone, options.killWaitMs, options.pollMs);
  return { signalled, empty, containment: "process_group" };
}

function recordBelongsTo(record: ScopeRecord, instanceId: string): boolean {
  const { manifest, status } = record;
  if (manifest.instanceId !== instanceId) return false;
  if (!manifest.unit.startsWith(scopeUnitNamespace(instanceId))) return false;
  if (!manifest.unit.endsWith(`-${manifest.nonce}.scope`)) return false;
  if (status === null) return true;
  // A preflight fallback means the helper never ran, so it cannot have written a status.
  if (manifest.preflight) return false;
  if (status.unit !== manifest.unit || status.slice !== manifest.slice) return false;
  // An enrolled status must name this record's own scope.
  return status.outcome !== "enrolled" || isOwnedScopePath(record, status.cgroup);
}

/**
 * Stop one owned process tree and remove its record. Idempotent.
 *
 * With a scope: signal every process whose cgroup is exactly the owned
 * scope, SIGKILL the scope after the grace period, and wait until it is
 * empty. Without one (degraded launch): signal only the recorded root
 * process (or the group it leads) after checking its boot id and start
 * time. It never kills by process name, by unit prefix, a whole slice, or a
 * PID it cannot verify. When emptiness cannot be confirmed the record stays.
 */
export async function terminateOwnedProcessTree(
  ref: ScopeRecordRef,
  options: TerminateOptions,
): Promise<TerminateResult> {
  const settings = {
    graceMs: options.graceMs ?? 5_000,
    killWaitMs: options.killWaitMs ?? 5_000,
    signal: options.signal ?? "SIGTERM",
    pollMs: options.pollMs ?? 25,
    cgroupRoot: options.cgroupRoot ?? "/sys/fs/cgroup",
    procRoot: options.procRoot ?? "/proc",
  };
  let record: ScopeRecord | null;
  try {
    record = readScopeRecord(ref);
  } catch {
    return { outcome: "unconfirmed", containment: "none", signalled: 0, reason: "record_unreadable" };
  }
  if (!record) return { outcome: "missing_record", containment: "none", signalled: 0 };
  if (!recordBelongsTo(record, options.instanceId)) {
    return { outcome: "unconfirmed", containment: "none", signalled: 0, reason: "record_identity_mismatch" };
  }

  let signalled = 0;
  let containment: TerminateResult["containment"] = "none";
  const scope = scopeCandidate(record);
  if (scope && directoryExists(`${settings.cgroupRoot}${scope}`)) {
    containment = "scope";
    const phase = await terminateScope(scope, settings);
    signalled += phase.signalled;
    if (!phase.empty) return { outcome: "unconfirmed", containment, signalled, reason: "scope_not_empty" };
  }
  if (record.status?.outcome !== "enrolled") {
    const phase = await terminateVerifiedProcess(record, settings);
    signalled += phase.signalled;
    if (containment === "none") containment = phase.containment;
    if (!phase.empty) return { outcome: "unconfirmed", containment, signalled, reason: "process_still_running" };
  }

  removeScopeRecord(ref);
  return { outcome: signalled > 0 ? "terminated" : "already_empty", containment, signalled };
}
