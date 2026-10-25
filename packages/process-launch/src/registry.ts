import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import type { ProcessOwnerKind } from "./policy.js";
import { isValidScopeName } from "./unit-names.js";

/**
 * One launch record is two files in the private registry directory, each
 * with a single writer and each replaced atomically:
 *
 * - `<unit>.json`: the intent manifest, written by this package before the
 *   spawn and updated with the PID right after it.
 * - `<unit>.status.json`: the helper's enrollment status, written by
 *   `paperclip-scope-exec` before it executes the target.
 *
 * Neither file ever holds the target's arguments, environment, credentials,
 * prompts or output.
 */

export const SCOPE_MANIFEST_VERSION = 1;
export const SCOPE_MANIFEST_KIND = "paperclip-agent-scope";
export const SCOPE_STATUS_KIND = "paperclip-scope-exec-status";

export type DegradedReason =
  | "unsupported_platform"
  | "registry_unavailable"
  | "invalid_slice"
  | "helper_missing"
  | "helper_spawn_failed"
  | "user_bus_unconfigured";

export interface ScopeManifest {
  version: typeof SCOPE_MANIFEST_VERSION;
  kind: typeof SCOPE_MANIFEST_KIND;
  instanceId: string;
  owner: { kind: ProcessOwnerKind; id: string; companyId: string | null };
  nonce: string;
  unit: string;
  slice: string;
  bootId: string | null;
  createdAt: string;
  state: "intent" | "spawned";
  pid: number | null;
  pidStartTime: string | null;
  /** Where the scope's cgroup will be when enrollment succeeds. */
  expectedCgroup: string | null;
  /** Set when this package fell back before starting the helper. */
  preflight: { outcome: "degraded"; reason: DegradedReason } | null;
}

/** The helper's status file, see helper/src/status.rs. */
export interface ScopeEnrollmentStatus {
  version: 1;
  kind: typeof SCOPE_STATUS_KIND;
  unit: string;
  slice: string;
  outcome: "enrolled" | "degraded";
  reason: string | null;
  detail: string | null;
  pid: number;
  pidStartTime: string | null;
  bootId: string | null;
  originalCgroup: string | null;
  cgroup: string | null;
  expectedCgroup: string | null;
  responseLost: boolean;
  unitMayExist: boolean;
  elapsedMs: number;
  execError: string | null;
}

export interface ScopeRecordRef {
  readonly registryDir: string;
  readonly unit: string;
}

export interface ScopeRecord {
  ref: ScopeRecordRef;
  manifest: ScopeManifest;
  status: ScopeEnrollmentStatus | null;
}

export function manifestPath(ref: ScopeRecordRef): string {
  return path.join(ref.registryDir, `${ref.unit}.json`);
}

export function statusPath(ref: ScopeRecordRef): string {
  return path.join(ref.registryDir, `${ref.unit}.status.json`);
}

function assertRef(ref: ScopeRecordRef): void {
  if (!isValidScopeName(ref.unit)) throw new Error("Invalid scope unit name");
}

/**
 * Create the registry directory if needed and check it is a real directory,
 * owned by this user and private.
 */
export function ensureRegistryDir(registryDir: string): void {
  mkdirSync(registryDir, { recursive: true, mode: 0o700 });
  const stats = lstatSync(registryDir);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Scope registry is not a directory");
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) throw new Error("Scope registry is owned by another user");
  if ((stats.mode & 0o077) !== 0) chmodSync(registryDir, 0o700);
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is best effort; the rename itself is atomic.
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Write a private file atomically: fresh temporary file, fsync, rename, directory fsync. */
export function writeFileAtomic(file: string, body: string): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temporary, file);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  fsyncDirectory(path.dirname(file));
}

export function writeScopeManifest(registryDir: string, manifest: ScopeManifest): ScopeRecordRef {
  const ref = { registryDir, unit: manifest.unit };
  assertRef(ref);
  writeFileAtomic(manifestPath(ref), `${JSON.stringify(manifest)}\n`);
  return ref;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown, unit: string): ScopeManifest | null {
  if (!isObject(value)) return null;
  if (value.version !== SCOPE_MANIFEST_VERSION || value.kind !== SCOPE_MANIFEST_KIND) return null;
  if (value.unit !== unit || typeof value.instanceId !== "string" || !isObject(value.owner)) return null;
  if (value.pid !== null && !Number.isInteger(value.pid)) return null;
  return value as unknown as ScopeManifest;
}

function parseStatus(value: unknown, unit: string): ScopeEnrollmentStatus | null {
  if (!isObject(value)) return null;
  if (value.version !== 1 || value.kind !== SCOPE_STATUS_KIND || value.unit !== unit) return null;
  if (value.outcome !== "enrolled" && value.outcome !== "degraded") return null;
  if (!Number.isInteger(value.pid)) return null;
  return value as unknown as ScopeEnrollmentStatus;
}

/**
 * Read one launch record. Returns null when the manifest is missing; throws
 * when it exists but is not a valid record, so it is never mistaken for an
 * empty scope.
 */
export function readScopeRecord(ref: ScopeRecordRef): ScopeRecord | null {
  assertRef(ref);
  const rawManifest = readJson(manifestPath(ref));
  if (rawManifest === undefined) return null;
  const manifest = parseManifest(rawManifest, ref.unit);
  if (!manifest) throw new Error(`Unreadable scope manifest for ${ref.unit}`);
  const rawStatus = readJson(statusPath(ref));
  return { ref, manifest, status: rawStatus === undefined ? null : parseStatus(rawStatus, ref.unit) };
}

export function readScopeStatus(ref: ScopeRecordRef): ScopeEnrollmentStatus | null {
  assertRef(ref);
  const raw = readJson(statusPath(ref));
  return raw === undefined ? null : parseStatus(raw, ref.unit);
}

/** Launch records of one unit namespace, see `scopeUnitNamespace`. */
export function listScopeRecordRefs(registryDir: string, namespace: string): ScopeRecordRef[] {
  let names: string[];
  try {
    names = readdirSync(registryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".scope.json") && name.startsWith(namespace))
    .map((name) => ({ registryDir, unit: name.slice(0, -".json".length) }))
    .filter((ref) => isValidScopeName(ref.unit))
    .sort((a, b) => a.unit.localeCompare(b.unit));
}

/** Remove both files of a record. Removing a missing record is not an error. */
export function removeScopeRecord(ref: ScopeRecordRef): void {
  assertRef(ref);
  for (const file of [statusPath(ref), manifestPath(ref)]) {
    try {
      unlinkSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  fsyncDirectory(ref.registryDir);
}
