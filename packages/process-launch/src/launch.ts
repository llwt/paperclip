import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolveHelperPath } from "./helper-path.js";
import type { AgentProcessIsolationPolicy, ProcessOwner, SystemdIsolationPolicy } from "./policy.js";
import { PROCESS_OWNER_KINDS } from "./policy.js";
import { readBootId, readProcCgroup, readProcStat, userManagerCgroup } from "./proc.js";
import {
  ensureRegistryDir,
  markLaunchedByThisProcess,
  readScopeRecord,
  readScopeStatus,
  removeScopeRecord,
  SCOPE_MANIFEST_KIND,
  SCOPE_MANIFEST_VERSION,
  statusPath,
  writeScopeManifest,
  type DegradedReason,
  type ScopeEnrollmentStatus,
  type ScopeManifest,
  type ScopeRecordRef,
} from "./registry.js";
import { buildScopeUnitName, isOpaqueId, isValidSliceName, newLaunchNonce, sliceCgroupPath } from "./unit-names.js";

/** An already-resolved launch, exactly as the caller would pass it to `spawn`. */
export interface LaunchTarget {
  command: string;
  args?: readonly string[];
  options?: SpawnOptions;
}

export interface IsolationRequest {
  policy: AgentProcessIsolationPolicy;
  owner: ProcessOwner;
}

export type LaunchIsolation =
  | { state: "off" }
  /** The helper will try to enroll; its status file has the outcome. */
  | { state: "requested"; unit: string; record: ScopeRecordRef }
  /** Plain spawn, decided before any workload started. */
  | { state: "degraded"; reason: DegradedReason; unit: string | null; record: ScopeRecordRef | null };

export interface PreparedLaunch {
  command: string;
  args: string[];
  options: SpawnOptions;
  isolation: LaunchIsolation;
}

/** How a launched process ended, with helper setup failures kept apart from target exits. */
export type LaunchExit =
  | { kind: "target"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "target_exec_failed"; error: string; code: number | null }
  | { kind: "helper_usage_error"; code: number };

export interface LaunchHandle {
  readonly isolation: LaunchIsolation;
  readonly record: ScopeRecordRef | null;
  /** The helper's status, once it has written one; null otherwise. */
  readEnrollment(): ScopeEnrollmentStatus | null;
  classifyExit(code: number | null, signal: NodeJS.Signals | null): LaunchExit;
}

export interface LaunchDeps {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
  now?: () => Date;
}

// Exit codes the helper uses only when the target never ran (helper/src/main.rs).
const HELPER_EXIT_USAGE = 125;

function assertOwner(owner: ProcessOwner): void {
  if (!PROCESS_OWNER_KINDS.includes(owner.kind)) throw new Error("Unknown process owner kind");
  if (!isOpaqueId(owner.id)) throw new Error("Process owner id must be an opaque id");
  if (owner.companyId != null && !isOpaqueId(owner.companyId)) throw new Error("companyId must be an opaque id");
}

/**
 * Node's own shell and argv0 rules (lib/child_process.js, POSIX branch), so
 * that a wrapped spawn runs exactly the program an unwrapped one would.
 */
function resolveExecTarget(target: LaunchTarget): { file: string; argv0: string; args: string[] } {
  const options = target.options ?? {};
  let file = target.command;
  let args = [...(target.args ?? [])];
  if (options.shell) {
    const command = [file, ...args].join(" ");
    file = typeof options.shell === "string" ? options.shell : "/bin/sh";
    args = ["-c", command];
  }
  const argv0 = typeof options.argv0 === "string" ? options.argv0 : file;
  return { file, argv0, args };
}

function unchanged(target: LaunchTarget, isolation: LaunchIsolation): PreparedLaunch {
  return { command: target.command, args: [...(target.args ?? [])], options: target.options ?? {}, isolation };
}

function expectedScopeCgroup(policy: SystemdIsolationPolicy, unit: string): string | null {
  const own = readProcCgroup("self");
  const uid = process.getuid?.();
  if (!own || uid === undefined) return null;
  const manager = userManagerCgroup(own, uid);
  return manager ? `${manager}${sliceCgroupPath(policy.slice)}/${unit}` : null;
}

