import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  OFF_ISOLATION_POLICY,
  isOpaqueId,
  removeScopeRecord,
  spawnIsolated,
  terminateOwnedProcessTree,
  type AgentProcessIsolationPolicy,
  type IsolationHealth,
  type LaunchExit,
  type LaunchHandle,
  type ScopeRecordRef,
  type TerminateResult,
} from "@paperclipai/process-launch";

/**
 * The host-wide isolation policy. The server sets it once at startup from its
 * own trusted configuration. Adapters and provider configuration cannot pass
 * a policy to `runChildProcess`; they only ever see the effect of this one.
 */
export interface AgentProcessIsolationRuntime {
  readonly policy: AgentProcessIsolationPolicy;
  readonly health: IsolationHealth | null;
}

const RUNTIME_KEY = Symbol.for("paperclipai.adapter-utils.agentProcessIsolation");

type RuntimeHolder = { [RUNTIME_KEY]?: AgentProcessIsolationRuntime };

export function configureAgentProcessIsolation(runtime: AgentProcessIsolationRuntime): void {
  const holder = globalThis as RuntimeHolder;
  holder[RUNTIME_KEY]?.health?.stop();
  holder[RUNTIME_KEY] = Object.freeze({ policy: runtime.policy, health: runtime.health });
}

export function resetAgentProcessIsolation(): void {
  const holder = globalThis as RuntimeHolder;
  holder[RUNTIME_KEY]?.health?.stop();
  delete holder[RUNTIME_KEY];
}

export function getAgentProcessIsolation(): AgentProcessIsolationRuntime {
  return (globalThis as RuntimeHolder)[RUNTIME_KEY] ?? { policy: OFF_ISOLATION_POLICY, health: null };
}

/** What happened to isolation for one launch. Compact and free of provider data. */
export interface ProcessIsolationEvidence {
  mode: "systemd";
  state: "enrolled" | "degraded" | "unconfirmed";
  slice: string;
  unit: string | null;
  reason: string | null;
}

/** A launch whose process tree lives in its own scope and can be stopped as a unit. */
export interface OwnedScope {
  readonly ref: ScopeRecordRef;
  readonly instanceId: string;
  readonly slice: string;
  readonly unit: string;
  /** False once the helper reported that it could not enroll; the group kill applies then. */
  isScopeActive(): boolean;
}

export type ScopeTerminationOutcome = TerminateResult["outcome"] | "not_scoped";

export interface ScopeTermination {
  outcome: ScopeTerminationOutcome;
  reason?: string;
}

/** True when nothing owned remains, so no further kill is needed. */
export function scopeTerminationSettled(result: ScopeTermination): boolean {
  return (
    result.outcome === "terminated" || result.outcome === "already_empty" || result.outcome === "missing_record"
  );
}

export async function terminateOwnedScope(
  scope: OwnedScope,
  options: { graceMs?: number; signal?: NodeJS.Signals } = {},
): Promise<ScopeTermination> {
  if (!scope.isScopeActive()) return { outcome: "not_scoped" };
  try {
    return await terminateOwnedProcessTree(scope.ref, {
      instanceId: scope.instanceId,
      graceMs: options.graceMs,
      signal: options.signal,
    });
  } catch (error) {
    return { outcome: "unconfirmed", reason: error instanceof Error ? error.message : "terminate_failed" };
  }
}

/** Drop the private record of a launch that never got, or no longer needs, a scope. */
export function discardScopeRecord(scope: OwnedScope): void {
  try {
    removeScopeRecord(scope.ref);
  } catch {
    // A leftover record is harmless; recovery reconciles it.
  }
}

const ENROLLMENT_POLL_MS = 25;
const ENROLLMENT_WAIT_SLACK_MS = 1_000;

export function formatProcessIsolationDegradedLine(evidence: ProcessIsolationEvidence): string {
  return `[paperclip] agent process isolation degraded (reason=${evidence.reason ?? "unknown"}, slice=${evidence.slice}); normal execution used\n`;
}

/**
 * Follows one launch's enrollment: reports it to the health tracker, tells
 * the caller as soon as the launch is known to be degraded, and classifies
 * how the process ended. It only reads the helper's status file.
 */
