import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnRunner } from "./control-plane/durable-prp-control-plane.js";
import { ProcessCodexAppServerTransport } from "./drivers/codex/app-server-transport.js";
import {
  confirmLaunchRootStopped,
  LaunchRootCleanupUnconfirmedError,
  spawnLaunchRoot,
  type LaunchRootCleanup,
  type ProcessIsolationRequest,
} from "./process-isolation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exited = (child: { once(event: "exit", listener: () => void): unknown }) =>
  new Promise<void>((resolve) => { child.once("exit", resolve); });

describe("spawnLaunchRoot", () => {
  it("is the plain spawn call without a request", async () => {
    const calls: unknown[][] = [];
    const fake = (command: string, args: readonly string[], options: SpawnOptions) => {
      calls.push([command, args, options]);
      return spawn(process.execPath, ["-e", ""]);
    };
    const options = { cwd: tmpdir(), stdio: "ignore" as const };
    await exited(spawnLaunchRoot("node-cmd", ["a"], options, undefined, fake));
    expect(calls).toEqual([["node-cmd", ["a"], options]]);
  });

  it("hands the unchanged launch to the request when one is given", async () => {
    const seen: unknown[][] = [];
    const request: ProcessIsolationRequest = {
      spawn: (command, args, options) => {
        seen.push([command, args, options]);
        return spawn(process.execPath, ["-e", ""]);
      },
    };
    const options: SpawnOptions = { detached: true, stdio: ["pipe", "pipe", "pipe", 7] };
    await exited(spawnLaunchRoot("guardian", ["--eval", "x"], options, request, () => {
      throw new Error("plain spawn must not run");
    }));
    expect(seen).toEqual([["guardian", ["--eval", "x"], options]]);
  });
});

describe("spawnRunner with a process isolation request", () => {
  it("launches the runner and its restart through the request, with the same launch", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "paperclip-runner-scope-"));
    roots.push(stateDirectory);
    const seen: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = [];
    const request: ProcessIsolationRequest = {
      spawn: (command, args, options) => {
        seen.push({ command, args, options });
        return spawn(process.execPath, ["-e", ""], { stdio: "pipe" });
      },
    };
    const options = {
      connectUrl: "ws://127.0.0.1:9/prp",
      stateDirectory,
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      ticket: "ticket-1",
      maxOutboxBytes: 1_024,
      p0ReserveBytes: 128,
      runnerBinaryPath: "/nonexistent/paperclip-runnerd",
      runnerVersion: "0.0.0",
      runnerDigest: "sha256:test",
      environment: { PATH: "/usr/bin" },
      processIsolation: request,
    };
    const handle = spawnRunner(options);
    await handle.completion;
    await handle.restart!("ticket-2").completion;

    expect(seen.map((launch) => launch.command)).toEqual([
      "/nonexistent/paperclip-runnerd",
      "/nonexistent/paperclip-runnerd",
    ]);
    expect(seen[0]!.args).toContain("--run-id");
    expect(seen[0]!.options.detached).toBe(process.platform !== "win32");
    // Exactly the runner's own allowlisted environment, as the launcher seam
    // without a request sees it: the request adds nothing to it.
    let plainEnvironment: NodeJS.ProcessEnv | undefined;
    spawnRunner({
      ...options,
      processIsolation: undefined,
      processLauncher: (spec) => {
        plainEnvironment = spec.environment;
        return { child: { exitCode: 0, kill: () => true }, completion: Promise.resolve({ code: 0, signal: null, stdout: "", stderr: "" }) };
      },
    });
    expect(seen[0]!.options.env).toEqual(plainEnvironment);
    expect(seen[0]!.options.env?.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("ticket-1");
    expect(seen[1]!.options.env?.PAPERCLIP_RUNNER_BOOTSTRAP_TICKET).toBe("ticket-2");
  });
});

