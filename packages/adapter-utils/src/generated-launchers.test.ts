import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { githubLauncherSource } from "./github-launcher.js";
import { resetAgentProcessIsolation } from "./process-isolation.js";
import { runChildProcess } from "./server-utils.js";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "./test-support/isolation-fixture.js";

const temp: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "au-genl-"));
  temp.push(dir);
  return dir;
}

/** Installs the real generated launcher as `git` ahead of a fake "real" git that reports its own cgroup. */
async function installLauncher(): Promise<{ managed: string; pathValue: string }> {
  const root = await tempDir();
  const managed = path.join(root, "managed");
  const real = path.join(root, "real");
  await fs.mkdir(managed);
  await fs.mkdir(real);
  await fs.writeFile(path.join(managed, "git"), githubLauncherSource(), { mode: 0o755 });
  await fs.writeFile(path.join(real, "git"), "#!/bin/sh\ncat /proc/self/cgroup\n", { mode: 0o755 });
  return { managed, pathValue: [managed, real, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter) };
}

afterEach(async () => {
  resetAgentProcessIsolation();
  await Promise.all(temp.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("generated github launcher", () => {
  it("never detaches or re-parents the real command", () => {
    const source = githubLauncherSource();
    for (const forbidden of ["detached: true", "setsid", "systemd-run", "unshare", "nohup"]) {
      expect(source).not.toContain(forbidden);
    }
  });

  describe("under a live user manager", () => {
    let live: LiveIsolation;
    let configured: ConfiguredIsolation | null = null;

    beforeAll(async () => {
      live = await prepareLiveIsolation();
    });
    afterAll(() => live?.cleanup());
    afterEach(() => configured?.health.stop());

    it("the real git it starts stays in the agent scope of the process that invoked the launcher", async (ctx) => {
      if (live.skip) ctx.skip(`skipped, ${live.skip}`);
      configured = configureTestIsolation({ registryDir: await tempDir(), helperPath: live.helper, slice: live.slice });
      const { managed, pathValue } = await installLauncher();
      const chunks: string[] = [];
      const result = await runChildProcess(randomUUID(), "git", ["status"], {
        cwd: managed,
        env: { PATH: pathValue },
        timeoutSec: 20,
        graceSec: 2,
        onLog: async (_stream, chunk) => {
          chunks.push(chunk);
        },
      });
      expect(result.exitCode, chunks.join("")).toBe(0);
      expect(chunks.join("")).toContain(`/${live.slice}/`);
    });
  });
});
