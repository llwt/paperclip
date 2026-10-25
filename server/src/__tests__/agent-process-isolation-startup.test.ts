import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAgentProcessIsolation,
  resetAgentProcessIsolation,
  type OwnedScope,
} from "@paperclipai/adapter-utils/server-utils";
import { startAgentProcessIsolation } from "../agent-process-isolation.js";
import { terminateHeartbeatRunProcess } from "../services/heartbeat/run-control.js";

function recordedLogger() {
  return { warn: vi.fn(), info: vi.fn() };
}

describe("startAgentProcessIsolation", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-isolation-startup-"));
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID"]) saved[key] = process.env[key];
    process.env.PAPERCLIP_HOME = root;
    process.env.PAPERCLIP_INSTANCE_ID = "startuptest";
  });

  afterEach(async () => {
    resetAgentProcessIsolation();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  it("leaves isolation off, without touching the host, by default", async () => {
    const logger = recordedLogger();
    const health = await startAgentProcessIsolation({ agentProcessIsolation: { mode: "off", slice: "app-agents.slice" } }, logger);
    expect(health).toBeNull();
    expect(getAgentProcessIsolation().policy.mode).toBe("off");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("publishes the configured slice and this instance's registry once the check passes", async () => {
    const logger = recordedLogger();
    const probe = vi.fn(async () => ({ ok: true }) as const);
    const health = await startAgentProcessIsolation(
      { agentProcessIsolation: { mode: "systemd", slice: "app-custom.slice" } },
      logger,
      { probe },
    );
    health?.stop();
    const { policy } = getAgentProcessIsolation();
    expect(policy).toMatchObject({ mode: "systemd", slice: "app-custom.slice", instanceId: "startuptest" });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    if (policy.mode === "systemd") expect(policy.registryDir.startsWith(root)).toBe(true);
  });

  it("does not block startup when the check fails: one warning, normal execution", async () => {
    const logger = recordedLogger();
    const health = await startAgentProcessIsolation(
      { agentProcessIsolation: { mode: "systemd", slice: "app-agents.slice" } },
      logger,
      { probe: async () => ({ ok: false, reason: "user_bus_unavailable" }) },
    );
    health?.stop();
    expect(health?.shouldAttempt()).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, message] = logger.warn.mock.calls[0]!;
    expect(fields).toEqual({ reason: "user_bus_unavailable", slice: "app-agents.slice" });
    expect(message).toContain("normal execution used");
  });
});

describe("terminateHeartbeatRunProcess with an owned scope", () => {
  const sleepers: number[] = [];
  const scope = (active: boolean, registryDir: string): OwnedScope => ({
    ref: { registryDir, unit: "pcagent-aaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc.scope" },
    instanceId: "startuptest",
    slice: "app-agents.slice",
    unit: "pcagent-aaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc.scope",
    isScopeActive: () => active,
  });

  function sleeper() {
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    child.unref();
    sleepers.push(child.pid!);
    return child;
  }
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  afterEach(() => {
    for (const pid of sleepers.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });

  it("keeps the process-group kill for a launch that never enrolled", async () => {
    const child = sleeper();
    await terminateHeartbeatRunProcess({
      pid: child.pid,
      processGroupId: child.pid,
      ownedScope: scope(false, os.tmpdir()),
      graceMs: 200,
    });
    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 5_000 });
  });

  it("leaves the group alone once the scope confirms nothing owned remains", async () => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-isolation-registry-"));
    try {
      const child = sleeper();
      await terminateHeartbeatRunProcess({
        pid: child.pid,
        processGroupId: child.pid,
        ownedScope: scope(true, registryDir),
        graceMs: 200,
      });
      expect(alive(child.pid!)).toBe(true);
    } finally {
      await fs.rm(registryDir, { recursive: true, force: true });
    }
  });
});
