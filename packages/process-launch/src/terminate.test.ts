import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, inject, it } from "vitest";
import { spawnIsolated, type LaunchHandle } from "./launch.js";
import type { SystemdIsolationPolicy } from "./policy.js";
import { readProcCgroup } from "./proc.js";
import {
  listScopeRecordRefs,
  readScopeRecord,
  statusPath,
  writeScopeManifest,
  type ScopeRecordRef,
} from "./registry.js";
import { terminateOwnedProcessTree } from "./terminate.js";
import { isAlive, tempDirs, testPolicy, waitUntil } from "./test-support.js";
import { scopeUnitNamespace } from "./unit-names.js";

const helper = inject("scopeHelper");
const systemdSkip = inject("scopeHelperSkipReason") ?? inject("systemdSkipReason");
const testSlice = inject("testSlice");
const owner = { kind: "run", id: "run-terminate-test", companyId: "company-a" } as const;
const temp = tempDirs();
// Process ids to SIGKILL after each test; a negative id is a whole process group.
const strays: number[] = [];
const registries: Array<{ registryDir: string; instanceId: string }> = [];

afterEach(async () => {
  for (const { registryDir, instanceId } of registries.splice(0)) {
    for (const ref of listScopeRecordRefs(registryDir, scopeUnitNamespace(instanceId))) {
      await terminateOwnedProcessTree(ref, { instanceId, graceMs: 100, killWaitMs: 2_000 });
    }
  }
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  temp.cleanup();
});

function newInstance() {
  return `pcltest-${randomBytes(4).toString("hex")}`;
}

function launch(policy: SystemdIsolationPolicy, script: string, detached = true) {
  registries.push({ registryDir: policy.registryDir, instanceId: policy.instanceId });
  const result = spawnIsolated(
    { command: "sh", args: ["-c", script], options: { detached, stdio: "ignore" } },
    { policy, owner },
  );
  result.child.on("error", () => {});
  return result;
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });
}

async function readPid(file: string): Promise<number> {
  expect(await waitUntil(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "")).toBe(true);
  return Number(readFileSync(file, "utf8").trim());
}

function record(launchHandle: LaunchHandle): ScopeRecordRef {
  expect(launchHandle.record).not.toBeNull();
  return launchHandle.record!;
}

