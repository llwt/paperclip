import { readdirSync, statSync } from "node:fs";
import { readBootId, readProcCgroup, readProcStat, userManagerCgroup } from "./proc.js";
import { listScopeRecordRefs, readScopeRecord, type ScopeRecord, type ScopeRecordRef } from "./registry.js";
import { isValidScopeName, isValidSliceName, scopeUnitNamespace, sliceCgroupPath } from "./unit-names.js";

// Read-only facts for restart reconciliation (plan SX-2306, "Ownership,
// cancellation and restart"). Deciding what to keep or stop is the server's
// job; these functions never signal anything.

export interface OwnedScopeListing {
  /** Valid records of this instance, in unit order. */
  records: ScopeRecord[];
  /** Records in this instance's namespace that could not be read; never treated as empty. */
  unreadable: ScopeRecordRef[];
}

/**
 * The launch records of one instance: only files in its own unit namespace
 * whose manifest names that instance. Records of other instances sharing the
 * directory or the user manager are never returned.
 */
export function listOwnedScopeRecords(registryDir: string, instanceId: string): OwnedScopeListing {
  const records: ScopeRecord[] = [];
  const unreadable: ScopeRecordRef[] = [];
  for (const ref of listScopeRecordRefs(registryDir, scopeUnitNamespace(instanceId))) {
    let record: ScopeRecord | null;
    try {
      record = readScopeRecord(ref);
    } catch {
      unreadable.push(ref);
      continue;
    }
    if (!record) continue;
    if (record.manifest.instanceId !== instanceId) continue;
    records.push(record);
  }
  return { records, unreadable };
}

/**
 * Whether the record's root process still runs: same boot, same PID and the
 * same start time, and not a zombie. A reused PID is not the root.
 */
export function isScopeRootAlive(record: ScopeRecord, procRoot = "/proc"): boolean {
  const pid = record.manifest.pid ?? record.status?.pid ?? null;
  const startTime = record.manifest.pidStartTime ?? record.status?.pidStartTime ?? null;
  const bootId = record.manifest.bootId ?? record.status?.bootId ?? null;
  if (pid === null || startTime === null) return false;
  if (bootId !== null && bootId !== readBootId(procRoot)) return false;
  const stat = readProcStat(pid, procRoot);
  return stat !== null && stat.startTime === startTime && stat.state !== "Z";
}

export interface UnmatchedScopeUnitsInput {
  registryDir: string;
  instanceId: string;
  /** Slices to look in, for example the configured one and those named by records. */
  slices: readonly string[];
  /** The user manager's cgroup; resolved from this process when omitted. */
  managerCgroup?: string | null;
  cgroupRoot?: string;
}

function ownManagerCgroup(): string | null {
  const own = readProcCgroup("self");
  const uid = process.getuid?.();
  return own && uid !== undefined ? userManagerCgroup(own, uid) : null;
}

/**
 * Live scope units in this instance's namespace that have no launch record.
 * They are reported, never stopped: a unit name prefix alone does not prove
 * which owner a scope belongs to.
 */
export function listUnmatchedScopeUnits(input: UnmatchedScopeUnitsInput): string[] {
  const manager = input.managerCgroup === undefined ? ownManagerCgroup() : input.managerCgroup;
  if (!manager) return [];
  const cgroupRoot = input.cgroupRoot ?? "/sys/fs/cgroup";
  const namespace = scopeUnitNamespace(input.instanceId);
  const known = new Set(listScopeRecordRefs(input.registryDir, namespace).map((ref) => ref.unit));
  const unmatched = new Set<string>();
  for (const slice of new Set(input.slices)) {
    if (!isValidSliceName(slice)) continue;
    const directory = `${cgroupRoot}${manager}${sliceCgroupPath(slice)}`;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(namespace) || !isValidScopeName(name) || known.has(name)) continue;
      try {
        if (!statSync(`${directory}/${name}`).isDirectory()) continue;
      } catch {
        continue;
      }
      unmatched.add(name);
    }
  }
  return [...unmatched].sort();
}
