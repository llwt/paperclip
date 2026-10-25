import { createHash, randomBytes } from "node:crypto";

// These rules mirror helper/src/names.rs. Both sides validate.

const MAX_UNIT_NAME = 255;
const UNIT_CHARS = /^[A-Za-z0-9_.:-]+$/;
const OPAQUE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Slices that must never receive agent workloads: the root slice, the
 * well-known top-level slices, and `app.slice`, which holds the Paperclip
 * service itself.
 */
const RESERVED_SLICES = new Set([
  "-.slice",
  "system.slice",
  "user.slice",
  "machine.slice",
  "app.slice",
  "session.slice",
  "background.slice",
]);

export const DEFAULT_AGENT_SLICE = "app-agents.slice";
export const SCOPE_UNIT_PREFIX = "pcagent";

/** A non-root slice name such as `app-agents.slice`, with no separators or path traversal. */
export function isValidSliceName(name: string): boolean {
  if (name.length > MAX_UNIT_NAME || RESERVED_SLICES.has(name)) return false;
  if (!name.endsWith(".slice")) return false;
  const stem = name.slice(0, -".slice".length);
  if (stem.length === 0 || !UNIT_CHARS.test(stem) || stem.includes(".")) return false;
  return stem.split("-").every((segment) => segment.length > 0);
}

export function isValidScopeName(name: string): boolean {
  if (name.length > MAX_UNIT_NAME || !name.endsWith(".scope")) return false;
  const stem = name.slice(0, -".scope".length);
  return stem.length > 0 && !stem.startsWith("-") && UNIT_CHARS.test(stem);
}

/**
 * Identifiers that go into unit names and manifests must be opaque ids, not
 * titles or commands. They are hashed before use in a unit name anyway.
 */
export function isOpaqueId(value: string): boolean {
  return OPAQUE_ID.test(value);
}

/** The cgroup path of a slice below its manager: `app-agents.slice` is `/app.slice/app-agents.slice`. */
export function sliceCgroupPath(slice: string): string {
  const stem = slice.endsWith(".slice") ? slice.slice(0, -".slice".length) : slice;
  const segments = stem.split("-");
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("-")}.slice`).join("");
}

function digest(value: string, length: number): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

/** Every scope unit of one instance starts with this prefix. */
export function scopeUnitNamespace(instanceId: string): string {
  return `${SCOPE_UNIT_PREFIX}-${digest(`instance:${instanceId}`, 12)}-`;
}

export function newLaunchNonce(): string {
  return randomBytes(8).toString("hex");
}

export interface ScopeUnitNameInput {
  instanceId: string;
  ownerKind: string;
  ownerId: string;
  companyId?: string | null;
  nonce: string;
}

/**
 * `pcagent-<instance>-<owner>-<nonce>.scope`, built only from hashed
 * identity and a per-launch nonce, never from titles or commands.
 */
export function buildScopeUnitName(input: ScopeUnitNameInput): string {
  if (!/^[0-9a-f]{16}$/.test(input.nonce)) throw new Error("Launch nonce must be 16 lowercase hex characters");
  const owner = digest(`owner:${input.companyId ?? ""}:${input.ownerKind}:${input.ownerId}`, 16);
  return `${scopeUnitNamespace(input.instanceId)}${owner}-${input.nonce}.scope`;
}
