import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { spawnIsolated } from "./launch.js";
import { readBootId, readProcStat } from "./proc.js";
import { isScopeRootAlive, listOwnedScopeRecords, listUnmatchedScopeUnits } from "./reconcile.js";
import {
  isScopeLaunchedByThisProcess,
  readScopeRecord,
  removeScopeRecord,
  SCOPE_MANIFEST_KIND,
  SCOPE_MANIFEST_VERSION,
  writeScopeManifest,
  type ScopeManifest,
} from "./registry.js";
import { tempDirs, testPolicy } from "./test-support.js";
import { buildScopeUnitName, newLaunchNonce, sliceCgroupPath } from "./unit-names.js";

const temp = tempDirs();
afterEach(() => temp.cleanup());

function manifest(instanceId: string, overrides: Partial<ScopeManifest> = {}): ScopeManifest {
  const nonce = newLaunchNonce();
  const owner = { kind: "run" as const, id: "run-1", companyId: "company-a" };
  return {
    version: SCOPE_MANIFEST_VERSION,
    kind: SCOPE_MANIFEST_KIND,
    instanceId,
    owner,
    nonce,
    unit: buildScopeUnitName({ instanceId, ownerKind: owner.kind, ownerId: owner.id, companyId: owner.companyId, nonce }),
    slice: "app-agents.slice",
    bootId: readBootId(),
    createdAt: new Date().toISOString(),
    state: "spawned",
    pid: null,
    pidStartTime: null,
    expectedCgroup: null,
    preflight: { outcome: "degraded", reason: "helper_missing" },
    ...overrides,
  };
}

describe("listOwnedScopeRecords", () => {
  it("returns only this instance's records, even when two instances share a directory", () => {
    const dir = temp.make();
    const mine = writeScopeManifest(dir, manifest("instance-a"));
    writeScopeManifest(dir, manifest("instance-b"));
    const listing = listOwnedScopeRecords(dir, "instance-a");
    expect(listing.records.map((record) => record.ref.unit)).toEqual([mine.unit]);
    expect(listing.unreadable).toEqual([]);
  });

  it("reports an unreadable record instead of treating it as empty", () => {
    const dir = temp.make();
    const ref = writeScopeManifest(dir, manifest("instance-a"));
    writeFileSync(path.join(dir, `${ref.unit}.json`), "{not json");
    const listing = listOwnedScopeRecords(dir, "instance-a");
    expect(listing.records).toEqual([]);
    expect(listing.unreadable.map((entry) => entry.unit)).toEqual([ref.unit]);
  });

  it("returns nothing for a registry that does not exist", () => {
    expect(listOwnedScopeRecords(path.join(temp.make(), "missing"), "instance-a")).toEqual({ records: [], unreadable: [] });
  });
});

describe("isScopeLaunchedByThisProcess", () => {
  it("is true for this process's own launches until the record is removed, and false for written records", async () => {
    const dir = temp.make();
    const policy = testPolicy({ registryDir: dir, helperPath: "/nonexistent/helper" });
    const { child, launch } = spawnIsolated({ command: "true" }, { policy, owner: { kind: "auxiliary", id: "aux-1" } });
    await new Promise((resolve) => child.once("exit", resolve));
    expect(isScopeLaunchedByThisProcess(launch.record!)).toBe(true);
    removeScopeRecord(launch.record!);
    expect(isScopeLaunchedByThisProcess(launch.record!)).toBe(false);

    const inherited = writeScopeManifest(dir, manifest(policy.instanceId));
    expect(isScopeLaunchedByThisProcess(inherited)).toBe(false);
  });
});

describe("isScopeRootAlive", () => {
  it("is true for the recorded root and false once it exited", async () => {
    const dir = temp.make();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const startTime = readProcStat(child.pid!)!.startTime;
    const ref = writeScopeManifest(dir, manifest("instance-a", { pid: child.pid!, pidStartTime: startTime }));
    expect(isScopeRootAlive(readScopeRecord(ref)!)).toBe(true);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(isScopeRootAlive(readScopeRecord(ref)!)).toBe(false);
  });

  it("is false for a reused PID (another start time), another boot, or a launch with no PID", () => {
    const dir = temp.make();
    const reused = writeScopeManifest(dir, manifest("instance-a", { pid: process.pid, pidStartTime: "1" }));
    expect(isScopeRootAlive(readScopeRecord(reused)!)).toBe(false);
    const ownStart = readProcStat(process.pid)!.startTime;
    const otherBoot = writeScopeManifest(
      dir,
      manifest("instance-a", { pid: process.pid, pidStartTime: ownStart, bootId: "00000000-0000-0000-0000-000000000000" }),
    );
    expect(isScopeRootAlive(readScopeRecord(otherBoot)!)).toBe(false);
    const intent = writeScopeManifest(dir, manifest("instance-a", { state: "intent" }));
    expect(isScopeRootAlive(readScopeRecord(intent)!)).toBe(false);
  });
});

describe("listUnmatchedScopeUnits", () => {
  it("lists live namespace units without a record, and nothing of other instances or recorded units", () => {
    const dir = temp.make();
    const cgroupRoot = temp.make();
    const manager = "/user.slice/user-1000.slice/user@1000.service";
    const sliceDir = path.join(cgroupRoot, manager, sliceCgroupPath("app-agents.slice"));
    const recorded = writeScopeManifest(dir, manifest("instance-a"));
    const orphan = manifest("instance-a").unit;
    const otherInstance = manifest("instance-b").unit;
    for (const unit of [recorded.unit, orphan, otherInstance, "unrelated.scope"]) mkdirSync(path.join(sliceDir, unit), { recursive: true });

    expect(
      listUnmatchedScopeUnits({
        registryDir: dir,
        instanceId: "instance-a",
        slices: ["app-agents.slice", "app-agents.slice", "../escape.slice"],
        managerCgroup: manager,
        cgroupRoot,
      }),
    ).toEqual([orphan]);
  });

  it("finds nothing when this process is not below a user manager", () => {
    expect(
      listUnmatchedScopeUnits({ registryDir: temp.make(), instanceId: "instance-a", slices: ["app-agents.slice"], managerCgroup: null }),
    ).toEqual([]);
  });
});

describe("scope unit properties", () => {
  // Scopes must outlive the server for hot-restart adoption, so they are
  // never bound to the Paperclip service (plan SX-2306).
  it("never ties a scope's lifetime to another unit", () => {
    const enroll = readFileSync(fileURLToPath(new URL("../helper/src/enroll.rs", import.meta.url)), "utf8");
    for (const property of ["BindsTo", "PartOf", "Requires", "Requisite", "StopWhenUnneeded"]) {
      expect(enroll).not.toContain(`"${property}"`);
    }
  });
});
