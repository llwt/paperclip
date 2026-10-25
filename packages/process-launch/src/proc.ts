import { readFileSync } from "node:fs";

/** Small, synchronous Linux /proc readers. Each returns null when the fact is unavailable. */

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

export function readBootId(procRoot = "/proc"): string | null {
  return readText(`${procRoot}/sys/kernel/random/boot_id`)?.trim() || null;
}

export interface ProcStat {
  state: string;
  pgrp: number;
  startTime: string;
}

export function readProcStat(pid: number, procRoot = "/proc"): ProcStat | null {
  const stat = readText(`${procRoot}/${pid}/stat`);
  if (!stat) return null;
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after the command name, starting at field 3 (state).
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const pgrp = Number(fields[2]);
  const startTime = fields[19];
  if (!state || !Number.isInteger(pgrp) || !startTime) return null;
  return { state, pgrp, startTime };
}

/** The unified (cgroup v2) path of a process. */
export function readProcCgroup(pid: number | "self", procRoot = "/proc"): string | null {
  const text = readText(`${procRoot}/${pid}/cgroup`);
  if (!text) return null;
  for (const line of text.split("\n")) {
    if (line.startsWith("0::")) return line.slice(3).trimEnd();
  }
  return null;
}

/** The cgroup of this UID's own user manager, when `ownCgroup` lies below it. */
export function userManagerCgroup(ownCgroup: string, uid: number): string | null {
  const marker = `/user.slice/user-${uid}.slice/user@${uid}.service`;
  const index = ownCgroup.indexOf(marker);
  if (index < 0) return null;
  const end = index + marker.length;
  if (end < ownCgroup.length && ownCgroup[end] !== "/") return null;
  return ownCgroup.slice(0, end);
}