export class RunIsolationTracker {
  private state: ProcessIsolationEvidence;
  private observed = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly policy: Extract<AgentProcessIsolationPolicy, { mode: "systemd" }>,
    private readonly health: IsolationHealth | null,
    private readonly launch: LaunchHandle | null,
    unit: string | null,
    degradedReason: string | null,
    private readonly onDegraded: (evidence: ProcessIsolationEvidence) => void,
  ) {
    this.state = {
      mode: "systemd",
      state: degradedReason ? "degraded" : "unconfirmed",
      slice: policy.slice,
      unit,
      reason: degradedReason,
    };
  }

  get evidence(): ProcessIsolationEvidence {
    return this.state;
  }

  /** Report a decision made before any workload started. Call once, right after spawn. */
  start(): void {
    if (this.state.state === "degraded") {
      this.observed = true;
      this.report();
      return;
    }
    if (!this.launch) return;
    const deadline = Date.now() + this.policy.enrollmentDeadlineMs + ENROLLMENT_WAIT_SLACK_MS;
    this.timer = setInterval(() => {
      if (this.poll() || Date.now() >= deadline) this.stopPolling();
    }, ENROLLMENT_POLL_MS);
    this.timer.unref?.();
  }

  stopPolling(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Final read after the process ended. */
  finish(code: number | null, signal: NodeJS.Signals | null): LaunchExit | null {
    this.stopPolling();
    this.poll();
    return this.launch ? this.launch.classifyExit(code, signal) : null;
  }

  private poll(): boolean {
    if (this.observed || !this.launch) return this.observed;
    const status = this.launch.readEnrollment();
    if (!status) return false;
    this.observed = true;
    if (status.outcome === "enrolled") {
      this.state = { ...this.state, state: "enrolled", reason: null, unit: status.unit };
    } else {
      this.state = { ...this.state, state: "degraded", reason: status.reason ?? "unknown", unit: status.unit };
    }
    this.report();
    return true;
  }

  private report(): void {
    if (this.state.state === "enrolled") {
      this.health?.observeLaunch({ enrolled: true });
      return;
    }
    if (this.state.state === "degraded") {
      this.health?.observeLaunch({ enrolled: false, reason: this.state.reason ?? "unknown" });
      this.onDegraded(this.state);
    }
  }
}

export interface RunProcessSpawn {
  child: ChildProcess;
  ownedScope: OwnedScope | null;
  tracker: RunIsolationTracker | null;
}

export interface SpawnRunProcessInput {
  runId: string;
  companyId: string | null | undefined;
  command: string;
  args: string[];
  options: SpawnOptions;
  onDegraded: (evidence: ProcessIsolationEvidence) => void;
}

/**
 * Spawn one run's child under the host isolation policy. With the policy off
 * this is exactly `spawn(command, args, options)`. When isolation cannot be
 * used, the same child runs without it and the tracker says why.
 */
export function spawnRunProcess(input: SpawnRunProcessInput): RunProcessSpawn {
  const { policy, health } = getAgentProcessIsolation();
  const plain = () => spawn(input.command, input.args, input.options);
  if (policy.mode === "off") return { child: plain(), ownedScope: null, tracker: null };

  if (health && !health.shouldAttempt()) {
    const reason = health.currentFailure() ?? "unavailable";
    const tracker = new RunIsolationTracker(policy, null, null, null, reason, input.onDegraded);
    return { child: plain(), ownedScope: null, tracker };
  }
  if (!isOpaqueId(input.runId)) {
    // Not a host fault, so it does not count against the health of isolation.
    const tracker = new RunIsolationTracker(policy, null, null, null, "invalid_owner_id", input.onDegraded);
    return { child: plain(), ownedScope: null, tracker };
  }
  const companyId = input.companyId && isOpaqueId(input.companyId) ? input.companyId : null;

  const { child, launch } = spawnIsolated(
    { command: input.command, args: input.args, options: input.options },
    { policy, owner: { kind: "run", id: input.runId, companyId } },
  );
  const isolation = launch.isolation;
  if (isolation.state === "off") return { child, ownedScope: null, tracker: null };

  const degraded = isolation.state === "degraded";
  const tracker = new RunIsolationTracker(
    policy,
    health,
    degraded ? null : launch,
    isolation.unit,
    degraded ? isolation.reason : null,
    input.onDegraded,
  );
  const ownedScope: OwnedScope | null = isolation.record
    ? {
        ref: isolation.record,
        instanceId: policy.instanceId,
        slice: policy.slice,
        unit: isolation.unit ?? isolation.record.unit,
        isScopeActive: () => !degraded && launch.readEnrollment()?.outcome !== "degraded",
      }
    : null;
  return { child, ownedScope, tracker };
}