describe("terminate without a scope (degraded launch)", () => {
  // helperPath points nowhere, so every launch is a recorded plain spawn.
  const degradedPolicy = (instanceId = newInstance()) =>
    testPolicy({ registryDir: temp.make(), instanceId, helperPath: "/nonexistent/helper" });

  it("stops the recorded process group, then reports a repeat as a missing record", async () => {
    const policy = degradedPolicy();
    const pidFile = path.join(temp.make(), "member.pid");
    const { child, launch: handle } = launch(policy, `sleep 300 & echo $! > ${pidFile}; wait`);
    const member = await readPid(pidFile);
    strays.push(member);
    const result = await terminateOwnedProcessTree(record(handle), { instanceId: policy.instanceId, graceMs: 2_000 });
    expect(result).toMatchObject({ outcome: "terminated", containment: "process_group" });
    await exited(child);
    expect(await waitUntil(() => !isAlive(member))).toBe(true);
    expect(readScopeRecord(record(handle))).toBeNull();
    expect(await terminateOwnedProcessTree(record(handle), { instanceId: policy.instanceId })).toMatchObject({
      outcome: "missing_record",
    });
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const policy = degradedPolicy();
    const { child, launch: handle } = launch(policy, 'trap "" TERM; while :; do sleep 0.05; done');
    const started = Date.now();
    const result = await terminateOwnedProcessTree(record(handle), { instanceId: policy.instanceId, graceMs: 300 });
    expect(result.outcome).toBe("terminated");
    expect(result.signalled).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    await exited(child);
    expect(child.signalCode).toBe("SIGKILL");
  });

  it("never signals a PID whose start time does not match the record", async () => {
    const policy = degradedPolicy();
    const { child, launch: handle } = launch(policy, "sleep 300");
    strays.push(-child.pid!);
    const ref = record(handle);
    const current = readScopeRecord(ref)!.manifest;
    writeScopeManifest(ref.registryDir, { ...current, pidStartTime: "1" });
    const result = await terminateOwnedProcessTree(ref, { instanceId: policy.instanceId, graceMs: 100 });
    expect(result).toMatchObject({ outcome: "already_empty", signalled: 0 });
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("refuses a record of another instance and keeps it", async () => {
    const policy = degradedPolicy();
    const { child, launch: handle } = launch(policy, "sleep 300");
    strays.push(-child.pid!);
    const result = await terminateOwnedProcessTree(record(handle), { instanceId: newInstance() });
    expect(result).toMatchObject({ outcome: "unconfirmed", reason: "record_identity_mismatch", signalled: 0 });
    expect(isAlive(child.pid!)).toBe(true);
    expect(readScopeRecord(record(handle))).not.toBeNull();
  });
});

describe("terminate with a scope record", () => {
  function enrolledRecord(policy: SystemdIsolationPolicy, cgroup: string | null) {
    const { child, launch: handle } = launch(policy, "sleep 300");
    strays.push(-child.pid!);
    const ref = record(handle);
    const { manifest } = readScopeRecord(ref)!;
    const scope = cgroup ?? `/user.slice/user-1.slice/user@1.service/app.slice/app-agents.slice/${ref.unit}`;
    // As if the helper had run: no preflight fallback, a helper status.
    writeScopeManifest(ref.registryDir, { ...manifest, preflight: null });
    writeFileSync(
      statusPath(ref),
      JSON.stringify({
        version: 1,
        kind: "paperclip-scope-exec-status",
        unit: ref.unit,
        slice: manifest.slice,
        outcome: "enrolled",
        pid: child.pid,
        cgroup: scope,
        unitMayExist: false,
      }),
    );
    return { child, ref, scope };
  }

  it("never signals listed members whose own cgroup is not the scope", async () => {
    const policy = testPolicy({ registryDir: temp.make(), instanceId: newInstance(), helperPath: "/nonexistent/helper" });
    const { child, ref, scope } = enrolledRecord(policy, null);
    // A fake cgroup tree that lists a live process which is really elsewhere.
    const cgroupRoot = temp.make();
    mkdirSync(`${cgroupRoot}${scope}`, { recursive: true });
    writeFileSync(`${cgroupRoot}${scope}/cgroup.events`, "populated 1\nfrozen 0\n");
    writeFileSync(`${cgroupRoot}${scope}/cgroup.procs`, `${child.pid}\n`);
    const result = await terminateOwnedProcessTree(ref, {
      instanceId: policy.instanceId,
      cgroupRoot,
      graceMs: 100,
      killWaitMs: 200,
    });
    expect(result).toMatchObject({ outcome: "unconfirmed", reason: "scope_not_empty", containment: "scope" });
    expect(isAlive(child.pid!)).toBe(true);
    expect(readScopeRecord(ref)).not.toBeNull();
  });

  it("refuses an enrolled status that names a cgroup outside its own scope", async () => {
    const policy = testPolicy({ registryDir: temp.make(), instanceId: newInstance(), helperPath: "/nonexistent/helper" });
    const { child, ref } = enrolledRecord(policy, "/user.slice/user-1.slice/user@1.service/app.slice");
    const result = await terminateOwnedProcessTree(ref, { instanceId: policy.instanceId });
    expect(result).toMatchObject({ outcome: "unconfirmed", reason: "record_identity_mismatch" });
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("refuses a record whose status contradicts its preflight fallback", async () => {
    const policy = testPolicy({ registryDir: temp.make(), instanceId: newInstance(), helperPath: "/nonexistent/helper" });
    const { child, ref } = enrolledRecord(policy, null);
    writeScopeManifest(ref.registryDir, { ...readScopeRecord(ref)!.manifest, preflight: { outcome: "degraded", reason: "helper_missing" } });
    const result = await terminateOwnedProcessTree(ref, { instanceId: policy.instanceId });
    expect(result).toMatchObject({ outcome: "unconfirmed", reason: "record_identity_mismatch" });
    expect(isAlive(child.pid!)).toBe(true);
  });

  it("removes the record of a scope that is already gone", async () => {
    const policy = testPolicy({ registryDir: temp.make(), instanceId: newInstance(), helperPath: "/nonexistent/helper" });
    const { ref } = enrolledRecord(policy, null);
    const result = await terminateOwnedProcessTree(ref, { instanceId: policy.instanceId, cgroupRoot: temp.make() });
    expect(result).toMatchObject({ outcome: "already_empty", containment: "none" });
    expect(readScopeRecord(ref)).toBeNull();
  });
});

describe.skipIf(systemdSkip !== null)(`terminate a real scope${systemdSkip ? `: skipped, ${systemdSkip}` : ""}`, () => {
  const scopePolicy = (instanceId = newInstance()) =>
    testPolicy({
      registryDir: temp.make(),
      instanceId,
      helperPath: helper,
      slice: testSlice,
      userBusAddress: `unix:path=/run/user/${process.getuid?.()}/bus`,
    });

  it("kills a grandchild that called setsid and cleared its environment, after SIGTERM is refused", async () => {
    const policy = scopePolicy();
    const pidFile = path.join(temp.make(), "grandchild.pid");
    const { child, launch: handle } = launch(
      policy,
      `trap "" TERM; setsid env -i /bin/sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 0.05; done' & while :; do sleep 0.05; done`,
    );
    const grandchild = await readPid(pidFile);
    strays.push(grandchild);
    const enrollment = handle.readEnrollment()!;
    expect(enrollment.outcome).toBe("enrolled");
    expect(readProcCgroup(grandchild)).toBe(enrollment.cgroup);
    expect(readFileSync(`/proc/${grandchild}/environ`).length).toBe(0);

    const result = await terminateOwnedProcessTree(record(handle), { instanceId: policy.instanceId, graceMs: 300 });
    expect(result).toMatchObject({ outcome: "terminated", containment: "scope" });
    await exited(child);
    expect(isAlive(grandchild)).toBe(false);
    expect(await waitUntil(() => !existsSync(`/sys/fs/cgroup${enrollment.cgroup}`))).toBe(true);
    expect(readScopeRecord(record(handle))).toBeNull();
  });

  it("reaps a descendant left behind after the root exited normally", async () => {
    const policy = scopePolicy();
    const pidFile = path.join(temp.make(), "leftover.pid");
    const { child, launch: handle } = launch(policy, `setsid sleep 300 & echo $! > ${pidFile}`);
    await exited(child);
    expect(child.exitCode).toBe(0);
    const leftover = await readPid(pidFile);
    strays.push(leftover);
    expect(isAlive(leftover)).toBe(true);
    const result = await terminateOwnedProcessTree(record(handle), { instanceId: policy.instanceId });
    expect(result).toMatchObject({ outcome: "terminated", containment: "scope" });
    expect(await waitUntil(() => !isAlive(leftover))).toBe(true);
  });

  it("keeps two instances' scopes apart", async () => {
    const first = scopePolicy();
    const second = scopePolicy();
    const a = launch(first, "sleep 300");
    const b = launch(second, "sleep 300");
    strays.push(-a.child.pid!, -b.child.pid!);
    expect(await waitUntil(() => a.launch.readEnrollment() !== null && b.launch.readEnrollment() !== null)).toBe(true);
    expect(a.launch.readEnrollment()!.cgroup).not.toBe(b.launch.readEnrollment()!.cgroup);
    expect(await terminateOwnedProcessTree(record(a.launch), { instanceId: second.instanceId })).toMatchObject({
      outcome: "unconfirmed",
      reason: "record_identity_mismatch",
    });
    expect(await terminateOwnedProcessTree(record(a.launch), { instanceId: first.instanceId })).toMatchObject({
      outcome: "terminated",
    });
    await exited(a.child);
    expect(isAlive(b.child.pid!)).toBe(true);
    expect(await terminateOwnedProcessTree(record(b.launch), { instanceId: second.instanceId })).toMatchObject({
      outcome: "terminated",
    });
  });

  it("finds the scope from the intent record when the status was never written", async () => {
    const policy = scopePolicy();
    const { child, launch: handle } = launch(policy, "sleep 300");
    expect(await waitUntil(() => handle.readEnrollment()?.outcome === "enrolled")).toBe(true);
    const ref = record(handle);
    // Simulate a crash after the move but before a readable status write.
    writeFileSync(statusPath(ref), "");
    const { manifest, status } = readScopeRecord(ref)!;
    expect(status).toBeNull();
    expect(manifest.expectedCgroup).not.toBeNull();
    expect(readProcCgroup(child.pid!)).toBe(manifest.expectedCgroup);
    const result = await terminateOwnedProcessTree(ref, { instanceId: policy.instanceId });
    expect(result).toMatchObject({ outcome: "terminated", containment: "scope" });
    await exited(child);
  });
});
