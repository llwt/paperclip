import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  formatRunProcessSweepLogLine,
  linuxProcReader,
  parseProcStat,
  sweepRunProcesses,
  type RunProcessSweepProcReader,
} from "./run-process-sweep.js";
import { runChildProcess } from "./server-utils.js";

const RUN_ID = "11111111-2222-3333-4444-555555555555";
const UID = 1000;
const SERVER_PID = 500;

interface FakeProc {
  uid: number;
  ppid: number;
  startTime: string;
  state?: string;
  comm?: string;
  env: Record<string, string>;
  cmdline: string[];
  // How the process reacts to SIGTERM.
  onTerm?: "exit" | "ignore" | "reuse";
}

function statLine(pid: number, proc: FakeProc) {
  const filler = Array.from({ length: 17 }, () => "0").join(" ");
  return `${pid} (${proc.comm ?? "node"}) ${proc.state ?? "S"} ${proc.ppid} ${filler} ${proc.startTime} 0 0`;
}

function fakeProc(procs: Map<number, FakeProc>) {
  const signals: Array<[number, NodeJS.Signals]> = [];
  const reader: RunProcessSweepProcReader = {
    listPids: async () => [...procs.keys()],
    readUid: async (pid) => procs.get(pid)?.uid ?? null,
    readStat: async (pid) => {
      const proc = procs.get(pid);
      return proc ? statLine(pid, proc) : null;
    },
    readEnviron: async (pid) => {
      const proc = procs.get(pid);
      if (!proc) return null;
      return Object.entries(proc.env).map(([k, v]) => `${k}=${v}\0`).join("");
    },
    readCmdline: async (pid) => {
      const proc = procs.get(pid);
      return proc ? `${proc.cmdline.join("\0")}\0` : null;
    },
  };
  const kill = (pid: number, signal: NodeJS.Signals) => {
    const proc = procs.get(pid);
    if (!proc) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    signals.push([pid, signal]);
    if (signal === "SIGKILL") procs.delete(pid);
    else if (proc.onTerm === "exit") procs.delete(pid);
    else if (proc.onTerm === "reuse") {
      // The process exits and an unrelated process gets the same PID.
      procs.set(pid, { ...proc, startTime: `${proc.startTime}9`, env: {}, onTerm: "ignore" });
    }
  };
  return { reader, kill, signals };
}

function sweepOptions(fake: ReturnType<typeof fakeProc>, extra: Record<string, unknown> = {}) {
  let clock = 0;
  return {
    platform: "linux" as const,
    procReader: fake.reader,
    kill: fake.kill,
    selfPid: SERVER_PID,
    selfUid: UID,
    graceMs: 1_000,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    ...extra,
  };
}

function baseProcs() {
  return new Map<number, FakeProc>([
    [1, { uid: 0, ppid: 0, startTime: "1", env: {}, cmdline: ["/sbin/init"] }],
    [400, { uid: UID, ppid: 1, startTime: "40", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["systemd", "--user"] }],
    [SERVER_PID, { uid: UID, ppid: 400, startTime: "50", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["node", "paperclip"] }],
  ]);
}

describe("parseProcStat", () => {
  it("reads state, ppid and start time when comm holds spaces and parentheses", () => {
    const filler = Array.from({ length: 17 }, () => "0").join(" ");
    expect(parseProcStat(`42 (a (b) c) R 7 ${filler} 123456 0`)).toEqual({
      state: "R",
      ppid: 7,
      startTime: "123456",
    });
    expect(parseProcStat("garbage")).toBeNull();
    expect(parseProcStat(null)).toBeNull();
  });
});

