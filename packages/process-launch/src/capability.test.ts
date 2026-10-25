import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeSystemdCapability, type BusctlRunResult, type CapabilityDeps } from "./capability.js";
import { testPolicy, tempDirs } from "./test-support.js";

const UID = 1000;
const MANAGER = `/user.slice/user-${UID}.slice/user@${UID}.service`;
const dirs = tempDirs();

interface Fixture {
  deps: CapabilityDeps;
  calls: string[][];
  policy: ReturnType<typeof testPolicy>;
  respond: (match: string, result: BusctlRunResult) => void;
}

const servers: net.Server[] = [];

async function fixture(options: { cpu?: boolean; underManager?: boolean; slice?: string } = {}): Promise<Fixture> {
  const root = dirs.make("pcl-cap-");
  const procRoot = path.join(root, "proc");
  const cgroupRoot = path.join(root, "cgroup");
  mkdirSync(path.join(procRoot, "self"), { recursive: true });
  writeFileSync(
    path.join(procRoot, "self", "cgroup"),
    options.underManager === false ? "0::/system.slice/paperclip.service\n" : `0::${MANAGER}/app.slice/server.service\n`,
  );
  mkdirSync(path.join(cgroupRoot, MANAGER), { recursive: true });
  writeFileSync(path.join(cgroupRoot, MANAGER, "cgroup.subtree_control"), options.cpu === false ? "memory pids\n" : "cpu memory pids\n");

  const helper = path.join(root, "helper");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, 0o755);
  const busctl = path.join(root, "busctl");
  writeFileSync(busctl, "#!/bin/sh\n");
  chmodSync(busctl, 0o755);

  const socket = path.join(root, "bus");
  const server = net.createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));

  const calls: string[][] = [];
  const responses = new Map<string, BusctlRunResult>();
  const deps: CapabilityDeps = {
    platform: "linux",
    uid: UID,
    procRoot,
    cgroupRoot,
    runBusctl: async (_path, args) => {
      calls.push(args);
      for (const [match, result] of responses) if (args.includes(match)) return result;
      return { code: 0, stderr: "" };
    },
  };
  const policy = testPolicy({
    registryDir: path.join(root, "registry"),
    helperPath: helper,
    busctlPath: busctl,
    userBusAddress: `unix:path=${socket}`,
  });
  const finalPolicy = options.slice !== undefined ? { ...policy, slice: options.slice } : policy;
  return { deps, calls, policy: finalPolicy, respond: (match, result) => responses.set(match, result) };
}

describe("probeSystemdCapability", () => {
  beforeEach(() => {});
  afterEach(async () => {
    dirs.cleanup();
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  it("passes when the helper, bus, controller and slice are all available", async () => {
    const f = await fixture();
    expect(await probeSystemdCapability(f.policy, f.deps)).toEqual({ ok: true });
  });

  it("is read only: it only reads properties and looks up units", async () => {
    const f = await fixture();
    await probeSystemdCapability(f.policy, f.deps);
    const verbs = f.calls.map((args) => args.find((arg) => !arg.startsWith("--")));
    expect(new Set(verbs)).toEqual(new Set(["get-property", "call"]));
    const methods = f.calls.flat().filter((arg) => /^(StartTransientUnit|StopUnit|KillUnit|StartUnit)$/.test(arg));
    expect(methods).toEqual([]);
  });

  it("accepts a slice that is not active but has a unit file", async () => {
    const f = await fixture();
    f.respond("GetUnit", { code: 1, stderr: "not loaded" });
    expect(await probeSystemdCapability(f.policy, f.deps)).toEqual({ ok: true });
  });

  it("rejects a slice that neither is loaded nor has a unit file", async () => {
    const f = await fixture();
    f.respond("GetUnit", { code: 1, stderr: "not loaded" });
    f.respond("GetUnitFileState", { code: 1, stderr: "no such file" });
    expect(await probeSystemdCapability(f.policy, f.deps)).toMatchObject({ ok: false, reason: "slice_unavailable" });
  });

  it("reports an unsupported platform first", async () => {
    const f = await fixture();
    expect(await probeSystemdCapability(f.policy, { ...f.deps, platform: "darwin" })).toEqual({
      ok: false,
      reason: "unsupported_platform",
    });
  });

  it("reports an invalid slice", async () => {
    const f = await fixture({ slice: "-.slice" });
    expect(await probeSystemdCapability(f.policy, f.deps)).toEqual({ ok: false, reason: "invalid_slice" });
  });

  it("reports a missing helper", async () => {
    const f = await fixture();
    const policy = { ...f.policy, helperPath: "/nonexistent/helper" };
    expect(await probeSystemdCapability(policy, f.deps)).toEqual({ ok: false, reason: "helper_missing" });
  });

  it("reports a missing busctl", async () => {
    const f = await fixture();
    const policy = { ...f.policy, busctlPath: "/nonexistent/busctl" };
    expect(await probeSystemdCapability(policy, f.deps)).toEqual({ ok: false, reason: "busctl_missing" });
  });

  it("reports a server that does not run under its user manager", async () => {
    const f = await fixture({ underManager: false });
    expect(await probeSystemdCapability(f.policy, f.deps)).toEqual({ ok: false, reason: "not_under_user_manager" });
  });

  it("reports a missing CPU controller", async () => {
    const f = await fixture({ cpu: false });
    expect(await probeSystemdCapability(f.policy, f.deps)).toEqual({ ok: false, reason: "cpu_controller_unavailable" });
  });

  it("reports an unconfigured or unsupported user bus", async () => {
    const f = await fixture();
    expect(await probeSystemdCapability({ ...f.policy, userBusAddress: null }, f.deps)).toEqual({
      ok: false,
      reason: "user_bus_unconfigured",
    });
    expect(await probeSystemdCapability({ ...f.policy, userBusAddress: "unix:abstract=x" }, f.deps)).toEqual({
      ok: false,
      reason: "user_bus_unsupported_address",
    });
    expect(await probeSystemdCapability({ ...f.policy, userBusAddress: "unix:path=/nonexistent/bus" }, f.deps)).toEqual({
      ok: false,
      reason: "user_bus_unavailable",
    });
  });

  it("reports an unreachable user manager with the busctl error", async () => {
    const f = await fixture();
    f.respond("get-property", { code: 1, stderr: "Failed to connect" });
    expect(await probeSystemdCapability(f.policy, f.deps)).toEqual({
      ok: false,
      reason: "user_manager_unreachable",
      detail: "Failed to connect",
    });
  });
});
