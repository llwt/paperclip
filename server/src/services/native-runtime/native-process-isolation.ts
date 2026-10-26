// Launch roots of native sessions in their own agent process scope (SX-2305
// step 3). The policy is the server's own (`getAgentProcessIsolation()`, set
// once at startup). The runner package receives only the launcher built here,
// never the policy, and has no dependency on the scope helper.
//
// One `NativeLaunchRoots` belongs to one native run. Each root it launches
// reports its enrollment like a CLI adapter launch (a degraded line in the
// run log, the health tracker), and when a root exits, whatever it left in
// its scope is stopped. Each root's cleanup outcome is recorded once and kept
// for the run: `reaped(child)` returns it to every close, before and after
// `settle()`. `settle()` waits for the cleanups of exited roots, so the run
// does not return before them; a root that is still running (a retained
// runner or warm provider) is left to its own exit.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  formatProcessIsolationDegradedLine,
  getAgentProcessIsolation,
  RunIsolationTracker,
  type AgentProcessIsolationRuntime,
  type ProcessIsolationEvidence,
} from "@paperclipai/adapter-utils/server-utils";
import { isOpaqueId, spawnIsolated, terminateOwnedProcessTree, type TerminateResult } from "@paperclipai/process-launch";

export interface NativeLaunchRoot {
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
  /**
   * Settles once this child exited and its scope cleanup finished, saying
   * whether the scope was confirmed empty. Never rejects.
   */
  reaped(child: ChildProcess): Promise<NativeLaunchRootCleanup>;
}

export type NativeLaunchRootCleanup = { confirmed: true } | { confirmed: false; reason: string };
const CONFIRMED: NativeLaunchRootCleanup = { confirmed: true };
const UNKNOWN_ROOT: NativeLaunchRootCleanup = { confirmed: false, reason: "unknown_launch_root" };

/** What the run's launch roots did with isolation; null when nothing to report. */
export interface NativeLaunchRootsSummary {
  degraded: ProcessIsolationEvidence[];
  /** Set when a root's scope cleanup was not confirmed. */
  cleanupUnconfirmed: string | null;
}

export interface NativeLaunchRoots {
  /** The launcher for one root, or undefined (plain spawn) when isolation is off. */
  root(kind: "runner" | "warm_provider", ownerId: string): NativeLaunchRoot | undefined;
  settle(): Promise<NativeLaunchRootsSummary | null>;
}

export interface NativeLaunchRootsInput {
  companyId: string;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  /** Test seams; production uses the server's configured runtime and `spawn`. */
  runtime?: AgentProcessIsolationRuntime;
  spawn?: typeof nodeSpawn;
}

export function createNativeLaunchRoots(input: NativeLaunchRootsInput): NativeLaunchRoots {
  const { policy, health } = input.runtime ?? getAgentProcessIsolation();
  const plainSpawn = input.spawn ?? nodeSpawn;
  const cleanups = new Map<ChildProcess, Promise<NativeLaunchRootCleanup>>();
  const degraded: ProcessIsolationEvidence[] = [];
  let cleanupUnconfirmed: string | null = null;
  let reported = false;
  const log = (line: string) => input.onLog?.("stderr", line).catch(() => undefined);
  const onDegraded = (evidence: ProcessIsolationEvidence) => {
    degraded.push(evidence);
    void log(formatProcessIsolationDegradedLine(evidence));
  };

  // A root outside any scope (a degraded launch) has no leftovers to stop
  // there: its stop is its own exit, the degraded line already said why.
  const withoutScope = (child: ChildProcess): ChildProcess => {
    cleanups.set(child, new Promise<NativeLaunchRootCleanup>((resolve) => {
      child.once("exit", () => resolve(CONFIRMED));
      child.once("error", () => { if (child.pid === undefined) resolve(CONFIRMED); });
    }));
    return child;
  };

  return {
    root(kind, ownerId) {
      if (!policy || policy.mode !== "systemd") return undefined;
      return {
        spawn(command, args, options) {
          // Same fallbacks as a CLI adapter launch: the root still runs, once,
          // and the run log says why it is outside the slice.
          const plainReason = health && !health.shouldAttempt()
            ? health.currentFailure() ?? "unavailable"
            : !isOpaqueId(ownerId) || !isOpaqueId(input.companyId) ? "invalid_owner_id" : null;
          if (plainReason) {
            new RunIsolationTracker(policy, null, null, null, plainReason, onDegraded).start();
            return withoutScope(plainSpawn(command, [...args], options));
          }
          const { child, launch } = spawnIsolated(
            { command, args: [...args], options },
            { policy, owner: { kind, id: ownerId, companyId: input.companyId } },
            input.spawn ? { spawn: input.spawn } : undefined,
          );
          const isolation = launch.isolation;
          if (isolation.state === "off") return withoutScope(child);
          const tracker = new RunIsolationTracker(
            policy,
            health,
            isolation.state === "degraded" ? null : launch,
            isolation.unit,
            isolation.state === "degraded" ? isolation.reason : null,
            onDegraded,
          );
          tracker.start();
          const record = launch.record;
          cleanups.set(child, new Promise<NativeLaunchRootCleanup>((resolve) => {
            child.once("exit", (code, signal) => {
              // Read the status before the cleanup removes it.
              tracker.finish(code, signal);
              if (!record) return resolve(CONFIRMED);
              void terminateOwnedProcessTree(record, { instanceId: policy.instanceId })
                .catch((): TerminateResult => ({ outcome: "unconfirmed", containment: "none", signalled: 0, reason: "terminate_failed" }))
                .then((result) => {
                  if (result.outcome !== "terminated" && result.outcome !== "already_empty" && result.outcome !== "missing_record") {
                    const reason = result.reason ?? result.outcome;
                    cleanupUnconfirmed ??= reason;
                    return resolve({ confirmed: false, reason });
                  }
                  resolve(CONFIRMED);
                });
            });
            // A launch that failed before a process existed has nothing to clean.
            child.once("error", () => { if (child.pid === undefined) resolve(CONFIRMED); });
          }));
          return child;
        },
        reaped(child) {
          // The recorded outcome, as often as asked: an unconfirmed cleanup
          // stays unconfirmed for every later close. A child this launcher
          // did not start was never confirmed by it.
          return cleanups.get(child) ?? Promise.resolve(UNKNOWN_ROOT);
        },
      };
    },

    async settle() {
      // Outcomes are kept, never deleted here: a close after settlement still
      // reads the recorded result for its root.
      const exited = [...cleanups].filter(([child]) => child.exitCode !== null || child.signalCode !== null || child.pid === undefined);
      await Promise.all(exited.map(([, cleanup]) => cleanup));
      if (degraded.length === 0 && cleanupUnconfirmed === null) return null;
      if (cleanupUnconfirmed !== null && !reported) {
        reported = true;
        await log(`[paperclip] agent process scope cleanup was not confirmed (reason=${cleanupUnconfirmed}); processes may remain\n`);
      }
      return { degraded: [...degraded], cleanupUnconfirmed };
    },
  };
}
