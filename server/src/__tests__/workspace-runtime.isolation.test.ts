import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentProcessIsolation } from "@paperclipai/adapter-utils/process-isolation";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "@paperclipai/adapter-utils/test-support/isolation-fixture";
import {
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
  stopRuntimeServicesForExecutionWorkspace,
  type RealizedExecutionWorkspace,
} from "../services/workspace-runtime.js";

const pgrep = (pattern: string) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout.trim();
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

describe("managed runtime service under a live user manager", () => {
  let live: LiveIsolation;
  let configured: ConfiguredIsolation | null = null;
  const dirs: string[] = [];

  beforeAll(async () => {
    live = await prepareLiveIsolation();
  });
  afterAll(() => live?.cleanup());
  afterEach(async () => {
    await resetRuntimeServicesForTests();
    configured?.health.stop();
    resetAgentProcessIsolation();
    delete process.env.PAPERCLIP_HOME;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("runs the service in a managed_service scope that keeps running until it is stopped", async (ctx) => {
    if (live.skip) ctx.skip(`skipped, ${live.skip}`);
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rt-iso-ws-"));
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "rt-iso-reg-"));
    dirs.push(workspaceRoot, registryDir);
    process.env.PAPERCLIP_HOME = workspaceRoot;
    process.env.PAPERCLIP_INSTANCE_ID = `rt-iso-${randomUUID()}`;
    configured = configureTestIsolation({ registryDir, helperPath: live.helper, slice: live.slice });

    const marker = `302.${randomInt(100000, 999999)}`;
    const workspace: RealizedExecutionWorkspace = {
      baseCwd: workspaceRoot,
      source: "project_primary",
      projectId: "project-1",
      workspaceId: "workspace-1",
      repoUrl: null,
      repoRef: "HEAD",
      strategy: "project_primary",
      cwd: workspaceRoot,
      branchName: null,
      worktreePath: null,
      warnings: [],
      created: false,
      branchCreatedByRuntime: false,
    };
    const started = await startRuntimeServicesForWorkspaceControl({
      invocationId: randomUUID(),
      actor: { id: "agent-1", name: "Agent", companyId: "company-1" },
      issue: { id: "issue-1", identifier: "SX-1", title: "service scope" },
      workspace,
      executionWorkspaceId: "execution-workspace-1",
      config: {
        workspaceRuntime: {
          services: [
            {
              name: "web",
              command: `sleep ${marker} & ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
              lifecycle: "shared",
              reuseScope: "execution_workspace",
              stopPolicy: { type: "manual" },
            },
          ],
        },
      },
      adapterEnv: {},
    });
    expect(started).toHaveLength(1);

    const owners: Array<{ kind: string; id: string; companyId: string | null }> = [];
    for (const name of await fs.readdir(registryDir)) {
      const parsed = JSON.parse(await fs.readFile(path.join(registryDir, name), "utf8").catch(() => "{}")) as {
        owner?: { kind: string; id: string; companyId: string | null };
      };
      if (parsed.owner) owners.push(parsed.owner);
    }
    expect(owners).toHaveLength(1);
    expect(owners[0]).toMatchObject({ kind: "managed_service", companyId: "company-1" });

    // Nothing reaps the service while it is managed.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(pgrep(`sleep ${marker}`)).not.toBe("");

    await stopRuntimeServicesForExecutionWorkspace({
      executionWorkspaceId: "execution-workspace-1",
      workspaceCwd: workspaceRoot,
    });
    expect(await waitFor(() => pgrep(`sleep ${marker}`) === "")).toBe(true);
  });
});
