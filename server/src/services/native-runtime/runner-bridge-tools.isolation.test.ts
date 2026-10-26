import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentProcessIsolation } from "@paperclipai/adapter-utils/process-isolation";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "@paperclipai/adapter-utils/test-support/isolation-fixture";
import { executeWorkspaceTool, workspaceCommandSandboxAvailable } from "./runner-bridge-tools.js";

const dirs: string[] = [];
const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const pgrep = (pattern: string) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim();
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe.skipIf(!workspaceCommandSandboxAvailable())("workspace_run under a live user manager", () => {
  let live: LiveIsolation;
  let configured: ConfiguredIsolation | null = null;

  beforeAll(async () => {
    live = await prepareLiveIsolation();
  });
  afterAll(() => live?.cleanup());
  afterEach(async () => {
    configured?.health.stop();
    resetAgentProcessIsolation();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("starts in a run scope and leaves no descendant after authority loss", async (ctx) => {
    if (live.skip) ctx.skip(`skipped, ${live.skip}`);
    const registryDir = await tempDir("wr-reg-");
    const workspace = await tempDir("wr-ws-");
    configured = configureTestIsolation({ registryDir, helperPath: live.helper, slice: live.slice });
    const marker = `301.${randomInt(100000, 999999)}`;
    const owners: Array<{ kind: string; id: string; companyId: string | null }> = [];
    const readOwners = async () => {
      for (const name of await readdir(registryDir)) {
        const parsed = JSON.parse(await readFile(join(registryDir, name), "utf8").catch(() => "{}")) as {
          owner?: { kind: string; id: string; companyId: string | null };
        };
        if (parsed.owner) owners.push(parsed.owner);
      }
    };
    let calls = 0;
    const result = await executeWorkspaceTool(
      workspace,
      "workspace_run",
      { program: "/bin/sh", args: ["-c", `sleep ${marker} & sleep ${marker}`] },
      async () => {
        if (++calls <= 2 || pgrep(`sleep ${marker}`) === "") return;
        await readOwners();
        throw new Error("revoked");
      },
      { runId: "run-under-test", companyId: "company-under-test" },
    );
    expect(result).toMatchObject({ stopped: "authority_revoked" });
    expect(owners[0]).toEqual({ kind: "run", id: "run-under-test", companyId: "company-under-test" });
    expect(await waitFor(() => pgrep(`sleep ${marker}`) === "")).toBe(true);
  });
});