describe("spawnRunner completion in a scope", () => {
  it("reports the runner's end only after the request reaped its scope", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "paperclip-runner-reap-"));
    roots.push(stateDirectory);
    let finishCleanup!: (cleanup: LaunchRootCleanup) => void;
    const cleanup = new Promise<LaunchRootCleanup>((resolve) => { finishCleanup = resolve; });
    let rootExited = false;
    const request: ProcessIsolationRequest = {
      spawn: () => {
        const child = spawn(process.execPath, ["-e", ""], { stdio: "pipe" });
        child.once("exit", () => { rootExited = true; });
        return child;
      },
      reaped: () => cleanup,
    };
    const handle = spawnRunner({
      connectUrl: "ws://127.0.0.1:9/prp",
      stateDirectory,
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      ticket: "ticket-1",
      maxOutboxBytes: 1_024,
      p0ReserveBytes: 128,
      runnerBinaryPath: "/nonexistent/paperclip-runnerd",
      runnerVersion: "0.0.0",
      runnerDigest: "sha256:test",
      environment: { PATH: "/usr/bin" },
      processIsolation: request,
    });
    let completed = false;
    void handle.completion.then(() => { completed = true; });
    while (!rootExited) await new Promise((resolve) => setTimeout(resolve, 10));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);
    finishCleanup({ confirmed: true });
    const result = await handle.completion;
    expect(result).toMatchObject({ code: 0 });
    expect(result.scopeCleanupUnconfirmed).toBeUndefined();
  });

  it("carries an unconfirmed scope cleanup in the runner's completion", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "paperclip-runner-unconfirmed-"));
    roots.push(stateDirectory);
    const handle = spawnRunner({
      connectUrl: "ws://127.0.0.1:9/prp",
      stateDirectory,
      identity: {
        runnerInstanceId: "runner-1",
        environmentLeaseId: "lease-1",
        runId: "run-1",
        normalizedSessionId: "session-1",
        turnId: "turn-1",
        itemId: "item-1",
      },
      ticket: "ticket-1",
      maxOutboxBytes: 1_024,
      p0ReserveBytes: 128,
      runnerBinaryPath: "/nonexistent/paperclip-runnerd",
      runnerVersion: "0.0.0",
      runnerDigest: "sha256:test",
      environment: { PATH: "/usr/bin" },
      processIsolation: {
        spawn: () => spawn(process.execPath, ["-e", ""], { stdio: "pipe" }),
        reaped: async () => ({ confirmed: false, reason: "scope_still_populated" }),
      },
    });
    await expect(handle.completion).resolves.toMatchObject({ code: 0, scopeCleanupUnconfirmed: "scope_still_populated" });
  });
});

describe("confirmLaunchRootStopped", () => {
  it("does nothing without a request", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await expect(confirmLaunchRootStopped(undefined, child)).resolves.toBeUndefined();
    } finally {
      child.kill("SIGKILL");
      await exited(child);
    }
  });

  it("refuses a root that still runs, and an unconfirmed cleanup", async () => {
    const running = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const reaped = vi.fn(async (): Promise<LaunchRootCleanup> => ({ confirmed: false, reason: "terminate_failed" }));
    try {
      await expect(confirmLaunchRootStopped({ spawn, reaped }, running)).rejects.toMatchObject({ reason: "root_still_running" });
      expect(reaped).not.toHaveBeenCalled();
    } finally {
      running.kill("SIGKILL");
      await exited(running);
    }
    const error = await confirmLaunchRootStopped({ spawn, reaped }, running).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LaunchRootCleanupUnconfirmedError);
    expect(error).toMatchObject({ reason: "terminate_failed" });
    await expect(confirmLaunchRootStopped({ spawn, reaped: async () => ({ confirmed: true }) }, running)).resolves.toBeUndefined();
  });
});

describe("Codex app-server transport close in a scope", () => {
  const appServer = (request: ProcessIsolationRequest | undefined) => new ProcessCodexAppServerTransport({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    environment: { PATH: process.env.PATH },
    closeGraceMs: 2_000,
    ...(request ? { processIsolation: request } : {}),
  });

  it("reports the app-server stopped only after its scope cleanup was confirmed", async () => {
    let finishCleanup!: (cleanup: LaunchRootCleanup) => void;
    const request: ProcessIsolationRequest = {
      spawn: (command, args, options) => spawn(command, args, options),
      reaped: () => new Promise((resolve) => { finishCleanup = resolve; }),
    };
    const transport = appServer(request);
    let closed = false;
    const closing = transport.close().then(() => { closed = true; });
    await vi.waitFor(() => expect(transport.processInfo().exited).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);
    finishCleanup({ confirmed: true });
    await closing;
    expect(closed).toBe(true);
  });

  it("fails the close, also when repeated, when the scope cleanup was not confirmed", async () => {
    const transport = appServer({
      spawn: (command, args, options) => spawn(command, args, options),
      reaped: async () => ({ confirmed: false, reason: "scope_still_populated" }),
    });
    await expect(transport.close()).rejects.toBeInstanceOf(LaunchRootCleanupUnconfirmedError);
    await expect(transport.close()).rejects.toMatchObject({ reason: "scope_still_populated" });
  });

  it("shares one close between concurrent and repeated callers", async () => {
    let finishCleanup!: (cleanup: LaunchRootCleanup) => void;
    const cleanup = new Promise<LaunchRootCleanup>((resolve) => { finishCleanup = resolve; });
    const transport = appServer({
      spawn: (command, args, options) => spawn(command, args, options),
      reaped: () => cleanup,
    });
    const results: string[] = [];
    const record = (name: string) => transport.close().then(
      () => results.push(`${name}:resolved`),
      (error: unknown) => results.push(`${name}:${(error as LaunchRootCleanupUnconfirmedError).reason}`),
    );
    const closes = [record("first"), record("second")];
    await vi.waitFor(() => expect(transport.processInfo().exited).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(results).toEqual([]);
    finishCleanup({ confirmed: false, reason: "record_unreadable" });
    await Promise.all(closes);
    expect(results.sort()).toEqual(["first:record_unreadable", "second:record_unreadable"]);
    await expect(transport.close()).rejects.toMatchObject({ reason: "record_unreadable" });
  });

  it("closes as before without a request", async () => {
    const transport = appServer(undefined);
    await expect(transport.close()).resolves.toBeUndefined();
    expect(transport.processInfo().exited).toBe(true);
  });
});
