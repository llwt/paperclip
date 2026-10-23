import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { execute } from "../adapters/process/execute.js";

async function pidsWithRunId(runId: string) {
  const entry = `PAPERCLIP_RUN_ID=${runId}`;
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const environ = await readFile(`/proc/${name}/environ`, "utf8");
      if (environ.split("\0").includes(entry)) found.push(Number(name));
    } catch {
      // gone or not ours
    }
  }
  return found;
}

async function runProcessAdapter(runId: string, script: string, config: Record<string, unknown> = {}) {
  const logs: string[] = [];
  try {
    const result = await execute({
      runId,
      agent: { id: `agent-${randomUUID()}`, companyId: `company-${randomUUID()}`, name: "sweep-test", adapterType: "process" },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: "sh", args: ["-c", script], ...config },
      context: {},
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    } as unknown as Parameters<typeof execute>[0]);
    return { result, logs: logs.join("") };
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
}

describe.skipIf(process.platform !== "linux")("process adapter leftover sweep evidence (Linux)", () => {
  it("records the stopped process in resultJson on a normal exit", async () => {
    const runId = `process-sweep-${randomUUID()}`;
    const { result, logs } = await runProcessAdapter(runId, "(setsid sleep 300 &); echo done");

    expect(result.exitCode).toBe(0);
    expect(result.resultJson?.stdout).toBe("done\n");
    expect(result.resultJson?.leftoverProcessSweep).toMatchObject({
      kind: "leftover_process_sweep",
      stopped: 1,
      processes: [expect.objectContaining({ command: "sleep 300" })],
    });
    expect(logs).toContain("[paperclip] stopped 1 leftover process from this run");
  });

  it("records the stopped process in resultJson on a non-zero exit", async () => {
    const runId = `process-sweep-${randomUUID()}`;
    const { result } = await runProcessAdapter(runId, "(setsid sleep 300 &); exit 3");

    expect(result.exitCode).toBe(3);
    expect(result.errorMessage).toBe("Process exited with code 3");
    expect(result.resultJson?.leftoverProcessSweep).toMatchObject({ stopped: 1 });
  });

  it("records the stopped process in resultJson on a timeout", async () => {
    const runId = `process-sweep-${randomUUID()}`;
    const { result } = await runProcessAdapter(runId, "(setsid sleep 300 &); sleep 30", {
      timeoutSec: 1,
      graceSec: 1,
    });

    expect(result.timedOut).toBe(true);
    expect(result.resultJson?.leftoverProcessSweep).toMatchObject({ stopped: 1 });
  });

  it("leaves resultJson unchanged when nothing was left over", async () => {
    const runId = `process-sweep-${randomUUID()}`;
    const { result } = await runProcessAdapter(runId, "echo done");

    expect(result.resultJson).toEqual({ stdout: "done\n", stderr: "" });
  });
});