function writePreflight(ref: ScopeRecordRef, manifest: ScopeManifest, reason: DegradedReason): LaunchIsolation {
  manifest.preflight = { outcome: "degraded", reason };
  try {
    writeScopeManifest(ref.registryDir, manifest);
    return { state: "degraded", reason, unit: manifest.unit, record: ref };
  } catch {
    return { state: "degraded", reason, unit: manifest.unit, record: null };
  }
}

interface PreparedInternal extends PreparedLaunch {
  manifest: ScopeManifest | null;
}

function prepareInternal(target: LaunchTarget, request: IsolationRequest, deps: LaunchDeps): PreparedInternal {
  const { policy, owner } = request;
  // Off mode returns the target untouched, with no filesystem or systemd access.
  if (policy.mode === "off") return { ...unchanged(target, { state: "off" }), manifest: null };
  assertOwner(owner);
  if ((deps.platform ?? process.platform) !== "linux") {
    return {
      ...unchanged(target, { state: "degraded", reason: "unsupported_platform", unit: null, record: null }),
      manifest: null,
    };
  }

  const nonce = newLaunchNonce();
  const unit = buildScopeUnitName({
    instanceId: policy.instanceId,
    ownerKind: owner.kind,
    ownerId: owner.id,
    companyId: owner.companyId ?? null,
    nonce,
  });
  const sliceValid = isValidSliceName(policy.slice);
  const manifest: ScopeManifest = {
    version: SCOPE_MANIFEST_VERSION,
    kind: SCOPE_MANIFEST_KIND,
    instanceId: policy.instanceId,
    owner: { kind: owner.kind, id: owner.id, companyId: owner.companyId ?? null },
    nonce,
    unit,
    slice: policy.slice,
    bootId: readBootId(),
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    state: "intent",
    pid: null,
    pidStartTime: null,
    expectedCgroup: sliceValid ? expectedScopeCgroup(policy, unit) : null,
    preflight: null,
  };

  // The intent is durable before anything is spawned, so a crash between
  // spawn and the caller's own bookkeeping still leaves a record.
  let ref: ScopeRecordRef;
  try {
    ensureRegistryDir(policy.registryDir);
    ref = writeScopeManifest(policy.registryDir, manifest);
    markLaunchedByThisProcess(ref);
  } catch {
    return {
      ...unchanged(target, { state: "degraded", reason: "registry_unavailable", unit: null, record: null }),
      manifest: null,
    };
  }

  if (!sliceValid) return { ...unchanged(target, writePreflight(ref, manifest, "invalid_slice")), manifest };
  const helper = resolveHelperPath(policy.helperPath);
  if (!helper) return { ...unchanged(target, writePreflight(ref, manifest, "helper_missing")), manifest };
  if (!policy.userBusAddress) {
    return { ...unchanged(target, writePreflight(ref, manifest, "user_bus_unconfigured")), manifest };
  }

  const exec = resolveExecTarget(target);
  const helperArgs = [
    "--unit",
    unit,
    "--slice",
    policy.slice,
    "--user-bus",
    policy.userBusAddress,
    "--status-file",
    statusPath(ref),
    "--deadline-ms",
    String(policy.enrollmentDeadlineMs),
    "--stop-timeout-ms",
    String(policy.stopTimeoutMs),
    "--busctl",
    policy.busctlPath,
    "--argv0",
    exec.argv0,
    "--",
    exec.file,
    ...exec.args,
  ];
  // Everything else (cwd, env, stdio, detached, uid/gid, timeout, signal)
  // applies to the helper process, which becomes the target on exec.
  const options: SpawnOptions = { ...(target.options ?? {}), shell: false };
  delete options.argv0;
  return {
    command: helper,
    args: helperArgs,
    options,
    isolation: { state: "requested", unit, record: ref },
    manifest,
  };
}

