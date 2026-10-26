import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentProcessIsolation } from "./process-isolation.js";
import { executeConformingExternalAdapter } from "./test-support/external-adapter-fixture.js";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "./test-support/isolation-fixture.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const temp: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "au-ext-"));
  temp.push(dir);
  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

afterEach(async () => {
  resetAgentProcessIsolation();
  await Promise.all(temp.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("external adapter launch contract", () => {
  it("the conforming fixture has no launch site of its own (the --external check accepts it)", async () => {
    const dir = await tempDir();
    await fs.copyFile(path.join(repoRoot, "packages/adapter-utils/src/test-support/external-adapter-fixture.ts"), path.join(dir, "execute.ts"));
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/check-process-launch-coverage.mjs"), "--external", dir], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("with isolation off the fixture is a plain launch and still stops its descendants on timeout", async () => {
    const pidFile = path.join(await tempDir(), "pid");
    const logs: string[] = [];
    const result = await executeConformingExternalAdapter({
      runId: randomUUID(),
      config: { command: "/bin/sh", args: ["-c", `sleep 300 & echo $! > ${pidFile}; wait`], timeoutSec: 1, graceSec: 1 },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
    });
    expect(result.timedOut).toBe(true);
    const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });

  describe("under a live user manager", () => {
    let live: LiveIsolation;
    let configured: ConfiguredIsolation | null = null;

    beforeAll(async () => {
      live = await prepareLiveIsolation();
    });
    afterAll(() => live?.cleanup());
    afterEach(() => configured?.health.stop());

    const liveCase = (name: string, fn: () => Promise<void>) =>
      it(name, async (ctx) => {
        if (live.skip) ctx.skip(`skipped, ${live.skip}`);
        configured = configureTestIsolation({ registryDir: await tempDir(), helperPath: live.helper, slice: live.slice });
        await fn();
      });

    liveCase("starts the provider inside the agent scope before its first instruction", async () => {
      const chunks: string[] = [];
      const result = await executeConformingExternalAdapter({
        runId: randomUUID(),
        config: { command: "/bin/sh", args: ["-c", "cat /proc/self/cgroup"] },
        onLog: async (_stream, chunk) => {
          chunks.push(chunk);
        },
      });
      expect(result.exitCode).toBe(0);
      expect(chunks.join("")).toContain(`/${live.slice}/`);
    });

    liveCase("stops a descendant that left the process group when the run times out", async () => {
      const pidFile = path.join(await tempDir(), "pid");
      const result = await executeConformingExternalAdapter({
        runId: randomUUID(),
        config: {
          command: "/bin/sh",
          args: ["-c", `setsid env -i /bin/sh -c 'echo $$ > ${pidFile}; exec sleep 300' & while :; do sleep 0.05; done`],
          timeoutSec: 1,
          graceSec: 1,
        },
        onLog: async () => {},
      });
      expect(result.timedOut).toBe(true);
      const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
      expect(await waitFor(() => !isAlive(pid))).toBe(true);
    });

    liveCase("an adapter that spawns for itself is NOT in the agent scope (why the contract matters)", async () => {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", "cat /proc/self/cgroup"], { stdio: ["ignore", "pipe", "inherit"] });
        let text = "";
        child.stdout.on("data", (chunk) => {
          text += String(chunk);
        });
        child.on("error", reject);
        child.on("close", () => resolve(text));
      });
      expect(output).not.toContain(`/${live.slice}/`);
    });
  });
});
