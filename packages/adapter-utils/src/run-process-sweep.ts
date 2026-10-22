import { promises as fs } from "node:fs";
import { redactCommandArgv } from "./command-redaction.js";

// Processes an agent starts in the background (`(cmd &)`, `setsid`, daemons
// such as `pg_ctl start`) leave the adapter's process group, so the group kill
// in `runChildProcess` never reaches them. They still carry the run's
// environment, which is how this sweep finds them: an exact environment entry
// match, never a name or pattern match.

export const RUN_PROCESS_SWEEP_RUN_ID_ENV = "PAPERCLIP_RUN_ID";
// Set by `runChildProcess` on each spawn. Requiring it as well keeps a sweep to
// the descendants of that one spawn, so a sweep never hits another live process
// that reuses the run id (a probe, a retry, a parallel test).
export const RUN_PROCESS_SWEEP_INVOCATION_ENV = "PAPERCLIP_RUN_INVOCATION_ID";
export const RUN_PROCESS_SWEEP_DEFAULT_GRACE_MS = 5_000;
const RUN_PROCESS_SWEEP_POLL_MS = 100;
const RUN_PROCESS_SWEEP_COMMAND_CHARS = 120;

export interface RunProcessSweepProcess {
  pid: number;
  command: string;
  forceKilled: boolean;
}

export interface RunProcessSweepEvidence {
  kind: "leftover_process_sweep";
  stopped: number;
  forceKilled: number;
  processes: RunProcessSweepProcess[];
}

export interface RunProcessSweepProcReader {
  listPids(): Promise<number[]>;
  readUid(pid: number): Promise<number | null>;
  readStat(pid: number): Promise<string | null>;
  readEnviron(pid: number): Promise<string | null>;
  readCmdline(pid: number): Promise<string | null>;
}

export interface RunProcessSweepOptions {
  graceMs?: number;
  invocationId?: string | null;
  platform?: NodeJS.Platform;
  procReader?: RunProcessSweepProcReader;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  selfPid?: number;
  selfUid?: number | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

async function readProcFile(pid: number, name: string): Promise<string | null> {
  try {
    return await fs.readFile(`/proc/${pid}/${name}`, "utf8");
  } catch {
    return null;
  }
}

export const linuxProcReader: RunProcessSweepProcReader = {
  async listPids() {
    try {
      const entries = await fs.readdir("/proc");
      return entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
    } catch {
      return [];
    }
  },
  async readUid(pid) {
    try {
      return (await fs.stat(`/proc/${pid}`)).uid;
    } catch {
      return null;
    }
  },
  readStat: (pid) => readProcFile(pid, "stat"),
  readEnviron: (pid) => readProcFile(pid, "environ"),
  readCmdline: (pid) => readProcFile(pid, "cmdline"),
};

interface ParsedStat {
  state: string;
  ppid: number;
  startTime: string;
}

// `/proc/<pid>/stat` is "pid (comm) state ppid ..."; comm may hold spaces and
// parentheses, so split after the last ")". Field 22 is the start time.
export function parseProcStat(stat: string | null): ParsedStat | null {
  if (!stat) return null;
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!state || !Number.isInteger(ppid) || !startTime) return null;
  return { state, ppid, startTime };
}

function environHasEntry(environ: string, entry: string) {
  return environ.split("\0").includes(entry);
}

async function collectAncestors(reader: RunProcessSweepProcReader, selfPid: number) {
  const skip = new Set<number>([selfPid]);
  let pid = selfPid;
  while (pid > 1) {
    const parsed = parseProcStat(await reader.readStat(pid));
    if (!parsed || parsed.ppid <= 0 || skip.has(parsed.ppid)) break;
    skip.add(parsed.ppid);
    pid = parsed.ppid;
  }
  return skip;
}

// Redact per argument before joining, so a secret value that holds spaces is
// redacted whole.
function formatCommand(cmdline: string | null) {
  const argv = (cmdline ?? "").split("\0").filter((arg) => arg.length > 0);
  return redactCommandArgv(argv).join(" ").trim().slice(0, RUN_PROCESS_SWEEP_COMMAND_CHARS);
}

