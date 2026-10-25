import { mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRegistryDir,
  listScopeRecordRefs,
  manifestPath,
  readScopeRecord,
  removeScopeRecord,
  SCOPE_MANIFEST_KIND,
  statusPath,
  writeScopeManifest,
  type ScopeManifest,
} from "./registry.js";
import { buildScopeUnitName, newLaunchNonce, scopeUnitNamespace } from "./unit-names.js";

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "pcl-registry-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function manifest(instanceId = "default"): ScopeManifest {
  const nonce = newLaunchNonce();
  return {
    version: 1,
    kind: SCOPE_MANIFEST_KIND,
    instanceId,
    owner: { kind: "run", id: "run-1", companyId: null },
    nonce,
    unit: buildScopeUnitName({ instanceId, ownerKind: "run", ownerId: "run-1", nonce }),
    slice: "app-agents.slice",
    bootId: null,
    createdAt: new Date(0).toISOString(),
    state: "intent",
    pid: null,
    pidStartTime: null,
    expectedCgroup: null,
    preflight: null,
  };
}

describe("scope registry", () => {
  it("creates a private directory and private files atomically", () => {
    const dir = path.join(tempRoot(), "runtime", "agent-scopes");
    ensureRegistryDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const record = manifest();
    const ref = writeScopeManifest(dir, record);
    writeScopeManifest(dir, { ...record, state: "spawned", pid: 123 });
    expect(statSync(manifestPath(ref)).mode & 0o777).toBe(0o600);
    // No temporary files are left behind.
    expect(readdirSync(dir)).toEqual([`${record.unit}.json`]);
    expect(readScopeRecord(ref)?.manifest).toMatchObject({ version: 1, state: "spawned", pid: 123 });
  });

  it("tightens a pre-existing directory and refuses a symlink", () => {
    const root = tempRoot();
    const dir = path.join(root, "open");
    mkdirSync(dir, { mode: 0o755 });
    ensureRegistryDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    const link = path.join(root, "link");
    symlinkSync(dir, link);
    expect(() => ensureRegistryDir(link)).toThrow();
  });

  it("reads the helper status next to the manifest and rejects foreign records", () => {
    const dir = tempRoot();
    const record = manifest();
    const ref = writeScopeManifest(dir, record);
    expect(readScopeRecord(ref)?.status).toBeNull();
    writeFileSync(
      statusPath(ref),
      JSON.stringify({ version: 1, kind: "paperclip-scope-exec-status", unit: record.unit, outcome: "degraded", pid: 5 }),
    );
    expect(readScopeRecord(ref)?.status).toMatchObject({ outcome: "degraded", pid: 5 });
    writeFileSync(statusPath(ref), JSON.stringify({ version: 1, kind: "paperclip-scope-exec-status", unit: "x.scope" }));
    expect(readScopeRecord(ref)?.status).toBeNull();
    writeFileSync(manifestPath(ref), JSON.stringify({ version: 2 }));
    expect(() => readScopeRecord(ref)).toThrow();
  });

  it("lists only one instance's namespace and removes records idempotently", () => {
    const dir = tempRoot();
    const mine = writeScopeManifest(dir, manifest("default"));
    writeScopeManifest(dir, manifest("other"));
    writeFileSync(path.join(dir, `${mine.unit}.status.json`), "{}");
    writeFileSync(path.join(dir, ".stray.tmp"), "");
    expect(listScopeRecordRefs(dir, scopeUnitNamespace("default"))).toEqual([mine]);
    removeScopeRecord(mine);
    removeScopeRecord(mine);
    expect(readScopeRecord(mine)).toBeNull();
    expect(listScopeRecordRefs(path.join(dir, "missing"), "pcagent-")).toEqual([]);
  });

  it("refuses unit names that could escape the directory", () => {
    expect(() => readScopeRecord({ registryDir: "/tmp", unit: "../x.scope" })).toThrow();
  });
});