describe("sweepRunProcesses", () => {
  it("sends SIGTERM to matching processes and SIGKILL only to those still alive after grace", async () => {
    const procs = baseProcs();
    procs.set(1001, { uid: UID, ppid: 400, startTime: "100", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["node", "storybook", "dev"], onTerm: "exit" });
    procs.set(1002, { uid: UID, ppid: 400, startTime: "101", env: { PATH: "/bin", PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["postgres", "-D", "/tmp/x"], onTerm: "ignore" });
    const fake = fakeProc(procs);

    const evidence = await sweepRunProcesses(RUN_ID, sweepOptions(fake));

    expect(fake.signals).toEqual([
      [1001, "SIGTERM"],
      [1002, "SIGTERM"],
      [1002, "SIGKILL"],
    ]);
    expect(evidence).toEqual({
      kind: "leftover_process_sweep",
      stopped: 2,
      forceKilled: 1,
      processes: [
        { pid: 1001, command: "node storybook dev", forceKilled: false },
        { pid: 1002, command: "postgres -D /tmp/x", forceKilled: true },
      ],
    });
    expect(formatRunProcessSweepLogLine(evidence!)).toBe(
      "[paperclip] stopped 2 leftover processes from this run\n",
    );
  });

  it("leaves other run ids, prefix ids, other uids, the server and its ancestors alone", async () => {
    const procs = baseProcs();
    procs.set(2001, { uid: UID, ppid: 400, startTime: "200", env: { PAPERCLIP_RUN_ID: "other-run" }, cmdline: ["a"] });
    procs.set(2002, { uid: UID, ppid: 400, startTime: "201", env: { PAPERCLIP_RUN_ID: `${RUN_ID}x` }, cmdline: ["b"] });
    procs.set(2003, { uid: 1001, ppid: 400, startTime: "202", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["c"] });
    procs.set(2004, { uid: UID, ppid: 400, startTime: "203", env: { XPAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["d"] });
    procs.set(2005, { uid: UID, ppid: 400, startTime: "204", env: { NOTE: `PAPERCLIP_RUN_ID=${RUN_ID}` }, cmdline: ["e"] });
    const fake = fakeProc(procs);

    const evidence = await sweepRunProcesses(RUN_ID, sweepOptions(fake));

    expect(fake.signals).toEqual([]);
    expect(evidence).toEqual({ kind: "leftover_process_sweep", stopped: 0, forceKilled: 0, processes: [] });
  });

  it("never sends SIGKILL to a reused PID", async () => {
    const procs = baseProcs();
    procs.set(3001, { uid: UID, ppid: 400, startTime: "300", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["sleep", "300"], onTerm: "reuse" });
    const fake = fakeProc(procs);

    const evidence = await sweepRunProcesses(RUN_ID, sweepOptions(fake));

    expect(fake.signals).toEqual([[3001, "SIGTERM"]]);
    expect(evidence?.stopped).toBe(1);
    expect(evidence?.forceKilled).toBe(0);
  });

  it("skips zombies and processes whose /proc entries cannot be read", async () => {
    const procs = baseProcs();
    procs.set(4001, { uid: UID, ppid: 400, startTime: "400", state: "Z", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: [] });
    const fake = fakeProc(procs);
    const reader: RunProcessSweepProcReader = {
      ...fake.reader,
      listPids: async () => [...(await fake.reader.listPids()), 4002, 4003],
      readUid: async (pid) => (pid === 4003 ? UID : fake.reader.readUid(pid)),
    };

    const evidence = await sweepRunProcesses(RUN_ID, sweepOptions(fake, { procReader: reader }));

    expect(fake.signals).toEqual([]);
    expect(evidence?.stopped).toBe(0);
  });

  it("requires the invocation entry when one is given", async () => {
    const procs = baseProcs();
    procs.set(5001, { uid: UID, ppid: 400, startTime: "500", env: { PAPERCLIP_RUN_ID: RUN_ID, PAPERCLIP_RUN_INVOCATION_ID: "inv-a" }, cmdline: ["mine"], onTerm: "exit" });
    procs.set(5002, { uid: UID, ppid: 400, startTime: "501", env: { PAPERCLIP_RUN_ID: RUN_ID, PAPERCLIP_RUN_INVOCATION_ID: "inv-b" }, cmdline: ["other spawn"], onTerm: "exit" });
    const fake = fakeProc(procs);

    const evidence = await sweepRunProcesses(RUN_ID, sweepOptions(fake, { invocationId: "inv-a" }));

    expect(fake.signals).toEqual([[5001, "SIGTERM"]]);
    expect(evidence?.processes.map((p) => p.pid)).toEqual([5001]);
  });

  it("redacts and truncates the recorded command line", async () => {
    const procs = baseProcs();
    const long = `curl -H "Authorization: Bearer sk-secret-value" ${"x".repeat(200)}`;
    procs.set(6001, { uid: UID, ppid: 400, startTime: "600", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["sh", "-c", long], onTerm: "exit" });
    const fake = fakeProc(procs);

    const evidence = await sweepRunProcesses(RUN_ID, sweepOptions(fake));

    const command = evidence?.processes[0]?.command ?? "";
    expect(command.length).toBe(120);
    expect(command).not.toContain("sk-secret-value");
  });

  it("is a no-op off Linux", async () => {
    const procs = baseProcs();
    procs.set(7001, { uid: UID, ppid: 400, startTime: "700", env: { PAPERCLIP_RUN_ID: RUN_ID }, cmdline: ["x"], onTerm: "exit" });
    const fake = fakeProc(procs);

    expect(await sweepRunProcesses(RUN_ID, sweepOptions(fake, { platform: "darwin" }))).toBeNull();
    expect(fake.signals).toEqual([]);
  });
});

async function pidsWithRunId(runId: string) {
  const entry = `PAPERCLIP_RUN_ID=${runId}`;
  const found: number[] = [];
  for (const pid of await linuxProcReader.listPids()) {
    const environ = await linuxProcReader.readEnviron(pid);
    if (environ?.split("\0").includes(entry)) found.push(pid);
  }
  return found;
}

describe.skipIf(process.platform !== "linux")("runChildProcess leftover sweep (Linux)", () => {
  it("stops a setsid background process of the run after the run resolves", async () => {
    const runId = `sweep-test-${randomUUID()}`;
    const logs: string[] = [];
    try {
      const result = await runChildProcess(
        runId,
        "sh",
        ["-c", "(setsid sleep 300 &); echo done"],
        {
          cwd: process.cwd(),
          env: { PAPERCLIP_RUN_ID: runId },
          timeoutSec: 30,
          graceSec: 1,
          onLog: async (_stream, chunk) => {
            logs.push(chunk);
          },
          leftoverProcessSweep: { graceMs: 500 },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("done");
      expect(result.leftoverProcessSweep?.stopped).toBe(1);
      expect(result.leftoverProcessSweep?.processes[0]?.command).toBe("sleep 300");
      expect(logs.join("")).toContain("[paperclip] stopped 1 leftover process from this run");
      expect(await pidsWithRunId(runId)).toEqual([]);
    } finally {
      // Never leave the test's own sleep behind, by exact PID only.
      for (const pid of await pidsWithRunId(runId)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 20_000);

  it("does not sweep when the child env does not carry the run id", async () => {
    const runId = `sweep-test-${randomUUID()}`;
    const result = await runChildProcess(runId, "sh", ["-c", "echo ok"], {
      cwd: process.cwd(),
      env: {},
      timeoutSec: 10,
      graceSec: 1,
      onLog: async () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.leftoverProcessSweep).toBeUndefined();
  });
});
