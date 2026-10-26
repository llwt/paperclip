import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSystemdIsolationPolicy,
  listScopeRecordRefs,
  OFF_ISOLATION_POLICY,
  scopeUnitNamespace,
  sliceCgroupPath,
  type IsolationHealth,
} from "@paperclipai/process-launch";
import { prepareSystemdTestEnv } from "@paperclipai/process-launch/systemd-test-env";
import { configureAgentProcessIsolation, resetAgentProcessIsolation } from "@paperclipai/adapter-utils/server-utils";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { ProcessCodexAppServerTransport } from "@paperclipai/paperclip-runner";
import { createNativeLaunchRoots, type NativeLaunchRoot } from "./native-process-isolation.js";

const roots: string[] = [];
// Leftovers a test made, by validated PID: stopped also when an assertion fails.
const owned: number[] = [];
afterEach(async () => {
  owned.splice(0).forEach(killOwned);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The PID a fixture wrote, only when it names one other process. 0, negative
 * numbers and 1 would signal a process group, every process or init.
 */
function ownedPid(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid ? pid : undefined;
}

/** Waits for a fixture's PID file; fails, without a signal, if no valid PID comes. */
async function waitForOwnedPid(file: string, attempts = 500): Promise<number> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pid = ownedPid(await readFile(file, "utf8").catch(() => ""));
    if (pid !== undefined) {
      owned.push(pid);
      return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`leftover PID file not written in time: ${file}`);
}

function killOwned(pid: number | undefined): void {
  if (pid === undefined || ownedPid(String(pid)) !== pid) return;
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

const anyPolicy = (registryDir = join(tmpdir(), "unused-registry")) => createSystemdIsolationPolicy({
  slice: "app-agents.slice",
  instanceId: "nativescopetest",
  registryDir,
  userBusAddress: null,
});

/** A root that appends one line per execution, so a second run would show. */
async function countedRoot(launcher: NativeLaunchRoot, counter: string) {
  const child = launcher.spawn("sh", ["-c", 'echo ran >> "$1"', "sh", counter], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));
  await launcher.reaped(child);
  return (await readFile(counter, "utf8")).split("\n").filter(Boolean).length;
}

describe("owned leftover PIDs", () => {
  // Above any pid_max, so even an unmocked signal could reach no process.
  const validPid = 4_194_304;

  it("accepts only a PID that names one other process", () => {
    expect(ownedPid(String(validPid))).toBe(validPid);
    expect(ownedPid(` ${validPid}\n`)).toBe(validPid);
    for (const text of ["", "0", "-5", "1", "abc", "12abc", "1e3", String(process.pid), "9007199254740993"]) {
      expect(ownedPid(text)).toBeUndefined();
    }
  });

  it("sends no signal for invalid PID file content, and only a probe then SIGKILL to a valid one", async () => {
    const live = new Set<number>();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (!live.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    });
    try {
      for (const text of ["", "0", "-5", "1", "abc", String(process.pid)]) killOwned(ownedPid(text));
      expect(kill).not.toHaveBeenCalled();

      killOwned(ownedPid(String(validPid)));
      expect(kill.mock.calls).toEqual([[validPid, 0]]);
      kill.mockClear();
      live.add(validPid);
      killOwned(ownedPid(String(validPid)));
      expect(kill.mock.calls).toEqual([[validPid, 0], [validPid, "SIGKILL"]]);

      // A wait that never sees a valid PID fails and signals nothing.
      kill.mockClear();
      const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-pid-"));
      roots.push(root);
      for (const text of ["", "0", "-5", "1", "abc", String(process.pid)]) {
        await writeFile(join(root, "leftover"), text);
        await expect(waitForOwnedPid(join(root, "leftover"), 2)).rejects.toThrow("leftover PID file not written in time");
      }
      expect(owned).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
});

describe("createNativeLaunchRoots", () => {
  it("gives no launcher when isolation is absent or off", () => {
    resetAgentProcessIsolation();
    expect(createNativeLaunchRoots({ companyId: "company-1" }).root("runner", "runner-1")).toBeUndefined();
    const off = createNativeLaunchRoots({ companyId: "company-1", runtime: { policy: OFF_ISOLATION_POLICY, health: null } });
    expect(off.root("runner", "runner-1")).toBeUndefined();
  });

  it("uses the server's configured policy by default", () => {
    configureAgentProcessIsolation({ policy: anyPolicy(), health: null });
    try {
      expect(createNativeLaunchRoots({ companyId: "company-1" }).root("runner", "runner-1")).toBeDefined();
    } finally {
      resetAgentProcessIsolation();
    }
  });

  it("runs a root whose ids cannot name a scope once, plainly, and logs the degraded marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-ids-"));
    roots.push(root);
    const logs: string[] = [];
    const roots_ = createNativeLaunchRoots({
      companyId: "company/1",
      runtime: { policy: anyPolicy(join(root, "registry")), health: null },
      onLog: async (_stream, line) => { logs.push(line); },
    });
    expect(await countedRoot(roots_.root("runner", "runner-1")!, join(root, "counter"))).toBe(1);
    const summary = await roots_.settle();
    expect(summary?.degraded).toEqual([expect.objectContaining({ state: "degraded", reason: "invalid_owner_id" })]);
    expect(summary?.cleanupUnconfirmed).toBeNull();
    expect(logs.join("")).toContain("agent process isolation degraded (reason=invalid_owner_id");
  });

  it("runs a root plainly while host health says not to try, and logs why", async () => {
    const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-health-"));
    roots.push(root);
    const logs: string[] = [];
    const health = { shouldAttempt: () => false, currentFailure: () => "helper_missing" } as unknown as IsolationHealth;
    const roots_ = createNativeLaunchRoots({
      companyId: "company-1",
      runtime: { policy: anyPolicy(join(root, "registry")), health },
      onLog: async (_stream, line) => { logs.push(line); },
    });
    expect(await countedRoot(roots_.root("warm_provider", "runner-1")!, join(root, "counter"))).toBe(1);
    expect((await roots_.settle())?.degraded).toEqual([expect.objectContaining({ reason: "helper_missing" })]);
    expect(logs.join("")).toContain("agent process isolation degraded (reason=helper_missing");
  });
});

