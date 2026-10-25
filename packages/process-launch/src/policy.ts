import path from "node:path";
import { isOpaqueId } from "./unit-names.js";

export type AgentProcessIsolationMode = "off" | "systemd";

/** Who owns one independently terminable process tree. */
export type ProcessOwnerKind =
  | "run"
  | "warm_provider"
  | "runner"
  | "managed_service"
  | "auxiliary"
  | "relay";

export const PROCESS_OWNER_KINDS: readonly ProcessOwnerKind[] = [
  "run",
  "warm_provider",
  "runner",
  "managed_service",
  "auxiliary",
  "relay",
];

export interface ProcessOwner {
  readonly kind: ProcessOwnerKind;
  /** An opaque id such as a run id. Never a title, prompt or command. */
  readonly id: string;
  readonly companyId?: string | null;
}

export interface OffIsolationPolicy {
  readonly mode: "off";
}

export interface SystemdIsolationPolicy {
  readonly mode: "systemd";
  readonly slice: string;
  readonly instanceId: string;
  /** `<instance>/runtime/agent-scopes`, see {@link agentScopeRegistryDir}. */
  readonly registryDir: string;
  /** Resolved once from the server's own environment, see {@link resolveUserBusAddress}. */
  readonly userBusAddress: string | null;
  /** Absolute helper path, or null to use the packaged helper. */
  readonly helperPath: string | null;
  readonly busctlPath: string;
  readonly enrollmentDeadlineMs: number;
  readonly stopTimeoutMs: number;
}

/**
 * Trusted, immutable launch policy. It is created once by the server from
 * instance configuration and passed to launch roots; it is never read from
 * provider-supplied configuration or an agent's environment.
 */
export type AgentProcessIsolationPolicy = OffIsolationPolicy | SystemdIsolationPolicy;

export const DEFAULT_ENROLLMENT_DEADLINE_MS = 2_000;
export const DEFAULT_SCOPE_STOP_TIMEOUT_MS = 10_000;
export const DEFAULT_BUSCTL_PATH = "/usr/bin/busctl";

export const OFF_ISOLATION_POLICY: OffIsolationPolicy = Object.freeze({ mode: "off" });

export interface SystemdIsolationPolicyInput {
  slice: string;
  instanceId: string;
  registryDir: string;
  userBusAddress: string | null;
  helperPath?: string | null;
  busctlPath?: string;
  enrollmentDeadlineMs?: number;
  stopTimeoutMs?: number;
}

function boundedMillis(value: number | undefined, fallback: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

/**
 * Build a frozen systemd policy. The slice is not validated here: an invalid
 * slice makes every launch fall back to a plain spawn, recorded as degraded.
 */
export function createSystemdIsolationPolicy(input: SystemdIsolationPolicyInput): SystemdIsolationPolicy {
  if (!isOpaqueId(input.instanceId)) throw new Error("instanceId must be an opaque id");
  if (!path.isAbsolute(input.registryDir)) throw new Error("registryDir must be absolute");
  if (input.helperPath != null && !path.isAbsolute(input.helperPath)) throw new Error("helperPath must be absolute");
  const busctlPath = input.busctlPath ?? DEFAULT_BUSCTL_PATH;
  if (!path.isAbsolute(busctlPath)) throw new Error("busctlPath must be absolute");
  return Object.freeze({
    mode: "systemd",
    slice: input.slice,
    instanceId: input.instanceId,
    registryDir: path.resolve(input.registryDir),
    userBusAddress: input.userBusAddress,
    helperPath: input.helperPath ?? null,
    busctlPath,
    enrollmentDeadlineMs: boundedMillis(
      input.enrollmentDeadlineMs,
      DEFAULT_ENROLLMENT_DEADLINE_MS,
      30_000,
      "enrollmentDeadlineMs",
    ),
    stopTimeoutMs: boundedMillis(input.stopTimeoutMs, DEFAULT_SCOPE_STOP_TIMEOUT_MS, 300_000, "stopTimeoutMs"),
  });
}

/** The private ownership registry of one instance. */
export function agentScopeRegistryDir(instanceRoot: string): string {
  return path.join(instanceRoot, "runtime", "agent-scopes");
}

/**
 * The same-UID user bus, from the server's host environment before any
 * per-run HOME or XDG changes. Only a plain `unix:path=` address is used.
 */
export function resolveUserBusAddress(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | null = process.getuid?.() ?? null,
): string | null {
  const configured = env.DBUS_SESSION_BUS_ADDRESS?.trim();
  if (configured) {
    return /^unix:path=\/[^,;]+$/.test(configured) ? configured : null;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir && path.isAbsolute(runtimeDir)) return `unix:path=${path.join(runtimeDir, "bus")}`;
  if (uid === null) return null;
  return `unix:path=/run/user/${uid}/bus`;
}
