import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { spawnIsolated } from "./launch.js";
import { readProcCgroup } from "./proc.js";
import { listScopeRecordRefs, readScopeStatus } from "./registry.js";
import { terminateOwnedProcessTree } from "./terminate.js";
import { collect, isAlive, preflightSkipReason, tempDirs, testPolicy, waitUntil } from "./test-support.js";
import { scopeUnitNamespace } from "./unit-names.js";

// Injected enrollment failures. The helper's local pre-checks must pass to
// reach busctl, so these run only below this user's systemd manager. Tests
// that pass a call through to the real busctl also need a working manager.

const helper = inject("scopeHelper");
const helperSkip = inject("scopeHelperSkipReason");
const systemdSkip = inject("systemdSkipReason");
const testSlice = inject("testSlice");
const fakeSkip = helperSkip ?? preflightSkipReason();
const realSkip = fakeSkip ?? systemdSkip;
const owner = { kind: "run", id: "run-enrollment-test" } as const;
const instanceId = `pcltest-${randomBytes(4).toString("hex")}`;
const realBus = `unix:path=/run/user/${process.getuid?.()}/bus`;
const temp = tempDirs();
const registries: string[] = [];

afterEach(async () => {
  for (const registryDir of registries.splice(0)) {
    for (const ref of listScopeRecordRefs(registryDir, scopeUnitNamespace(instanceId))) {
      await terminateOwnedProcessTree(ref, { instanceId, graceMs: 200, killWaitMs: 2_000 });
    }
  }
  temp.cleanup();
});

function fakeBusctl(body: string): string {
  const file = path.join(temp.make(), "busctl");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** Runs a target that appends one line per execution, so a replay would show. */
async function launchCounted(policyOverrides: Parameters<typeof testPolicy>[0]) {
  const counter = path.join(temp.make(), "counter");
  registries.push(policyOverrides.registryDir);
  const started = Date.now();
  const { child, launch } = spawnIsolated(
    { command: "sh", args: ["-c", 'echo ran >> "$1"; cat /proc/self/cgroup', "sh", counter] },
    { policy: testPolicy({ instanceId, helperPath: helper, ...policyOverrides }), owner },
  );
  const result = await collect(child);
  return {
    result,
    elapsedMs: Date.now() - started,
    runs: readFileSync(counter, "utf8").split("\n").filter(Boolean).length,
    enrollment: launch.readEnrollment()!,
    cgroup: result.stdout.toString().trim().replace(/^0::/, ""),
  };
}

describe.skipIf(fakeSkip !== null)(`injected bus failures before job creation${fakeSkip ? `: skipped, ${fakeSkip}` : ""}`, () => {
  const fakeSocket = () => {
    const socket = path.join(temp.make(), "bus");
    writeFileSync(socket, "");
    return `unix:path=${socket}`;
  };

  it("runs the target once in its original cgroup when busctl is missing", async () => {
    const run = await launchCounted({
      registryDir: temp.make(),
      userBusAddress: fakeSocket(),
      busctlPath: "/nonexistent/busctl",
    });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "degraded", reason: "busctl_missing", unitMayExist: false });
    expect(run.cgroup).toBe(readProcCgroup("self"));
  });

  it("runs the target once when the bus refuses the connection, with no busctl output leaking", async () => {
    const busctl = fakeBusctl('echo LEAK-STDOUT; echo "Failed to connect to bus: No such file or directory" >&2; exit 1');
    const run = await launchCounted({ registryDir: temp.make(), userBusAddress: fakeSocket(), busctlPath: busctl });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "degraded", reason: "user_bus_unavailable" });
    expect(run.enrollment.detail).toContain("Failed to connect to bus");
    expect(run.result.stdout.toString()).not.toContain("LEAK");
    expect(run.result.stderr.length).toBe(0);
  });

  it("runs the target once when the user bus socket is absent", async () => {
    const run = await launchCounted({ registryDir: temp.make(), userBusAddress: "unix:path=/nonexistent/bus" });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "degraded", reason: "user_bus_unavailable" });
  });

  it("stops at the deadline, reaps exactly its busctl child and runs the target once", async () => {
    const pidFile = path.join(temp.make(), "busctl.pid");
    const busctl = fakeBusctl(`echo $$ > ${pidFile}; exec sleep 30`);
    const run = await launchCounted({
      registryDir: temp.make(),
      userBusAddress: fakeSocket(),
      busctlPath: busctl,
      enrollmentDeadlineMs: 300,
    });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "degraded", reason: "timeout", unitMayExist: true });
    expect(run.enrollment.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(run.enrollment.elapsedMs).toBeLessThan(1_500);
    expect(isAlive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
  });

  it("falls back on an invalid slice given to the helper directly", async () => {
    const dir = temp.make();
    const status = path.join(dir, "status.json");
    const result = await collect(
      spawn(helper!, ["--unit", "pcltest-x.scope", "--slice", "app.slice", "--user-bus", fakeSocket(), "--status-file", status, "--", "echo", "ran"]),
    );
    expect(result.stdout.toString()).toBe("ran\n");
    expect(JSON.parse(readFileSync(status, "utf8"))).toMatchObject({ outcome: "degraded", reason: "invalid_slice" });
  });

  it("falls back on malformed helper options and still runs the target once", async () => {
    const result = await collect(spawn(helper!, ["--deadline-ms", "nope", "--unknown", "x", "--", "echo", "ran"]));
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout.toString()).toBe("ran\n");
    const usage = await collect(spawn(helper!, ["--unit", "x.scope"]));
    expect(usage.code).toBe(125);
    expect(usage.stdout.length + usage.stderr.length).toBe(0);
  });
});

describe.skipIf(realSkip !== null)(`injected bus failures after job creation${realSkip ? `: skipped, ${realSkip}` : ""}`, () => {
  it("keeps and records the scope when the reply is lost after registration", async () => {
    const busctl = fakeBusctl('/usr/bin/busctl "$@" >/dev/null 2>&1; echo "Connection reset" >&2; exit 1');
    const run = await launchCounted({ registryDir: temp.make(), userBusAddress: realBus, slice: testSlice, busctlPath: busctl });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "enrolled", responseLost: true });
    expect(run.cgroup).toBe(run.enrollment.cgroup);
  });

  it("keeps and records the scope when registration succeeded but the reply missed the deadline", async () => {
    const busctl = fakeBusctl('/usr/bin/busctl "$@" >/dev/null 2>&1; exec sleep 30');
    const run = await launchCounted({
      registryDir: temp.make(),
      userBusAddress: realBus,
      slice: testSlice,
      busctlPath: busctl,
      enrollmentDeadlineMs: 1_000,
    });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "enrolled", responseLost: true, reason: null });
    expect(run.cgroup).toBe(run.enrollment.cgroup);
  });

  it("enrolls through the real manager within the deadline", async () => {
    const registryDir = temp.make();
    const run = await launchCounted({ registryDir, userBusAddress: realBus, slice: testSlice });
    expect(run.runs).toBe(1);
    expect(run.enrollment).toMatchObject({ outcome: "enrolled", responseLost: false });
    expect(run.enrollment.elapsedMs).toBeLessThan(2_000);
    expect(run.cgroup).toBe(run.enrollment.cgroup);
    // The empty scope is collected once its only process exits.
    expect(await waitUntil(() => !existsSync(`/sys/fs/cgroup${run.enrollment.cgroup}`))).toBe(true);
    expect(readScopeStatus({ registryDir, unit: run.enrollment.unit })?.outcome).toBe("enrolled");
  });
});