const systemd = prepareSystemdTestEnv();
afterAll(() => systemd.stop(), 30_000);

describe.skipIf(systemd.skipReason !== null)(
  `native runner root in a real scope${systemd.skipReason ? ` (skipped: ${systemd.skipReason})` : ""}`,
  () => {
    it("starts the root in its own scope and stops what it leaves behind once it exits", async () => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-"));
      roots.push(root);
      const policy = createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId: "nativescopetest",
        registryDir: join(root, "registry"),
        userBusAddress: systemd.userBusAddress,
        helperPath: systemd.helper,
      });
      // Stands in for a runner: records its cgroup first, leaves a setsid
      // grandchild with an empty env that ignores SIGTERM, then exits.
      const script = join(root, "runner.mjs");
      const leftoverFile = join(root, "leftover");
      const leftoverSource = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(leftoverFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      await writeFile(script, [
        'import fs from "node:fs";',
        'import { spawn } from "node:child_process";',
        `fs.writeFileSync(${JSON.stringify(join(root, "cgroup"))}, fs.readFileSync("/proc/self/cgroup", "utf8"));`,
        `spawn(process.execPath, ["-e", ${JSON.stringify(leftoverSource)}], { detached: true, env: {}, stdio: "ignore" }).unref();`,
        // Exit only once the leftover ignores SIGTERM.
        `const ready = setInterval(() => { if (fs.existsSync(${JSON.stringify(leftoverFile)})) clearInterval(ready); }, 10);`,
      ].join("\n"));
      const logs: string[] = [];
      const launchRoots = createNativeLaunchRoots({
        companyId: "company-1",
        runtime: { policy, health: null },
        onLog: async (_stream, line) => { logs.push(line); },
      });
      const launcher = launchRoots.root("runner", "runner-scope-test")!;
      const child = launcher.spawn(process.execPath, [script], { detached: true, stdio: "ignore" });
      await new Promise((resolve) => child.once("exit", resolve));
      const exitedAt = Date.now();
      const leftover = await waitForOwnedPid(leftoverFile);
      expect(alive(leftover)).toBe(true);
      // The completion boundary: once reaped, nothing the root left is alive.
      expect(await launcher.reaped(child)).toEqual({ confirmed: true });
      expect(alive(leftover)).toBe(false);
      // It ignores SIGTERM, so it is gone only after the SIGKILL step.
      expect(Date.now() - exitedAt).toBeGreaterThan(1_000);
      expect(await launchRoots.settle()).toBeNull();
      expect(logs).toEqual([]);

      expect((await readFile(join(root, "cgroup"), "utf8")).trim()).toMatch(
        new RegExp(`^0::.*${sliceCgroupPath(systemd.slice)}/pcagent-[0-9a-f-]+\\.scope$`),
      );
      expect(listScopeRecordRefs(join(root, "registry"), scopeUnitNamespace("nativescopetest"))).toEqual([]);
    }, 30_000);

    it("closes an in-process Codex app-server only once its scope is empty", async () => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-codex-"));
      roots.push(root);
      const policy = createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId: "nativescopetest",
        registryDir: join(root, "registry"),
        userBusAddress: systemd.userBusAddress,
        helperPath: systemd.helper,
      });
      // Stands in for `codex app-server`: leaves a setsid grandchild that
      // ignores SIGTERM, then runs until the transport stops it.
      const script = join(root, "app-server.mjs");
      const leftoverFile = join(root, "leftover");
      const leftoverSource = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(leftoverFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      await writeFile(script, [
        'import { spawn } from "node:child_process";',
        `spawn(process.execPath, ["-e", ${JSON.stringify(leftoverSource)}], { detached: true, env: {}, stdio: "ignore" }).unref();`,
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      const launchRoots = createNativeLaunchRoots({ companyId: "company-1", runtime: { policy, health: null } });
      const transport = new ProcessCodexAppServerTransport({
        command: process.execPath,
        args: [script],
        environment: { PATH: process.env.PATH },
        processGroup: true,
        processIsolation: launchRoots.root("warm_provider", "provider-scope-test"),
      });
      const leftover = await waitForOwnedPid(leftoverFile);
      expect(alive(leftover)).toBe(true);
      // The collection boundary: when close resolves, nothing the provider
      // left can still write its files.
      await transport.close();
      expect(transport.processInfo().exited).toBe(true);
      expect(alive(leftover)).toBe(false);
      expect(await launchRoots.settle()).toBeNull();
      expect(listScopeRecordRefs(join(root, "registry"), scopeUnitNamespace("nativescopetest"))).toEqual([]);
    }, 30_000);

    it("keeps an unconfirmed cleanup for every later close, also after settlement", async () => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-sticky-"));
      roots.push(root);
      const registryDir = join(root, "registry");
      const policy = createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId: "nativescopetest",
        registryDir,
        userBusAddress: systemd.userBusAddress,
        helperPath: systemd.helper,
      });
      const launchRoots = createNativeLaunchRoots({ companyId: "company-1", runtime: { policy, health: null } });
      const launcher = launchRoots.root("warm_provider", "provider-sticky-test")!;
      let provider: ChildProcess | undefined;
      const transport = new ProcessCodexAppServerTransport({
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        environment: { PATH: process.env.PATH },
        processGroup: true,
        processIsolation: {
          spawn: (command, args, options) => (provider = launcher.spawn(command, args, options)),
          reaped: (child) => launcher.reaped(child),
        },
      });
      // Only this test's scratch record is damaged, so its cleanup cannot be
      // confirmed. The scope itself goes away with its only process.
      let refs: ReturnType<typeof listScopeRecordRefs> = [];
      for (let attempt = 0; attempt < 500 && refs.length === 0; attempt += 1) {
        refs = listScopeRecordRefs(registryDir, scopeUnitNamespace("nativescopetest"));
        if (refs.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(refs).toHaveLength(1);
      await writeFile(join(registryDir, `${refs[0]!.unit}.json`), "{");

      await expect(transport.close()).rejects.toMatchObject({ name: "LaunchRootCleanupUnconfirmedError", reason: "record_unreadable" });
      expect(await launchRoots.settle()).toMatchObject({ cleanupUnconfirmed: "record_unreadable" });
      // After settlement, the launcher still returns the recorded outcome, and
      // a repeated close still fails with it.
      expect(await launcher.reaped(provider!)).toEqual({ confirmed: false, reason: "record_unreadable" });
      await expect(transport.close()).rejects.toMatchObject({ reason: "record_unreadable" });
      expect(await launchRoots.settle()).toMatchObject({ cleanupUnconfirmed: "record_unreadable" });
    }, 30_000);

    it("never confirms a cleanup whose record went missing, also after settlement", async () => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-missing-"));
      roots.push(root);
      const registryDir = join(root, "registry");
      const policy = createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId: "nativescopetest",
        registryDir,
        userBusAddress: systemd.userBusAddress,
        helperPath: systemd.helper,
      });
      // Stands in for `codex app-server`: leaves a setsid grandchild that
      // ignores SIGTERM, then runs until the transport stops it.
      const script = join(root, "app-server.mjs");
      const leftoverFile = join(root, "leftover");
      const leftoverSource = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(leftoverFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      await writeFile(script, [
        'import { spawn } from "node:child_process";',
        `spawn(process.execPath, ["-e", ${JSON.stringify(leftoverSource)}], { detached: true, env: {}, stdio: "ignore" }).unref();`,
        "setInterval(() => {}, 1000);",
      ].join("\n"));
      const logs: string[] = [];
      const launchRoots = createNativeLaunchRoots({
        companyId: "company-1",
        runtime: { policy, health: null },
        onLog: async (_stream, line) => { logs.push(line); },
      });
      const launcher = launchRoots.root("warm_provider", "provider-missing-test")!;
      let provider: ChildProcess | undefined;
      const transport = new ProcessCodexAppServerTransport({
        command: process.execPath,
        args: [script],
        environment: { PATH: process.env.PATH },
        processGroup: true,
        processIsolation: {
          spawn: (command, args, options) => (provider = launcher.spawn(command, args, options)),
          reaped: (child) => launcher.reaped(child),
        },
      });
      const leftover = await waitForOwnedPid(leftoverFile);
      expect(alive(leftover)).toBe(true);
      // Only this test's scratch record is removed: the cleanup can no longer
      // check the scope, so it must not report it empty.
      const refs = listScopeRecordRefs(registryDir, scopeUnitNamespace("nativescopetest"));
      expect(refs).toHaveLength(1);
      await rm(join(registryDir, `${refs[0]!.unit}.json`));
      // The leftover is stopped by afterEach, by its validated PID; its scope then empties.
      await expect(transport.close()).rejects.toMatchObject({ name: "LaunchRootCleanupUnconfirmedError", reason: "missing_record" });
      expect(alive(leftover)).toBe(true);
      expect(await launchRoots.settle()).toMatchObject({ cleanupUnconfirmed: "missing_record" });
      expect(await launcher.reaped(provider!)).toEqual({ confirmed: false, reason: "missing_record" });
      await expect(transport.close()).rejects.toMatchObject({ reason: "missing_record" });
      expect(await launchRoots.settle()).toMatchObject({ cleanupUnconfirmed: "missing_record" });
      expect(logs.filter((line) => line.includes("cleanup was not confirmed (reason=missing_record)"))).toHaveLength(1);
    }, 30_000);

    it("runs the root once outside the slice when enrollment fails, and logs the degraded marker", async () => {
      const root = await mkdtemp(join(tmpdir(), "paperclip-native-scope-degraded-"));
      roots.push(root);
      const logs: string[] = [];
      const launchRoots = createNativeLaunchRoots({
        companyId: "company-1",
        runtime: {
          policy: createSystemdIsolationPolicy({
            slice: systemd.slice,
            instanceId: "nativescopetest",
            registryDir: join(root, "registry"),
            userBusAddress: "unix:path=/nonexistent/paperclip-native-scope-test-bus",
            helperPath: systemd.helper,
          }),
          health: null,
        },
        onLog: async (_stream, line) => { logs.push(line); },
      });
      expect(await countedRoot(launchRoots.root("runner", "runner-degraded")!, join(root, "counter"))).toBe(1);
      const summary = await launchRoots.settle();
      expect(summary?.degraded).toEqual([expect.objectContaining({ state: "degraded", reason: "user_bus_unavailable" })]);
      expect(logs.join("")).toContain("agent process isolation degraded (reason=user_bus_unavailable");
      expect(listScopeRecordRefs(join(root, "registry"), scopeUnitNamespace("nativescopetest"))).toEqual([]);
    }, 30_000);
  },
);
