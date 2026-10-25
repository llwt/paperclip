import { spawn } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareIsolatedLaunch, recordSpawnedProcess, spawnIsolated } from "./launch.js";
import { OFF_ISOLATION_POLICY } from "./policy.js";
import { readScopeRecord } from "./registry.js";
import { collect, tempDirs, testPolicy } from "./test-support.js";

const temp = tempDirs();
afterEach(() => temp.cleanup());
const owner = { kind: "run", id: "run-1", companyId: "company-a" } as const;

describe("off mode", () => {
  it("is exactly the existing spawn call, with no probing", () => {
    const fakeSpawn = vi.fn((..._args: unknown[]) => ({ pid: 1 }) as never);
    const options = { cwd: "/tmp", env: { A: "1" }, detached: true, stdio: "pipe" as const };
    const { child, launch } = spawnIsolated(
      { command: "provider", args: ["--flag", "$X y"], options },
      { policy: OFF_ISOLATION_POLICY, owner },
      { spawn: fakeSpawn as never },
    );
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    expect(fakeSpawn).toHaveBeenCalledWith("provider", ["--flag", "$X y"], options);
    expect(fakeSpawn.mock.calls[0]![2]).toBe(options);
    expect(child).toEqual({ pid: 1 });
    expect(launch.isolation).toEqual({ state: "off" });
    expect(launch.record).toBeNull();
    expect(launch.classifyExit(3, null)).toEqual({ kind: "target", code: 3, signal: null });
  });

  it("prepares the target unchanged and does not validate the owner", () => {
    const prepared = prepareIsolatedLaunch(
      { command: "a", args: ["b"], options: { shell: true } },
      { policy: OFF_ISOLATION_POLICY, owner: { kind: "run", id: "not opaque at all" } },
    );
    expect(prepared).toEqual({ command: "a", args: ["b"], options: { shell: true }, isolation: { state: "off" } });
  });
});

describe("systemd mode fallbacks before any workload starts", () => {
  it("degrades on an unsupported platform without touching the registry", () => {
    const registryDir = path.join(temp.make(), "agent-scopes");
    const prepared = prepareIsolatedLaunch(
      { command: "a" },
      { policy: testPolicy({ registryDir }), owner },
      { platform: "darwin" },
    );
    expect(prepared.isolation).toEqual({ state: "degraded", reason: "unsupported_platform", unit: null, record: null });
    expect(prepared.command).toBe("a");
    expect(existsSync(registryDir)).toBe(false);
  });

  it("degrades when the registry cannot be written", () => {
    const blocker = path.join(temp.make(), "file");
    writeFileSync(blocker, "");
    const prepared = prepareIsolatedLaunch(
      { command: "a", args: ["b"] },
      { policy: testPolicy({ registryDir: path.join(blocker, "agent-scopes") }), owner },
    );
    expect(prepared).toMatchObject({ command: "a", args: ["b"], isolation: { reason: "registry_unavailable" } });
  });

  it.each([
    ["invalid_slice", { slice: "app.slice" }],
    ["helper_missing", { helperPath: "/nonexistent/paperclip-scope-exec" }],
    ["user_bus_unconfigured", { userBusAddress: null, helperPath: process.execPath }],
  ] as const)("records %s and spawns the target directly", async (reason, overrides) => {
    const registryDir = temp.make();
    const { child, launch } = spawnIsolated(
      { command: "sh", args: ["-c", 'printf "%s|" "$@"', "sh", "a b", "$HOME"] },
      { policy: testPolicy({ registryDir, ...overrides }), owner },
    );
    const result = await collect(child);
    expect(result.stdout.toString()).toBe("a b|$HOME|");
    expect(launch.isolation).toMatchObject({ state: "degraded", reason });
    const record = readScopeRecord(launch.record!)!;
    expect(record.manifest).toMatchObject({ state: "spawned", pid: child.pid, preflight: { reason } });
    expect(record.status).toBeNull();
  });

  it("falls back to a direct spawn when the helper cannot start", async () => {
    const registryDir = temp.make();
    // The helper exists, but its start fails the way a vanished file would.
    const broken = path.join(temp.make(), "broken-helper");
    writeFileSync(broken, "");
    chmodSync(broken, 0o755);
    const fakeSpawn = vi.fn((command: string, args: string[], options: object) =>
      spawn(command === broken ? "/nonexistent/helper" : command, args, options),
    );
    const { child, launch } = spawnIsolated(
      { command: "echo", args: ["ran once"] },
      { policy: testPolicy({ registryDir, helperPath: broken, userBusAddress: "unix:path=/x" }), owner },
      { spawn: fakeSpawn as never },
    );
    const result = await collect(child);
    expect(fakeSpawn).toHaveBeenCalledTimes(2);
    expect(result.stdout.toString()).toBe("ran once\n");
    expect(launch.isolation).toMatchObject({ state: "degraded", reason: "helper_spawn_failed" });
  });

  it("lets a caller that spawns a prepared launch record its PID", async () => {
    const registryDir = temp.make();
    const prepared = prepareIsolatedLaunch(
      { command: "true" },
      { policy: testPolicy({ registryDir, helperPath: "/nonexistent/helper" }), owner },
    );
    const record = prepared.isolation.state === "degraded" ? prepared.isolation.record! : null;
    expect(readScopeRecord(record!)?.manifest).toMatchObject({ state: "intent", pid: null });
    const child = spawn(prepared.command, prepared.args, prepared.options);
    recordSpawnedProcess(record!, child.pid!);
    expect(readScopeRecord(record!)?.manifest).toMatchObject({ state: "spawned", pid: child.pid });
    await collect(child);
  });

  it("never writes arguments, environment or titles into the registry", async () => {
    const registryDir = temp.make();
    const { child } = spawnIsolated(
      {
        command: "sh",
        args: ["-c", "true", "SECRET-ARG-123"],
        options: { env: { ...process.env, PROVIDER_TOKEN: "SECRET-ENV-456" } },
      },
      { policy: testPolicy({ registryDir, helperPath: "/nonexistent/helper" }), owner },
    );
    await collect(child);
    for (const name of readdirSync(registryDir)) {
      const body = readFileSync(path.join(registryDir, name), "utf8");
      expect(body).not.toContain("SECRET-ARG-123");
      expect(body).not.toContain("SECRET-ENV-456");
      expect(body).not.toContain('"sh"');
    }
  });
});
