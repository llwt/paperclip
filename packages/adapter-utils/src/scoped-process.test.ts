import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentProcessIsolation } from "./process-isolation.js";
import {
  execFileAuxiliary,
  execFileCallbackScoped,
  execFileScoped,
  execFileSyncAuxiliary,
  spawnAuxiliary,
  spawnScoped,
  spawnSyncScoped,
} from "./scoped-process.js";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "./test-support/isolation-fixture.js";

const temp: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-"));
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

function collect(child: import("node:child_process").ChildProcess): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    let stdout = "";
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.once("close", (code) => resolve({ stdout, code }));
  });
}

afterEach(async () => {
  resetAgentProcessIsolation();
  await Promise.all(temp.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("scoped helpers with isolation off", () => {
  it("spawnScoped is a plain spawn that is not in a scope", async () => {
    const scoped = spawnScoped({
      command: "/bin/sh",
      args: ["-c", "echo plain"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      owner: { kind: "auxiliary" },
    });
    expect(scoped.scope).toBeNull();
    const result = await collect(scoped.child);
    await scoped.settled;
    expect(result).toEqual({ stdout: "plain\n", code: 0 });
    expect(await scoped.terminateScope()).toEqual({ outcome: "not_scoped" });
  });

  it("spawnScoped reports a missing command as an error event", async () => {
    const scoped = spawnScoped({ command: "/nonexistent/program", owner: { kind: "auxiliary" } });
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => scoped.child.once("error", resolve));
    expect(error.code).toBe("ENOENT");
    await scoped.settled;
  });

  it("execFileScoped, execFileAuxiliary and execFileSyncAuxiliary return what execFile returns", async () => {
    expect(await execFileScoped("/bin/sh", ["-c", "echo hi"], {}, { kind: "auxiliary" })).toEqual({ stdout: "hi\n", stderr: "" });
    expect(await execFileAuxiliary("/bin/sh", ["-c", "echo err >&2"])).toEqual({ stdout: "", stderr: "err\n" });
    expect(execFileSyncAuxiliary("/bin/sh", ["-c", "echo sync"], { encoding: "utf8" })).toBe("sync\n");
  });

  it("execFileCallbackScoped hands the callback the same output and exposes stdin", async () => {
    const result = await new Promise<{ error: unknown; stdout: string }>((resolve) => {
      const child = execFileCallbackScoped("/bin/cat", [], {}, { kind: "auxiliary" }, (error, stdout) =>
        resolve({ error, stdout }),
      );
      child.stdin!.end("through stdin");
    });
    expect(result).toEqual({ error: null, stdout: "through stdin" });
  });

  it("spawnSyncScoped and spawnAuxiliary behave like Node", async () => {
    const sync = spawnSyncScoped("/bin/sh", ["-c", "echo sync"], { encoding: "utf8" }, { kind: "auxiliary" });
    expect(sync.status).toBe(0);
    expect(sync.stdout).toBe("sync\n");
    const child = spawnAuxiliary("/bin/sh", ["-c", "echo aux"], { stdio: ["ignore", "pipe", "pipe"] });
    expect(await collect(child)).toEqual({ stdout: "aux\n", code: 0 });
  });
});

describe("scoped helpers when isolation cannot be used", () => {
  let configured: ConfiguredIsolation;
  afterEach(() => configured?.health.stop());

  it("falls back to a plain launch and still runs the target", async () => {
    configured = configureTestIsolation({
      registryDir: await tempDir(),
      helperPath: "/nonexistent/paperclip-scope-exec",
      slice: "app-agents.slice",
    });
    expect(await execFileAuxiliary("/bin/sh", ["-c", "echo fallback"])).toEqual({ stdout: "fallback\n", stderr: "" });
    const sync = spawnSyncScoped("/bin/sh", ["-c", "echo fallback"], { encoding: "utf8" }, { kind: "auxiliary" });
    expect(sync.stdout).toBe("fallback\n");
  });
});

describe("scoped helpers under a live user manager", () => {
  let live: LiveIsolation;
  let configured: ConfiguredIsolation | null = null;

  beforeAll(async () => {
    live = await prepareLiveIsolation();
  });
  afterAll(() => live?.cleanup());
  afterEach(() => configured?.health.stop());

  const setup = async () => {
    configured = configureTestIsolation({ registryDir: await tempDir(), helperPath: live.helper, slice: live.slice });
    return configured;
  };
  const liveIt = (name: string, fn: () => Promise<void>) =>
    it(name, async (ctx) => {
      if (live.skip) ctx.skip(`skipped, ${live.skip}`);
      await fn();
    });

  liveIt("starts the root in its own scope below the slice, with the owner kind", async () => {
    const iso = await setup();
    const scoped = spawnScoped({
      command: "/bin/sh",
      args: ["-c", "cat /proc/self/cgroup; sleep 1"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      owner: { kind: "managed_service", id: randomUUID() },
    });
    expect(await waitFor(async () => (await fs.readdir(iso.policy.registryDir)).length > 0)).toBe(true);
    const files = await fs.readdir(iso.policy.registryDir);
    const record = JSON.parse(await fs.readFile(path.join(iso.policy.registryDir, files[0]!), "utf8"));
    expect(record.owner.kind).toBe("managed_service");
    const result = await collect(scoped.child);
    await scoped.settled;
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`/${live.slice}/`);
  });

  liveIt("kill leaves no descendant alive", async () => {
    await setup();
    const scoped = spawnScoped({
      command: "/bin/sh",
      args: ["-c", "sleep 300 & echo $!; wait"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      owner: { kind: "auxiliary" },
    });
    const pidLine = await new Promise<string>((resolve) => scoped.child.stdout!.once("data", (chunk) => resolve(String(chunk))));
    const descendant = Number.parseInt(pidLine.trim(), 10);
    expect(isAlive(descendant)).toBe(true);
    scoped.kill("SIGTERM", 500);
    await scoped.settled;
    expect(await waitFor(() => !isAlive(descendant))).toBe(true);
  });

  liveIt("a managed service keeps its descendants when the root exits, until its scope is terminated", async () => {
    await setup();
    const scoped = spawnScoped({
      command: "/bin/sh",
      args: ["-c", "sleep 300 </dev/null >/dev/null 2>&1 & echo $!"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      owner: { kind: "managed_service", id: randomUUID() },
      reapOnExit: false,
    });
    const result = await collect(scoped.child);
    await scoped.settled;
    const descendant = Number.parseInt(result.stdout.trim(), 10);
    expect(isAlive(descendant)).toBe(true);
    await scoped.terminateScope({ graceMs: 200 });
    expect(await waitFor(() => !isAlive(descendant))).toBe(true);
  });

  liveIt("reaps what a short-lived root leaves behind by default", async () => {
    await setup();
    const scoped = spawnScoped({
      command: "/bin/sh",
      args: ["-c", "sleep 300 </dev/null >/dev/null 2>&1 & echo $!"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      owner: { kind: "auxiliary" },
    });
    const result = await collect(scoped.child);
    await scoped.settled;
    expect(await waitFor(() => !isAlive(Number.parseInt(result.stdout.trim(), 10)))).toBe(true);
  });

  liveIt("reports a target that cannot be executed as an error event, like an unwrapped spawn", async () => {
    await setup();
    const scoped = spawnScoped({ command: "/nonexistent/program", owner: { kind: "auxiliary" } });
    const error = await new Promise<NodeJS.ErrnoException>((resolve) => scoped.child.once("error", resolve));
    expect(error.code).toBe("ENOENT");
  });

  liveIt("execFileScoped keeps Node's result, error and timeout shapes", async () => {
    await setup();
    expect(await execFileAuxiliary("/bin/sh", ["-c", "echo out; echo err >&2"])).toEqual({ stdout: "out\n", stderr: "err\n" });
    await expect(execFileAuxiliary("/bin/sh", ["-c", "echo bad >&2; exit 3"])).rejects.toMatchObject({
      code: 3,
      stderr: "bad\n",
    });
    await expect(execFileAuxiliary("/bin/sh", ["-c", "sleep 30"], { timeout: 200 })).rejects.toMatchObject({ killed: true });
    await expect(execFileAuxiliary("/nonexistent/program", [])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(execFileAuxiliary("/bin/sh", ["-c", "head -c 4096 /dev/zero"], { maxBuffer: 64 })).rejects.toMatchObject({
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    });
  });

  liveIt("spawnSyncScoped and execFileSyncAuxiliary run in a scope and keep Node's results", async () => {
    await setup();
    const sync = spawnSyncScoped("/bin/sh", ["-c", "cat /proc/self/cgroup"], { encoding: "utf8" }, { kind: "auxiliary" });
    expect(sync.status).toBe(0);
    expect(String(sync.stdout)).toContain(`/${live.slice}/`);
    expect(spawnSyncScoped("/nonexistent/program", [], { encoding: "utf8" }, { kind: "auxiliary" }).error).toMatchObject({
      code: "ENOENT",
    });
    expect(() => execFileSyncAuxiliary("/bin/sh", ["-c", "exit 4"], { encoding: "utf8" })).toThrowError(/Command failed/);
    expect(execFileSyncAuxiliary("/bin/sh", ["-c", "printf ok"], { encoding: "utf8" })).toBe("ok");
  });

  liveIt("keeps an IPC channel and extra descriptors across the scope helper", async () => {
    await setup();
    const dir = await tempDir();
    const script = path.join(dir, "worker.mjs");
    await fs.writeFile(
      script,
      'process.on("message", (m) => { process.send({ echo: m, scope: process.getBuiltinModule("node:fs").readFileSync("/proc/self/cgroup", "utf8") }); process.exit(0); });\n',
    );
    const scoped = spawnScoped({
      command: process.execPath,
      args: [script],
      options: { stdio: ["pipe", "pipe", "pipe", "ipc"] },
      owner: { kind: "auxiliary" },
    });
    const reply = await new Promise<{ echo: unknown; scope: string }>((resolve, reject) => {
      scoped.child.once("message", (m) => resolve(m as { echo: unknown; scope: string }));
      scoped.child.once("error", reject);
      scoped.child.send({ hello: "worker" });
    });
    expect(reply.echo).toEqual({ hello: "worker" });
    expect(reply.scope).toContain(`/${live.slice}/`);
    await scoped.settled;
  });
});
