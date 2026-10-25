import { describe, expect, it } from "vitest";
import {
  agentScopeRegistryDir,
  createSystemdIsolationPolicy,
  DEFAULT_ENROLLMENT_DEADLINE_MS,
  resolveUserBusAddress,
} from "./policy.js";

describe("systemd isolation policy", () => {
  const input = { slice: "app-agents.slice", instanceId: "default", registryDir: "/tmp/r", userBusAddress: null };

  it("is frozen and uses the plan defaults", () => {
    const policy = createSystemdIsolationPolicy(input);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(policy.enrollmentDeadlineMs).toBe(DEFAULT_ENROLLMENT_DEADLINE_MS);
    expect(DEFAULT_ENROLLMENT_DEADLINE_MS).toBe(2_000);
    expect(policy.busctlPath).toBe("/usr/bin/busctl");
    expect(policy.helperPath).toBeNull();
  });

  it("rejects untrusted shapes", () => {
    expect(() => createSystemdIsolationPolicy({ ...input, instanceId: "my instance" })).toThrow();
    expect(() => createSystemdIsolationPolicy({ ...input, registryDir: "relative" })).toThrow();
    expect(() => createSystemdIsolationPolicy({ ...input, helperPath: "bin/helper" })).toThrow();
    expect(() => createSystemdIsolationPolicy({ ...input, busctlPath: "busctl" })).toThrow();
    expect(() => createSystemdIsolationPolicy({ ...input, enrollmentDeadlineMs: 0 })).toThrow();
    expect(() => createSystemdIsolationPolicy({ ...input, enrollmentDeadlineMs: 30_001 })).toThrow();
  });

  it("places the registry under the instance runtime directory", () => {
    expect(agentScopeRegistryDir("/home/u/.paperclip/instances/default")).toBe(
      "/home/u/.paperclip/instances/default/runtime/agent-scopes",
    );
  });
});

describe("user bus address", () => {
  it("prefers the server's configured session bus address", () => {
    expect(resolveUserBusAddress({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/7/bus" }, 7)).toBe(
      "unix:path=/run/user/7/bus",
    );
  });

  it("refuses addresses it cannot verify as a plain socket", () => {
    expect(resolveUserBusAddress({ DBUS_SESSION_BUS_ADDRESS: "tcp:host=evil,port=1" }, 7)).toBeNull();
    expect(resolveUserBusAddress({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/a,guid=b" }, 7)).toBeNull();
  });

  it("falls back to XDG_RUNTIME_DIR, then the same-UID default", () => {
    expect(resolveUserBusAddress({ XDG_RUNTIME_DIR: "/run/user/9" }, 9)).toBe("unix:path=/run/user/9/bus");
    expect(resolveUserBusAddress({}, 9)).toBe("unix:path=/run/user/9/bus");
    expect(resolveUserBusAddress({}, null)).toBeNull();
  });
});
