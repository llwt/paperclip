// Scope ownership for the legacy embedded ACP provider (SX-2305 step 3).
//
// acpx calls `spawnAgent` in place of its own spawn(), so the provider joins
// its own transient scope before it runs any code. One scope per provider
// launch: a respawn inside the same runtime gets a new one. The owner is the
// provider (`warm_provider`), not the run that first started it; the run that
// currently uses it is kept in `currentRunId` and moves on warm reuse.
//
// Off mode never creates an owner, so acpx spawns exactly as before.

import { randomUUID } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  isOpaqueId,
  spawnIsolated,
  terminateOwnedProcessTree,
  type LaunchHandle,
  type ProcessOwner,
  type SystemdIsolationPolicy,
  type AgentProcessIsolationPolicy,
  type TerminateResult,
  type ScopeEnrollmentStatus,
} from "@paperclipai/process-launch";

export interface AcpxAgentLaunchInput {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

/** Grace between SIGTERM and SIGKILL when a provider exited and leftovers remain. */
const LEFTOVER_GRACE_MS = 5_000;

/** Outcome of the scope cleanup the run waited for; null when there was none. */
export type AcpxAgentScopeCleanup =
  | { outcome: "confirmed" }
  | { outcome: "unconfirmed"; reason: string };

export interface AcpxAgentScopeOwner {
  readonly owner: ProcessOwner;
  /** The run that currently uses this provider; moves on warm reuse. */
  currentRunId: string;
  /** The launch handle of the provider process that is running now, if any. */
  readonly current: LaunchHandle | null;
  /**
   * The launch that served the current run: the provider it reused, or the
   * first one started for it (acpx can start another one only to close).
   */
  readonly runLaunch: LaunchHandle | null;
  /**
   * The helper's status for `runLaunch`. Kept from the moment the provider
   * exited, since its scope cleanup removes the status file.
   */
  runEnrollment(): ScopeEnrollmentStatus | null;
  spawnAgent(input: AcpxAgentLaunchInput): ChildProcess;
  /** Hand the provider to another run (warm reuse). */
  associate(runId: string): void;
  /**
   * Forced stop of the running provider and everything in its scope, on behalf
   * of `runId`. A run that no longer owns the provider is refused, so a stale
   * run's cleanup cannot stop a provider another run reuses. Returns null
   * when there is nothing this call may stop; the caller keeps its own path.
   */
  forceStop(runId: string): Promise<TerminateResult> | null;
  /**
   * Wait for the cleanup of every provider launch that has exited, and report
   * it. With `waitForExitMs`, a provider that was just stopped is first given
   * that long to exit, so its scope cleanup starts and is awaited too. A
   * provider that keeps running (warm retention) is never touched. Null when
   * no cleanup ran since the last call.
   */
  reap(options?: { waitForExitMs?: number }): Promise<AcpxAgentScopeCleanup | null>;
  /** Settles when every scope this owner started has been cleaned up once. */
  idle(): Promise<void>;
}

export interface AcpxAgentScopeOwnerInput {
  policy: AgentProcessIsolationPolicy | null | undefined;
  /** `warm_provider` for the host lane, `run` for the per-run relay lane. */
  kind: "warm_provider" | "run";
  /** Required for `run`; a fresh opaque id is made for `warm_provider`. */
  ownerId?: string;
  companyId: string | null;
  runId: string;
  /** Test seams. */
  spawn?: Parameters<typeof spawnIsolated>[2];
  leftoverGraceMs?: number;
}

/**
 * Create the scope owner for one ACP runtime, or null in off mode (and when
 * the ids cannot name a scope, which then keeps the plain spawn).
 */
export function createAcpxAgentScopeOwner(input: AcpxAgentScopeOwnerInput): AcpxAgentScopeOwner | null {
  const policy = input.policy;
  if (!policy || policy.mode !== "systemd") return null;
  const ownerId = input.kind === "warm_provider" ? `acp-${randomUUID()}` : input.ownerId;
  if (!ownerId || !isOpaqueId(ownerId) || !isOpaqueId(input.runId)) return null;
  if (input.companyId != null && !isOpaqueId(input.companyId)) return null;
  return new ScopeOwner(policy, { kind: input.kind, id: ownerId, companyId: input.companyId }, input);
}

class ScopeOwner implements AcpxAgentScopeOwner {
  currentRunId: string;
  #current: { launch: LaunchHandle; child: ChildProcess } | null = null;
  #runLaunch: LaunchHandle | null = null;
  readonly #cleanups = new Set<Promise<TerminateResult>>();
  /** Cleanups that finished since the last `reap()`: whether any is unconfirmed. */
  #finished = 0;
  #unconfirmed: string | null = null;
  readonly #exitEnrollment = new WeakMap<LaunchHandle, ScopeEnrollmentStatus | null>();