export function formatRunProcessSweepLogLine(evidence: RunProcessSweepEvidence) {
  return `[paperclip] stopped ${evidence.stopped} leftover process${evidence.stopped === 1 ? "" : "es"} from this run\n`;
}

/**
 * Stop the processes left over from a run: same uid, environment holds the
 * exact entry `PAPERCLIP_RUN_ID=<runId>` (and the invocation entry when one is
 * given). SIGTERM first, SIGKILL after `graceMs` only for a process that is
 * still alive with the same start time, so a reused PID is never hit. Linux
 * only; returns null elsewhere.
 */
export async function sweepRunProcesses(
  runId: string,
  options: RunProcessSweepOptions = {},
): Promise<RunProcessSweepEvidence | null> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux" || !runId) return null;
  const reader = options.procReader ?? linuxProcReader;
  const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const graceMs = Math.max(0, options.graceMs ?? RUN_PROCESS_SWEEP_DEFAULT_GRACE_MS);
  const selfPid = options.selfPid ?? process.pid;
  const selfUid = options.selfUid !== undefined ? options.selfUid : (process.getuid?.() ?? null);
  if (selfUid === null) return null;

  const runEntry = `${RUN_PROCESS_SWEEP_RUN_ID_ENV}=${runId}`;
  const invocationEntry = options.invocationId
    ? `${RUN_PROCESS_SWEEP_INVOCATION_ENV}=${options.invocationId}`
    : null;
  const skip = await collectAncestors(reader, selfPid);

  const targets: Array<{ pid: number; startTime: string; command: string }> = [];
  for (const pid of await reader.listPids()) {
    if (skip.has(pid)) continue;
    if ((await reader.readUid(pid)) !== selfUid) continue;
    const before = parseProcStat(await reader.readStat(pid));
    if (!before || before.state === "Z") continue;
    const environ = await reader.readEnviron(pid);
    if (!environ || !environHasEntry(environ, runEntry)) continue;
    if (invocationEntry && !environHasEntry(environ, invocationEntry)) continue;
    const command = formatCommand(await reader.readCmdline(pid));
    // The environ read must belong to the same process as the start time.
    const after = parseProcStat(await reader.readStat(pid));
    if (!after || after.startTime !== before.startTime) continue;
    targets.push({ pid, startTime: before.startTime, command });
  }
  if (targets.length === 0) {
    return { kind: "leftover_process_sweep", stopped: 0, forceKilled: 0, processes: [] };
  }

  const isSameAndAlive = async (target: { pid: number; startTime: string }) => {
    const parsed = parseProcStat(await reader.readStat(target.pid));
    return Boolean(parsed && parsed.state !== "Z" && parsed.startTime === target.startTime);
  };
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      kill(pid, sig);
      return true;
    } catch {
      return false;
    }
  };

  const signalled = [];
  for (const target of targets) {
    if (!(await isSameAndAlive(target))) continue;
    if (signal(target.pid, "SIGTERM")) signalled.push(target);
  }

  let alive = signalled;
  const deadline = now() + graceMs;
  while (alive.length > 0) {
    const still = [];
    for (const target of alive) {
      if (await isSameAndAlive(target)) still.push(target);
    }
    alive = still;
    if (alive.length === 0 || now() >= deadline) break;
    await sleep(Math.min(RUN_PROCESS_SWEEP_POLL_MS, Math.max(1, deadline - now())));
  }

  // Check each target again right before SIGKILL: while the loop above read
  // the other targets, this one may have exited and its PID been reused.
  const forceKilled = new Set<number>();
  for (const target of alive) {
    if (!(await isSameAndAlive(target))) continue;
    if (signal(target.pid, "SIGKILL")) forceKilled.add(target.pid);
  }

  const processes = signalled.map((target) => ({
    pid: target.pid,
    command: target.command,
    forceKilled: forceKilled.has(target.pid),
  }));
  return {
    kind: "leftover_process_sweep",
    stopped: processes.length,
    forceKilled: forceKilled.size,
    processes,
  };
}
