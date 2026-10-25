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

/** Members of process group `pgid` seen in one listing. */
interface GroupScan {
  /** Members that still run (zombies excluded). */
  running: number;
  /** Whether the group id still provably names the recorded group. */
  continuous: boolean;
}

/** Running (non-zombie) processes whose process group id is `pgid`. */
function groupMembers(pgid: number, procRoot: string): Map<number, string> {
  const members = new Map<number, string>();
  for (const pid of listPids(procRoot)) {
    const stat = readProcStat(pid, procRoot);
    if (stat && stat.pgrp === pgid && stat.state !== "Z") members.set(pid, stat.startTime);
  }
  return members;
}

/**
 * The members of process group `pgid`, tracked across polls to prove the
 * group id still names the recorded group. A process group exists, and its
 * id cannot be reused, while any member remains. So the group is still ours
 * while the verified leader exists (a zombie leader still reserves its PID)
 * or while a member seen earlier is still in it with the same start time.
 * Once neither holds, continuity is lost for good: the members now carrying
 * that id may be ours (a member forked and then exited between polls) or a
 * later group that reused the id, and neither can be proved.
 */
class TrackedGroup {
  private readonly known = new Map<number, string>();
  private lost = false;

  constructor(
    private readonly pgid: number,
    private readonly leaderAlive: () => boolean,
    private readonly procRoot: string,
  ) {}

  scan(): GroupScan {
    const current = groupMembers(this.pgid, this.procRoot);
    if (!this.lost) {
      const continuous =
        this.leaderAlive() || [...this.known].some(([pid, startTime]) => current.get(pid) === startTime);
      if (continuous) {
        this.known.clear();
        for (const [pid, startTime] of current) this.known.set(pid, startTime);
      } else {
        this.lost = true;
        this.known.clear();
      }
    }
    return { running: current.size, continuous: !this.lost };
  }
}

type DegradedPhase = Phase & { containment: "process_group" | "process" | "none"; reason?: string };

/**
 * The degraded path has no scope: only the recorded root process, verified
 * by boot id and start time, and the process group it leads, if any. The
 * group is done only when none of its members still runs, not when the
 * leader alone has exited. A group whose ownership cannot be proved while
 * members still run is never signalled and is reported as not empty.
 */
async function terminateVerifiedProcess(
  record: ScopeRecord,
  options: Required<Omit<TerminateOptions, "instanceId">>,
): Promise<DegradedPhase> {
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

  if (!initial) {
    // The PID now names another process: the kernel never reuses a PID while
    // it is still a process group id, so the recorded group is gone.
    if (readProcStat(pid, options.procRoot) !== null) return { signalled: 0, empty: true, containment: "none" };
    // The root was reaped. Survivors that carry its group id may be ours
    // (for example after a normal exit) or a later group that reused the id;
    // this cannot be proved, so they are never signalled and the record stays.
    if (groupMembers(pid, options.procRoot).size === 0) return { signalled: 0, empty: true, containment: "none" };
    return { signalled: 0, empty: false, containment: "process_group", reason: "group_ownership_unprovable" };
  }

  if (initial.pgrp !== pid) {
    if (initial.state === "Z") return { signalled: 0, empty: true, containment: "none" };
    const leaderGone = () => {
      const stat = verified();
      return stat === null || stat.state === "Z";
    };
    const signalRoot = (signal: NodeJS.Signals) => (leaderGone() ? 0 : sendSignal(pid, signal) ? 1 : 0);
    let signalled = signalRoot(options.signal);
    if (await waitFor(leaderGone, options.graceMs, options.pollMs)) return { signalled, empty: true, containment: "process" };
    signalled += signalRoot("SIGKILL");
    const empty = await waitFor(leaderGone, options.killWaitMs, options.pollMs);
    return { signalled, empty, containment: "process" };
  }

  // The verified leader (running or a zombie) still reserves the group id.
  const group = new TrackedGroup(pid, () => verified() !== null, options.procRoot);
  let last = group.scan();
  // Done when nothing runs, or when ownership can no longer be proved.
  const settled = () => {
    last = group.scan();
    return last.running === 0 || !last.continuous;
  };
  const result = (signalled: number): DegradedPhase =>
    last.running === 0
      ? { signalled, empty: true, containment: "process_group" }
      : last.continuous
        ? { signalled, empty: false, containment: "process_group" }
        : { signalled, empty: false, containment: "process_group", reason: "group_ownership_lost" };
  const signalGroup = (signal: NodeJS.Signals) => {
    // Re-check right before each signal that the group id is still ours.
    if (settled()) return 0;
    return sendSignal(-pid, signal) ? 1 : 0;
  };
  if (last.running === 0) return result(0);
  let signalled = signalGroup(options.signal);
  if (await waitFor(settled, options.graceMs, options.pollMs)) return result(signalled);
  signalled += signalGroup("SIGKILL");
  await waitFor(settled, options.killWaitMs, options.pollMs);
  return result(signalled);
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
 * time. A group whose ownership cannot be proved (its leader was already
 * reaped, or continuity was lost) is never signalled while members run. It
 * never kills by process name, by unit prefix, a whole slice, or a PID it
 * cannot verify. When emptiness cannot be confirmed the record stays.
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
    if (!phase.empty) {
      return { outcome: "unconfirmed", containment, signalled, reason: phase.reason ?? "process_still_running" };
    }
  }

  removeScopeRecord(ref);
  return { outcome: signalled > 0 ? "terminated" : "already_empty", containment, signalled };
}
