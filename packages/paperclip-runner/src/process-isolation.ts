// Agent process scopes for native and direct launch roots (SX-2305 step 3).
//
// The server passes a `ProcessIsolationRequest` explicitly to each root it
// launches in its own process: the Rust runner, and the in-process Codex,
// OpenCode and verified ACPX providers. The request is a launcher the server
// built from its trusted policy and the root's owner; the runner package
// never sees the policy itself and has no dependency on the scope helper. It
// is an object option, never an environment variable, so no env sanitizer
// strips it and no provider sees it.
//
// Code that runs below a contained runner (the runnerd sidecars) receives no
// request: its children inherit the runner's scope, and a provider turn is
// stopped through its own process group, never by stopping the runner's
// shared scope.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export interface ProcessIsolationRequest {
  /**
   * Spawn this root in its own scope. Same contract as `spawn()`: the same
   * PID, process group, cwd, environment and descriptor numbers.
   */
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /**
   * Settles once a child from `spawn` exited and whatever it left in its scope
   * was stopped. A completion that reports the root's end waits for it, so
   * nothing the root started outlives that report. The outcome is recorded
   * once: every later call for the same child returns it, so an unconfirmed
   * cleanup stays unconfirmed. Never rejects.
   */
  readonly reaped?: (child: ChildProcess) => Promise<LaunchRootCleanup>;
}

/** Whether a root's scope was confirmed empty after the root exited. */
export type LaunchRootCleanup = { confirmed: true } | { confirmed: false; reason: string };

/** A stopped root whose scope cleanup was not confirmed: its files are not safe to collect. */
export class LaunchRootCleanupUnconfirmedError extends Error {
  readonly reason: string;
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`agent process scope cleanup was not confirmed (reason=${reason})`, options);
    this.name = "LaunchRootCleanupUnconfirmedError";
    this.reason = reason;
  }
}

/**
 * Spawn one launch root. Without a request this is exactly
 * `spawn(command, args, options)`.
 */
export function spawnLaunchRoot<T extends ChildProcess = ChildProcess>(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  request: ProcessIsolationRequest | undefined,
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess = nodeSpawn,
): T {
  return (request ? request.spawn(command, args, options) : spawn(command, args, options)) as T;
}

/**
 * Before a close reports a root as stopped: wait until its scope cleanup
 * finished, and throw when the root still runs or the cleanup was not
 * confirmed, so nothing collects files a leftover can still write. Without a
 * request (isolation off) this does nothing.
 *
 * Every place that stops a scoped root calls this, on its success path and on
 * its failure and retry paths, and shares one close promise between
 * concurrent and repeated callers.
 */
export async function confirmLaunchRootStopped(
  request: ProcessIsolationRequest | undefined,
  // A runner handle exposes only these fields of the child `spawn` returned.
  child: Pick<ChildProcess, "pid" | "exitCode"> & { signalCode?: ChildProcess["signalCode"] },
): Promise<void> {
  if (!request?.reaped) return;
  if (child.exitCode === null && (child.signalCode ?? null) === null && child.pid !== undefined) {
    throw new LaunchRootCleanupUnconfirmedError("root_still_running");
  }
  const cleanup = await request.reaped(child as ChildProcess);
  if (!cleanup.confirmed) throw new LaunchRootCleanupUnconfirmedError(cleanup.reason);
}