/**
 * Prepare a launch without spawning it. In off mode the target comes back
 * unchanged. Otherwise a private intent record is written and, when the
 * helper can be used, the launch is rewritten to run through it.
 */
export function prepareIsolatedLaunch(
  target: LaunchTarget,
  request: IsolationRequest,
  deps: LaunchDeps = {},
): PreparedLaunch {
  const { manifest: _manifest, ...prepared } = prepareInternal(target, request, deps);
  return prepared;
}

function markSpawned(ref: ScopeRecordRef, manifest: ScopeManifest, pid: number): void {
  manifest.state = "spawned";
  manifest.pid = pid;
  // The start time does not change across exec, so this identifies the
  // target even if the helper has already replaced itself.
  manifest.pidStartTime = readProcStat(pid)?.startTime ?? null;
  try {
    writeScopeManifest(ref.registryDir, manifest);
  } catch {
    // The intent record stays; recovery treats it as a partial launch.
  }
}

function recordSpawn(ref: ScopeRecordRef | null, manifest: ScopeManifest | null, child: ChildProcess): void {
  if (ref && manifest && child.pid !== undefined) markSpawned(ref, manifest, child.pid);
}

/**
 * For callers that spawn a {@link prepareIsolatedLaunch} result themselves:
 * record the PID right after `spawn` returns it.
 */
export function recordSpawnedProcess(ref: ScopeRecordRef, pid: number): void {
  const record = readScopeRecord(ref);
  if (record) markSpawned(ref, record.manifest, pid);
}

function makeHandle(isolation: LaunchIsolation): LaunchHandle {
  const record = isolation.state === "off" ? null : isolation.record;
  const readEnrollment = () => {
    if (isolation.state !== "requested") return null;
    try {
      return readScopeStatus(isolation.record);
    } catch {
      return null;
    }
  };
  return {
    isolation,
    record,
    readEnrollment,
    classifyExit(code, signal) {
      if (isolation.state === "requested") {
        const status = readEnrollment();
        if (status?.execError) return { kind: "target_exec_failed", error: status.execError, code };
        if (!status && code === HELPER_EXIT_USAGE && signal === null) return { kind: "helper_usage_error", code };
      }
      return { kind: "target", code, signal };
    },
  };
}

/**
 * Spawn a target under the isolation policy. In off mode this is exactly
 * `spawn(command, args, options)`. When the helper itself cannot be
 * started, the target is spawned directly instead: the helper never ran, so
 * no workload ran either.
 */
export function spawnIsolated(
  target: LaunchTarget,
  request: IsolationRequest,
  deps: LaunchDeps = {},
): { child: ChildProcess; launch: LaunchHandle } {
  const spawn = deps.spawn ?? nodeSpawn;
  if (request.policy.mode === "off") {
    return {
      child: spawn(target.command, [...(target.args ?? [])], target.options ?? {}),
      launch: makeHandle({ state: "off" }),
    };
  }

  const prepared = prepareInternal(target, request, deps);
  const ref = prepared.isolation.state === "off" ? null : prepared.isolation.record;
  let child: ChildProcess;
  try {
    child = spawn(prepared.command, prepared.args, prepared.options);
  } catch (error) {
    // Invalid spawn options throw the same way for an unwrapped spawn.
    if (ref) removeScopeRecord(ref);
    throw error;
  }
  if (prepared.isolation.state === "requested" && child.pid === undefined) {
    // spawn reports a failed helper start asynchronously; keep that error
    // from surfacing and run the target the ordinary way.
    child.on("error", () => {});
    const isolation =
      prepared.manifest && ref
        ? writePreflight(ref, prepared.manifest, "helper_spawn_failed")
        : ({ state: "degraded", reason: "helper_spawn_failed", unit: null, record: null } as const);
    const direct = spawn(target.command, [...(target.args ?? [])], target.options ?? {});
    recordSpawn(isolation.state === "degraded" ? isolation.record : null, prepared.manifest, direct);
    return { child: direct, launch: makeHandle(isolation) };
  }
  recordSpawn(ref, prepared.manifest, child);
  return { child, launch: makeHandle(prepared.isolation) };
}