  constructor(
    readonly policy: SystemdIsolationPolicy,
    readonly owner: ProcessOwner,
    private readonly input: AcpxAgentScopeOwnerInput,
  ) {
    this.currentRunId = input.runId;
  }

  get current(): LaunchHandle | null {
    return this.#current?.launch ?? null;
  }

  get runLaunch(): LaunchHandle | null {
    return this.#runLaunch;
  }

  spawnAgent({ command, args, options }: AcpxAgentLaunchInput): ChildProcess {
    const { child, launch } = spawnIsolated(
      { command, args: [...args], options },
      { policy: this.policy, owner: this.owner },
      this.input.spawn,
    );
    const entry = { launch, child };
    this.#current = entry;
    this.#runLaunch ??= launch;
    child.once("exit", () => {
      if (this.#current === entry) this.#current = null;
      this.#exitEnrollment.set(launch, launch.readEnrollment());
      // The provider is gone; whatever it left in its own scope (for example
      // a setsid grandchild) belongs to no one now. Only this launch's scope.
      if (launch.record) this.#track(this.#terminate(launch, "SIGTERM", this.input.leftoverGraceMs ?? LEFTOVER_GRACE_MS));
    });
    return child;
  }

  runEnrollment(): ScopeEnrollmentStatus | null {
    const launch = this.#runLaunch;
    if (!launch) return null;
    return this.#exitEnrollment.has(launch) ? this.#exitEnrollment.get(launch)! : launch.readEnrollment();
  }

  associate(runId: string): void {
    if (runId !== this.currentRunId) this.#runLaunch = this.#current?.launch ?? null;
    this.currentRunId = runId;
  }

  forceStop(runId: string): Promise<TerminateResult> | null {
    if (runId !== this.currentRunId) return null;
    const entry = this.#current;
    if (!entry?.launch.record) return null;
    const result = this.#terminate(entry.launch, "SIGKILL", 0);
    this.#track(result);
    return result;
  }

  async reap({ waitForExitMs = 0 }: { waitForExitMs?: number } = {}): Promise<AcpxAgentScopeCleanup | null> {
    const entry = this.#current;
    if (entry && waitForExitMs > 0 && entry.launch.record && !exited(entry.child)) {
      await waitForExit(entry.child, waitForExitMs);
      // Stopped but still running: its scope may still hold live processes.
      if (!exited(entry.child)) return { outcome: "unconfirmed", reason: "provider_still_running" };
    }
    await this.idle();
    if (this.#finished === 0) return null;
    const unconfirmed = this.#unconfirmed;
    this.#finished = 0;
    this.#unconfirmed = null;
    return unconfirmed === null ? { outcome: "confirmed" } : { outcome: "unconfirmed", reason: unconfirmed };
  }

  async idle(): Promise<void> {
    while (this.#cleanups.size > 0) await Promise.allSettled([...this.#cleanups]);
  }

  #terminate(launch: LaunchHandle, signal: NodeJS.Signals, graceMs: number): Promise<TerminateResult> {
    return terminateOwnedProcessTree(launch.record!, {
      instanceId: this.policy.instanceId,
      signal,
      graceMs,
    }).catch((): TerminateResult => ({ outcome: "unconfirmed", containment: "none", signalled: 0, reason: "terminate_failed" }));
  }

  #track(promise: Promise<TerminateResult>): void {
    this.#cleanups.add(promise);
    void promise.then((result) => {
      this.#finished += 1;
      if (!cleanupSettled(result)) this.#unconfirmed ??= result.reason ?? result.outcome;
    }).finally(() => this.#cleanups.delete(promise));
  }
}

function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeoutMs);
    function done() {
      clearTimeout(timer);
      child.off("exit", done);
      resolve();
    }
    child.once("exit", done);
  });
}

/** Nothing owned is left alive. */
function cleanupSettled(result: TerminateResult): boolean {
  return result.outcome === "terminated" || result.outcome === "already_empty" || result.outcome === "missing_record";
}

/** One compact log line for the run: how the current provider was placed. */
export function describeAcpxAgentScope(owner: AcpxAgentScopeOwner | null | undefined): string | null {
  const launch = owner?.runLaunch;
  if (!launch) return null;
  const isolation = launch.isolation;
  if (isolation.state === "degraded") return `degraded (${isolation.reason})`;
  if (isolation.state !== "requested") return null;
  const status = owner.runEnrollment();
  if (!status) return "pending";
  return status.outcome === "enrolled" ? `enrolled in ${status.unit}` : `degraded (${status.reason ?? "unknown"})`;
}
