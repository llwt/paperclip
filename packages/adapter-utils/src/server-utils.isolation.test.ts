import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scopeUnitNamespace } from "@paperclipai/process-launch";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentProcessIsolation, terminateOwnedScope, scopeTerminationSettled } from "./process-isolation.js";
import { runChildProcess, runningProcesses, type RunProcessResult } from "./server-utils.js";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "./test-support/isolation-fixture.js";

const temp: string[] = [];
async function tempDir(prefix = "au-iso-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
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

interface RunOptions {
  runId?: string;
  companyId?: string;
  timeoutSec?: number;
  graceSec?: number;
  extra?: Partial<Parameters<typeof runChildProcess>[3]>;
}

function run(command: string, args: string[], options: RunOptions = {}) {
  const logs: Array<{ stream: string; chunk: string }> = [];
  const promise = runChildProcess(options.runId ?? randomUUID(), command, args, {
    cwd: process.cwd(),
    env: options.companyId ? { PAPERCLIP_COMPANY_ID: options.companyId } : {},
    timeoutSec: options.timeoutSec ?? 20,
    graceSec: options.graceSec ?? 1,
    onLog: async (stream, chunk) => {
      logs.push({ stream, chunk });
    },
    ...options.extra,
  });
  return { promise, logs };
}

const sh = (script: string): [string, string[]] => ["/bin/sh", ["-c", script]];
const degradedLines = (logs: Array<{ stream: string; chunk: string }>) =>
  logs.filter((entry) => entry.chunk.includes("agent process isolation degraded"));

afterEach(async () => {
  resetAgentProcessIsolation();
  await Promise.all(temp.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("runChildProcess with isolation off", () => {
  it("is the plain spawn path with no isolation evidence", async () => {
    const { promise } = run(...sh("echo plain"));
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("plain");
    expect(result.processIsolation).toBeUndefined();
  });

  it("registers no owned scope and keeps the process-group kill on timeout", async () => {
    const runId = randomUUID();
    const { promise } = run(
      "/bin/sh",
      ["-c", "sleep 300 & echo $!; wait"],
      { runId, timeoutSec: 1, graceSec: 1 },
    );
    await waitFor(() => runningProcesses.has(runId));
    expect(runningProcesses.get(runId)?.ownedScope ?? null).toBeNull();
    const result = await promise;
    expect(result.timedOut).toBe(true);
    const pid = Number.parseInt(result.stdout.trim(), 10);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });
});

describe("runChildProcess when isolation cannot be used", () => {
  let configured: ConfiguredIsolation;

  afterEach(() => configured?.health.stop());

  it("runs normally, logs a degraded marker in the run and warns once per episode", async () => {
    configured = configureTestIsolation({ registryDir: await tempDir(), helperPath: "/nonexistent/paperclip-scope-exec", slice: "app-agents.slice" });
    await configured.health.start();

    const first = run(...sh("echo one"));
    const second = run(...sh("echo two"));
    const [a, b] = [await first.promise, await second.promise];

    expect(a.exitCode).toBe(0);
    expect(a.stdout.trim()).toBe("one");
    expect(b.stdout.trim()).toBe("two");
    expect(a.processIsolation).toMatchObject({ mode: "systemd", state: "degraded", slice: "app-agents.slice", reason: "helper_missing" });
    for (const logs of [first.logs, second.logs]) {
      const lines = degradedLines(logs);
      expect(lines).toHaveLength(1);
      expect(lines[0]!.stream).toBe("stderr");
      expect(lines[0]!.chunk).toContain("slice=app-agents.slice");
      expect(lines[0]!.chunk).toContain("normal execution used");
    }
    expect(configured.logger.warnings).toHaveLength(1);
    expect(configured.logger.warnings[0]!.message).toContain("helper_missing");
    expect(configured.logger.warnings[0]!.message).toContain("normal execution used");
  });

  it("keeps the process-group kill for a fallback run", async () => {
    configured = configureTestIsolation({ registryDir: await tempDir(), helperPath: "/nonexistent/paperclip-scope-exec", slice: "app-agents.slice" });
    const { promise } = run("/bin/sh", ["-c", "sleep 300 & echo $!; wait"], { timeoutSec: 1 });
    const result = await promise;
    expect(result.timedOut).toBe(true);
    expect(await waitFor(() => !isAlive(Number.parseInt(result.stdout.trim(), 10)))).toBe(true);
    expect(await fs.readdir(configured.policy.registryDir)).toEqual([]);
  });

  it("does not count a run id that cannot be a unit name against isolation health", async () => {
    configured = configureTestIsolation({ registryDir: await tempDir(), helperPath: "/nonexistent/paperclip-scope-exec", slice: "app-agents.slice" });
    const { promise, logs } = run(...sh("echo ok"), { runId: "not an opaque id!" });
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.processIsolation).toMatchObject({ state: "degraded", reason: "invalid_owner_id" });
    expect(degradedLines(logs)).toHaveLength(1);
    expect(configured.logger.warnings).toHaveLength(0);
  });
});

describe("runChildProcess wraps the already resolved target", () => {
  it("hands the helper the sandbox command, not the adapter command", async () => {
    const dir = await tempDir();
    const argvLog = path.join(dir, "helper-argv");
    const stubHelper = path.join(dir, "stub-helper");
    await fs.writeFile(
      stubHelper,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    const fakeSandbox = path.join(dir, "fake-bwrap");
    await fs.writeFile(
      fakeSandbox,
      `#!/bin/sh\necho SANDBOX_RAN\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace);
    const configured = configureTestIsolation({ registryDir: path.join(dir, "reg"), helperPath: stubHelper, slice: "app-agents.slice" });

    const { promise } = run(process.execPath, ["-e", "process.stdout.write('target')"], {
      extra: {
        cwd: workspace,
        localProcessSandbox: { workspaceDir: workspace, filesystemScope: "workspace", command: fakeSandbox },
      },
    });
    const result = await promise;
    configured.health.stop();

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("SANDBOX_RAN");
    expect(result.stdout).toContain("target");
    const argv = (await fs.readFile(argvLog, "utf8")).trim().split("\n");
    const rest = argv.slice(argv.indexOf("--") + 1);
    expect(rest[0]).toBe(fakeSandbox);
    expect(rest).toContain(process.execPath);
    expect(argv).toContain("--slice");
    expect(argv[argv.indexOf("--slice") + 1]).toBe("app-agents.slice");
  });
});

describe("runChildProcess under a live user manager", () => {
  let live: LiveIsolation;
  let configured: ConfiguredIsolation | null = null;

  beforeAll(async () => {
    live = await prepareLiveIsolation();
  });
  afterAll(() => live?.cleanup());
  afterEach(() => configured?.health.stop());

  const setup = async (userBus?: string) => {
    configured = configureTestIsolation({
      registryDir: await tempDir(),
      helperPath: live.helper,
      slice: live.slice,
      userBus,
    });
    return configured;
  };
  const live_ = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (live.skip) ctx.skip(`skipped, ${live.skip}`);
      await fn();
    });

  live_("runs the target inside its own scope below the configured slice", async () => {
    const iso = await setup();
    const { promise, logs } = run(...sh("cat /proc/self/cgroup"));
    const result = await promise;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`/${live.slice}/`);
    expect(result.stdout).toContain(`/${scopeUnitNamespace(iso.policy.instanceId)}`);
    expect(result.processIsolation).toMatchObject({ mode: "systemd", state: "enrolled", slice: live.slice, reason: null });
    expect(degradedLines(logs)).toHaveLength(0);
    expect(iso.logger.warnings).toHaveLength(0);
  });

  live_("applies the scope after the sandbox command is resolved", async () => {
    const dir = await tempDir();
    const fakeSandbox = path.join(dir, "fake-bwrap");
    await fs.writeFile(
      fakeSandbox,
      `#!/bin/sh\ncat /proc/self/cgroup\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n`,
      { mode: 0o755 },
    );
    const workspace = path.join(dir, "workspace");
    await fs.mkdir(workspace);
    await setup();
    const { promise } = run(process.execPath, ["-e", "process.stdout.write('target')"], {
      extra: { cwd: workspace, localProcessSandbox: { workspaceDir: workspace, filesystemScope: "workspace", command: fakeSandbox } },
    });
    const result = await promise;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(`/${live.slice}/`);
    expect(result.stdout).toContain("target");
  });

  live_("kills a descendant that left the process group when the run times out", async () => {
    await setup();
    const pidFile = path.join(await tempDir(), "pid");
    const { promise } = run(...sh(`setsid env -i /bin/sh -c 'echo $$ > ${pidFile}; exec sleep 300' & while :; do sleep 0.05; done`), {
      timeoutSec: 1,
    });
    const result = await promise;
    expect(result.timedOut).toBe(true);
    const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    expect(await fs.readdir(configured!.policy.registryDir)).toEqual([]);
  });

  live_("kills a lingering descendant after the terminal result is seen", async () => {
    await setup();
    const pidFile = path.join(await tempDir(), "pid");
    const { promise } = run(
      ...sh(`setsid env -i /bin/sh -c 'echo $$ > ${pidFile}; exec sleep 300' & sleep 0.3; echo TERMINAL_RESULT; while :; do sleep 0.05; done`),
      {
        timeoutSec: 30,
        extra: { terminalResultCleanup: { hasTerminalResult: ({ stdout }) => stdout.includes("TERMINAL_RESULT"), graceMs: 200 } },
      },
    );
    const result = await promise;
    expect(result.stdout).toContain("TERMINAL_RESULT");
    const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
    expect(await fs.readdir(configured!.policy.registryDir)).toEqual([]);
  });

  live_("cancels through the owned scope and reaches the whole tree", async () => {
    await setup();
    const runId = randomUUID();
    const pidFile = path.join(await tempDir(), "pid");
    const { promise } = run(...sh(`setsid env -i /bin/sh -c 'echo $$ > ${pidFile}; exec sleep 300' & while :; do sleep 0.05; done`), { runId });
    expect(await waitFor(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).trim() !== "")).toBe(true);
    const pid = Number.parseInt((await fs.readFile(pidFile, "utf8")).trim(), 10);
    const scope = runningProcesses.get(runId)?.ownedScope;
    expect(scope).toBeTruthy();
    expect(scope!.slice).toBe(live.slice);

    const outcome = await terminateOwnedScope(scope!, { graceMs: 300 });
    expect(scopeTerminationSettled(outcome)).toBe(true);
    const result: RunProcessResult = await promise;
    expect(result.exitCode === 0 && result.signal === null).toBe(false);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });

  live_("keeps two companies' scopes separate", async () => {
    await setup();
    const runA = randomUUID();
    const runB = randomUUID();
    const a = run(...sh("while :; do sleep 0.05; done"), { runId: runA, companyId: randomUUID() });
    const b = run(...sh("sleep 1; echo done-b"), { runId: runB, companyId: randomUUID() });
    expect(await waitFor(() => Boolean(runningProcesses.get(runA)?.ownedScope && runningProcesses.get(runB)?.ownedScope))).toBe(true);
    const scopeA = runningProcesses.get(runA)!.ownedScope!;
    const scopeB = runningProcesses.get(runB)!.ownedScope!;
    expect(scopeA.unit).not.toBe(scopeB.unit);

    expect(scopeTerminationSettled(await terminateOwnedScope(scopeA, { graceMs: 200 }))).toBe(true);
    await a.promise;
    const resultB = await b.promise;
    expect(resultB.exitCode).toBe(0);
    expect(resultB.stdout.trim()).toBe("done-b");
  });

  live_("falls back to the plain command with a marker when enrollment fails", async () => {
    const iso = await setup("unix:path=/nonexistent/paperclip-test-bus");
    const { promise, logs } = run(...sh("echo still-ran"));
    const result = await promise;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("still-ran");
    expect(result.processIsolation?.state).toBe("degraded");
    expect(degradedLines(logs)).toHaveLength(1);
    expect(iso.logger.warnings).toHaveLength(1);

    const again = run(...sh("echo again"));
    await again.promise;
    expect(degradedLines(again.logs)).toHaveLength(1);
    expect(iso.logger.warnings).toHaveLength(1);
  });

  live_("reports a command that cannot be executed like a normal spawn failure", async () => {
    await setup();
    const missing = path.join(await tempDir(), "no-such-command");
    const scoped = await run(missing, []).promise.then(
      () => null,
      (error: Error) => error,
    );
    resetAgentProcessIsolation();
    const plain = await run(missing, []).promise.then(
      () => null,
      (error: Error) => error,
    );
    expect(scoped).toBeInstanceOf(Error);
    expect(plain).toBeInstanceOf(Error);
    expect(scoped!.message).toBe(plain!.message);
  });
});
