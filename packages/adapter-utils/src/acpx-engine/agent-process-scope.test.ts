import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSystemdIsolationPolicy,
  listScopeRecordRefs,
  OFF_ISOLATION_POLICY,
  scopeUnitNamespace,
  sliceCgroupPath,
  type AgentProcessIsolationPolicy,
} from "@paperclipai/process-launch";
import { prepareSystemdTestEnv } from "@paperclipai/process-launch/systemd-test-env";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "../types.js";
import { configureAgentProcessIsolation, resetAgentProcessIsolation } from "../process-isolation.js";
import { createAcpxAgentScopeOwner } from "./agent-process-scope.js";
import { createAcpxEngineExecutor } from "./execute.js";

const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const echoAgent = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-echo-agent.mjs");
const stopAgent = path.join(repoRoot, "scripts", "mcp-fixtures", "servers", "acp-stop-agent.mjs");
const INSTANCE = "acpscopetest";
const roots: string[] = [];

// The engine reads the server's policy (`getAgentProcessIsolation()`), never a
// per-run value; each test configures it the way server startup does.
function configurePolicy(policy: AgentProcessIsolationPolicy | undefined): void {
  if (policy) configureAgentProcessIsolation({ policy, health: null });
  else resetAgentProcessIsolation();
}

afterEach(async () => {
  resetAgentProcessIsolation();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

// The provider's first action records its own cgroup. It then leaves a
// grandchild in a new session, with an empty environment, that ignores
// SIGTERM: only the scope can still find and stop it.
const WRAPPER = `
import fs from "node:fs";
import { spawn } from "node:child_process";
const root = process.env.PAPERCLIP_SCOPE_FIXTURE_ROOT;
// acpx can relaunch the agent for a close without the run's env; such a
// launch exits at once, as it did before this wrapper waited for anything.
if (!root) process.exit(1);
if (!fs.existsSync(root + "/leftover")) {
  fs.writeFileSync(root + "/cgroup", fs.readFileSync("/proc/self/cgroup", "utf8"));
  const leftoverSource = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
  spawn(process.execPath, ["-e", leftoverSource, root + "/leftover"], { detached: true, env: {}, stdio: "ignore" }).unref();
  // Start the agent only once the leftover ignores SIGTERM.
  while (!fs.existsSync(root + "/leftover")) await new Promise((resolve) => setTimeout(resolve, 10));
}
await import(process.env.PAPERCLIP_SCOPE_FIXTURE_AGENT);
`;

async function wrapperCommand(root: string): Promise<string> {
  const wrapper = path.join(root, "scope-wrapper.mjs");
  await fs.writeFile(wrapper, WRAPPER);
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)}`;
}

describe("off mode", () => {
  async function capturedRuntimeOptions(policy: AgentProcessIsolationPolicy | undefined) {
    const root = await tempRoot("paperclip-acp-scope-off-");
    let captured: Record<string, unknown> | null = null;
    configurePolicy(policy);
    const execute = createAcpxEngineExecutor({
      createRuntime: (options) => {
        captured = options as Record<string, unknown>;
        throw new Error("runtime capture only");
      },
    });
    await execute({
      runId: "scope-off",
      agent: { id: "agent", companyId: "company" },
      runtime: {},
      config: { agent: "custom", agentCommand: "node ./fake-acp.js", mode: "oneshot", stateDir: path.join(root, "state"), cwd: root },
      context: {},
      onLog: async () => {},
    } as unknown as AdapterExecutionContext);
    expect(captured).not.toBeNull();
    return captured!;
  }

  it("passes no launch hook to acpx without a policy or with mode off", async () => {
    expect("spawnAgent" in (await capturedRuntimeOptions(undefined))).toBe(false);
    expect("spawnAgent" in (await capturedRuntimeOptions(OFF_ISOLATION_POLICY))).toBe(false);
    expect(createAcpxAgentScopeOwner({ policy: OFF_ISOLATION_POLICY, kind: "warm_provider", companyId: "c", runId: "r" })).toBeNull();
  });

  it("passes the launch hook when the server's policy is systemd", async () => {
    const root = await tempRoot("paperclip-acp-scope-hook-");
    const policy = createSystemdIsolationPolicy({
      slice: "app-agents.slice",
      instanceId: INSTANCE,
      registryDir: path.join(root, "registry"),
      userBusAddress: null,
    });
    expect(typeof (await capturedRuntimeOptions(policy)).spawnAgent).toBe("function");
  });
});

const systemd = prepareSystemdTestEnv();
afterAll(() => systemd.stop(), 30_000);

describe.skipIf(systemd.skipReason !== null)(
  `legacy ACP in a real scope${systemd.skipReason ? ` (skipped: ${systemd.skipReason})` : ""}`,
  () => {
    function policyFor(root: string) {
      return createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId: INSTANCE,
        registryDir: path.join(root, "registry"),
        userBusAddress: systemd.userBusAddress,
        helperPath: systemd.helper,
      });
    }

    const records = (root: string) => listScopeRecordRefs(path.join(root, "registry"), scopeUnitNamespace(INSTANCE));

    it("runs the provider in its own scope from its first action and reaps its leftovers before the run settles", async () => {
      const root = await tempRoot("paperclip-acp-scope-run-");
      const logs: string[] = [];
      let providerPid: number | undefined;
      // Checked at the boundary itself: what the provider left must be gone
      // before the run treats the provider as stopped, not some time later.
      const atProviderStopped: { provider: boolean; leftover: boolean }[] = [];
      configurePolicy(policyFor(root));
      const result = await createAcpxEngineExecutor()({
        runId: "scope-run",
        agent: { id: "agent", companyId: "company" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: await wrapperCommand(root),
          mode: "oneshot",
          stateDir: path.join(root, "state"),
          cwd: repoRoot,
          env: {
            PAPERCLIP_SCOPE_FIXTURE_ROOT: root,
            PAPERCLIP_SCOPE_FIXTURE_AGENT: echoAgent,
            PAPERCLIP_ACPX_SPAWN_SMOKE: "scope-ok",
          },
        },
        context: {},
        onSpawn: async ({ pid }: { pid: number }) => { providerPid = pid; },
        onLog: async (_stream: string, text: string) => { logs.push(text); },
        onMeta: async () => {},
        onProviderStopped: async () => {
          const leftover = Number(await fs.readFile(path.join(root, "leftover"), "utf8"));
          atProviderStopped.push({ provider: alive(providerPid!), leftover: alive(leftover) });
        },
      } as unknown as AdapterExecutionContext);
      const leftoverAliveAtReturn = alive(Number(await fs.readFile(path.join(root, "leftover"), "utf8")));

      expect(result.exitCode, JSON.stringify({ result, logs }, null, 2)).toBe(0);
      expect(atProviderStopped).toEqual([{ provider: false, leftover: false }]);
      expect(leftoverAliveAtReturn).toBe(false);
      expect(result.resultJson).not.toHaveProperty("agentProcessScopeCleanup");
      expect(logs.join("")).toContain("scope-ok");
      expect(logs.join("")).toMatch(/Agent process scope: enrolled in pcagent-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+\.scope\./);
      const cgroup = (await fs.readFile(path.join(root, "cgroup"), "utf8")).trim();
      expect(cgroup).toMatch(new RegExp(`^0::.*${sliceCgroupPath(systemd.slice)}/pcagent-[0-9a-f-]+\\.scope$`));
      expect(providerPid).toBeTypeOf("number");
      // The leftover ignores SIGTERM, so it is gone only after the SIGKILL step.
      expect(records(root)).toEqual([]);
    }, 40_000);

    it("a forced Stop stops the provider's whole scope, including a setsid grandchild", async () => {
      const root = await tempRoot("paperclip-acp-scope-stop-");
      const abort = new AbortController();
      let ready!: () => void;
      const started = new Promise<void>((resolve) => { ready = resolve; });
      let providerPid: number | undefined;
      configurePolicy(policyFor(root));
      const running = createAcpxEngineExecutor()({
        runId: "scope-stop",
        agent: { id: "agent", companyId: "company" },
        runtime: {},
        config: {
          agent: "custom",
          agentCommand: await wrapperCommand(root),
          mode: "persistent",
          stateDir: path.join(root, "state"),
          cwd: root,
          graceSec: 1,
          env: {
            PAPERCLIP_SCOPE_FIXTURE_ROOT: root,
            PAPERCLIP_SCOPE_FIXTURE_AGENT: stopAgent,
            PAPERCLIP_STOP_FIXTURE_ROOT: root,
            PAPERCLIP_STOP_FIXTURE_HANG_ON_CLOSE: "1",
          },
        },
        context: {},
        signal: abort.signal,
        onSpawn: async ({ pid }: { pid: number }) => { providerPid = pid; },
        onLog: async (_stream: string, text: string) => { if (text.includes("Waiting for Stop.")) ready(); },
      } as unknown as AdapterExecutionContext);
      await started;
      const leftover = Number(await fs.readFile(path.join(root, "leftover"), "utf8"));
      expect(alive(leftover)).toBe(true);
      abort.abort();
      const result = await running;
      expect(result.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged", forced: true });
      expect(providerPid).toBeTypeOf("number");
      expect(alive(providerPid!)).toBe(false);
      expect(await waitFor(() => !alive(leftover), 5_000)).toBe(true);
      expect(await waitFor(() => records(root).length === 0, 5_000)).toBe(true);
    }, 30_000);

    it("a stale run cannot stop a provider that another run now owns", async () => {
      const root = await tempRoot("paperclip-acp-scope-stale-");
      const owner = createAcpxAgentScopeOwner({
        policy: policyFor(root),
        kind: "warm_provider",
        companyId: "company",
        runId: "run-a",
      })!;
      expect(owner.owner.kind).toBe("warm_provider");
      expect(owner.owner.id).not.toBe("run-a");
      const child = owner.spawnAgent({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
      });
      await new Promise((resolve) => child.once("spawn", resolve));
      expect(await waitFor(() => owner.current?.readEnrollment()?.outcome === "enrolled", 5_000)).toBe(true);

      // Warm reuse hands the provider to run B.
      owner.associate("run-b");
      expect(owner.forceStop("run-a")).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(alive(child.pid!)).toBe(true);

      const stopped = await owner.forceStop("run-b");
      expect(stopped?.outcome).toBe("terminated");
      expect(stopped?.containment).toBe("scope");
      expect(await waitFor(() => !alive(child.pid!), 5_000)).toBe(true);
      await owner.idle();
      expect(records(root)).toEqual([]);
    }, 20_000);

    it("reap leaves a retained provider alone and reports one that was stopped but kept running", async () => {
      const root = await tempRoot("paperclip-acp-scope-reap-");
      const owner = createAcpxAgentScopeOwner({
        policy: policyFor(root),
        kind: "warm_provider",
        companyId: "company",
        runId: "run-a",
      })!;
      const child = owner.spawnAgent({
        command: process.execPath,
        args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
        options: { stdio: ["pipe", "pipe", "pipe"] },
      });
      await new Promise((resolve) => child.once("spawn", resolve));
      expect(await waitFor(() => owner.current?.readEnrollment()?.outcome === "enrolled", 5_000)).toBe(true);

      // Warm retention: nothing ran, nothing to report, the provider lives on.
      expect(await owner.reap()).toBeNull();
      expect(alive(child.pid!)).toBe(true);
      // The run says it stopped the provider, but it is still running.
      expect(await owner.reap({ waitForExitMs: 200 })).toEqual({ outcome: "unconfirmed", reason: "provider_still_running" });
      expect(alive(child.pid!)).toBe(true);

      const stopped = await owner.forceStop("run-a");
      expect(stopped?.outcome).toBe("terminated");
      expect(await owner.reap({ waitForExitMs: 5_000 })).toEqual({ outcome: "confirmed" });
      expect(alive(child.pid!)).toBe(false);
      expect(records(root)).toEqual([]);
    }, 20_000);

    it("degrades to one plain spawn when the user bus is wrong, and still reaps the record", async () => {
      const root = await tempRoot("paperclip-acp-scope-degraded-");
      const owner = createAcpxAgentScopeOwner({
        policy: createSystemdIsolationPolicy({
          slice: systemd.slice,
          instanceId: INSTANCE,
          registryDir: path.join(root, "registry"),
          userBusAddress: "unix:path=/nonexistent/paperclip-acp-scope-test-bus",
          helperPath: systemd.helper,
        }),
        kind: "run",
        ownerId: "run-degraded",
        companyId: "company",
        runId: "run-degraded",
      })!;
      const child = owner.spawnAgent({ command: process.execPath, args: ["-e", "process.stdout.write('once')"], options: {} });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      await new Promise((resolve) => child.once("close", resolve));
      expect(output).toBe("once");
      expect(owner.current).toBeNull();
      await owner.idle();
      expect(records(root)).toEqual([]);
    }, 20_000);
  },
);
