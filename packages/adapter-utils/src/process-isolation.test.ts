import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OFF_ISOLATION_POLICY } from "@paperclipai/process-launch";
import {
  configureAgentProcessIsolation,
  formatProcessIsolationDegradedLine,
  getAgentProcessIsolation,
  resetAgentProcessIsolation,
  scopeTerminationSettled,
  spawnRunProcess,
  terminateOwnedScope,
  type OwnedScope,
} from "./process-isolation.js";
import { configureTestIsolation } from "./test-support/isolation-fixture.js";

afterEach(() => resetAgentProcessIsolation());

describe("host isolation policy", () => {
  it("is off until the server configures it", () => {
    expect(getAgentProcessIsolation()).toEqual({ policy: OFF_ISOLATION_POLICY, health: null });
  });

  it("is frozen once configured and replaced as a whole on reconfigure", () => {
    const first = configureTestIsolation({ registryDir: "/tmp/au-policy", helperPath: null, slice: "app-agents.slice" });
    const runtime = getAgentProcessIsolation();
    expect(runtime.policy).toBe(first.policy);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(() => {
      (runtime as { policy: unknown }).policy = OFF_ISOLATION_POLICY;
    }).toThrow();

    configureAgentProcessIsolation({ policy: OFF_ISOLATION_POLICY, health: null });
    expect(getAgentProcessIsolation().policy.mode).toBe("off");
  });

  it("stops the previous health tracker when it is replaced or reset", () => {
    const first = configureTestIsolation({ registryDir: "/tmp/au-policy", helperPath: null, slice: "app-agents.slice" });
    const stop = vi.spyOn(first.health, "stop");
    configureAgentProcessIsolation({ policy: OFF_ISOLATION_POLICY, health: null });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("spawnRunProcess", () => {
  it("spawns exactly the given command when isolation is off", async () => {
    const { child, ownedScope, tracker } = spawnRunProcess({
      runId: "run-1",
      companyId: "company-1",
      command: "/bin/sh",
      args: ["-c", "echo off"],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      onDegraded: () => {
        throw new Error("not degraded");
      },
    });
    expect(ownedScope).toBeNull();
    expect(tracker).toBeNull();
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk));
    await new Promise((resolve) => child.on("close", resolve));
    expect(out.trim()).toBe("off");
  });
});

describe("owned scope termination", () => {
  const inactive: OwnedScope = {
    ref: { registryDir: "/tmp/au-none", unit: "pcagent-aaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc.scope" },
    instanceId: "autest",
    slice: "app-agents.slice",
    unit: "pcagent-aaaaaaaaaaaa-bbbbbbbbbbbbbbbb-cccccccccccccccc.scope",
    isScopeActive: () => false,
  };

  it("does nothing for a launch that never enrolled", async () => {
    const result = await terminateOwnedScope(inactive);
    expect(result).toEqual({ outcome: "not_scoped" });
    expect(scopeTerminationSettled(result)).toBe(false);
  });

  it("settles only on outcomes where nothing owned remains", () => {
    expect(scopeTerminationSettled({ outcome: "terminated" })).toBe(true);
    expect(scopeTerminationSettled({ outcome: "already_empty" })).toBe(true);
    expect(scopeTerminationSettled({ outcome: "missing_record" })).toBe(true);
    expect(scopeTerminationSettled({ outcome: "unconfirmed" })).toBe(false);
    expect(scopeTerminationSettled({ outcome: "not_scoped" })).toBe(false);
  });

  it("reports an unreadable record as unconfirmed instead of throwing", async () => {
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "au-corrupt-"));
    try {
      await fs.writeFile(path.join(registryDir, `${inactive.unit}.json`), "{not json");
      const result = await terminateOwnedScope({ ...inactive, ref: { registryDir, unit: inactive.unit }, isScopeActive: () => true });
      expect(result.outcome).toBe("unconfirmed");
    } finally {
      await fs.rm(registryDir, { recursive: true, force: true });
    }
  });
});

describe("degraded marker", () => {
  it("is one compact line with the reason and slice, and no dashes", () => {
    const line = formatProcessIsolationDegradedLine({
      mode: "systemd",
      state: "degraded",
      slice: "app-agents.slice",
      unit: null,
      reason: "user_bus_unavailable",
    });
    expect(line).toBe("[paperclip] agent process isolation degraded (reason=user_bus_unavailable, slice=app-agents.slice); normal execution used\n");
    expect(line).not.toMatch(/[–—]/);
  });
});
