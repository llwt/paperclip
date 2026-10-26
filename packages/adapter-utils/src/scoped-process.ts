// Launch roots other than a run's own provider (tool commands, workspace and
// git helpers, ssh/tar clients, the output relay, AI helper programs, plugin
// workers) start their process through these functions (SX-2305 step 4).
//
// The policy is the server's own (`getAgentProcessIsolation()`); a caller only
// says who owns the process. With isolation off every function is exactly the
// Node call it replaces: same function, same arguments, same results.
import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithBufferEncoding,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  isOpaqueId,
  prepareIsolatedLaunch,
  readScopeStatus,
  recordSpawnedProcess,
  removeScopeRecord,
  terminateOwnedProcessTree,
  type ProcessOwnerKind,
} from "@paperclipai/process-launch";
import {
  getAgentProcessIsolation,
  scopeTerminationSettled,
  spawnRunProcess,
  terminateOwnedScope,
  type OwnedScope,
  type ProcessIsolationEvidence,
  type ScopeTermination,
} from "./process-isolation.js";

export type ScopedOwnerKind = Extract<ProcessOwnerKind, "run" | "managed_service" | "auxiliary" | "relay">;

export interface ScopedOwner {
  kind: ScopedOwnerKind;
  /** An opaque id such as a run id. A fresh one is made when the owner has none. */
  id?: string | null;
  companyId?: string | null;
}

export interface ScopedCleanup {
  /** False when the scope could not be confirmed empty; `reason` says why. */
  confirmed: boolean;
  reason?: string;
}

const CONFIRMED: ScopedCleanup = Object.freeze({ confirmed: true });

export interface ScopedSpawnInput {
  command: string;
  args?: readonly string[];
  options?: SpawnOptions;
  owner: ScopedOwner;
  /**
   * Stop what the child left in its scope when the child exits. On by
   * default; off for a service whose scope ends only when the service is
   * stopped.
   */
  reapOnExit?: boolean;
  /** Called at most once, when this launch ran outside a scope. */
  onDegraded?: (evidence: ProcessIsolationEvidence) => void;
}

export interface ScopedProcess {
  child: ChildProcess;
  /** The scope this launch lives in; null when isolation is off or this launch is not in one. */
  scope: OwnedScope | null;
  /** Settles once the child exited and its scope cleanup finished. Never rejects. */
  settled: Promise<ScopedCleanup>;
  /**
   * `child.kill(signal)`, but for a scoped child it signals every process in
   * the scope and escalates to SIGKILL after `graceMs`. Returns whether a
   * signal was sent.
   */
  kill(signal?: NodeJS.Signals, graceMs?: number): boolean;
  /** Stop the whole scope now. `not_scoped` when there is none to stop. */
  terminateScope(options?: { graceMs?: number; signal?: NodeJS.Signals }): Promise<ScopeTermination>;
}

function execFailedError(command: string, args: readonly string[], code: string | undefined): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`spawn ${command} ${code ?? "failed"}`);
  if (code) error.code = code;
  error.syscall = `spawn ${command}`;
  error.path = command;
  (error as { spawnargs?: string[] }).spawnargs = [...args];
  return error;
}

/**
 * Start `command` as `input.owner`'s process tree. The returned child is the
 * target itself (the scope helper replaces itself with it), so stdio, pid and
 * exit events are those of an unwrapped `spawn`. A target that could not be
 * executed is reported as an "error" event, like an unwrapped spawn does.
 */
export function spawnScoped(input: ScopedSpawnInput): ScopedProcess {
  const args = [...(input.args ?? [])];
  const options = input.options ?? {};
  const { policy } = getAgentProcessIsolation();
  if (policy.mode === "off") {
    const child = spawn(input.command, args, options);
    let settled: Promise<ScopedCleanup> | null = null;
    return {
      child,
      scope: null,
      // Listeners are attached on first use so an unwrapped launch adds none to the child.
      get settled() {
        return (settled ??= new Promise<ScopedCleanup>((resolve) => {
          if (typeof child.exitCode === "number" || typeof child.signalCode === "string") return resolve(CONFIRMED);
          child.once("exit", () => resolve(CONFIRMED));
          child.once("close", () => resolve(CONFIRMED));
          child.once("error", () => {
            if (child.pid === undefined) resolve(CONFIRMED);
          });
        }));
      },
      kill: (signal) => child.kill(signal),
      terminateScope: async () => ({ outcome: "not_scoped" }),
    };
  }

  const ownerId = input.owner.id && isOpaqueId(input.owner.id) ? input.owner.id : randomUUID();
  const { child, ownedScope, tracker } = spawnRunProcess({
    runId: ownerId,
    ownerKind: input.owner.kind,
    companyId: input.owner.companyId,
    command: input.command,
    args,
    options,
    onDegraded: (evidence) => input.onDegraded?.(evidence),
  });
  tracker?.start();
  const reap = input.reapOnExit !== false;

  const terminateScope: ScopedProcess["terminateScope"] = async (stopOptions = {}) => {
    if (!ownedScope) return { outcome: "not_scoped" };
    tracker?.observe();
    return terminateOwnedScope(ownedScope, stopOptions);
  };

  const settled = new Promise<ScopedCleanup>((resolve) => {
    child.once("error", () => {
      if (child.pid === undefined) resolve(CONFIRMED);
    });
    child.once("exit", (code, signal) => {
      const launchExit = tracker?.finish(code, signal) ?? null;
      if (child.listenerCount("error") > 0) {
        if (launchExit?.kind === "target_exec_failed") {
          child.emit("error", execFailedError(input.command, args, /^E[A-Z0-9]+$/.test(launchExit.error) ? launchExit.error : undefined));
        } else if (launchExit?.kind === "helper_usage_error") {
          child.emit("error", execFailedError(input.command, args, undefined));
        }
      }
      if (!ownedScope || !reap) return resolve(CONFIRMED);
      if (!ownedScope.isScopeActive()) {
        removeScopeRecord(ownedScope.ref);
        return resolve(CONFIRMED);
      }
      void terminateOwnedScope(ownedScope)
        .then((result): ScopedCleanup =>
          scopeTerminationSettled(result) ? CONFIRMED : { confirmed: false, reason: result.reason ?? result.outcome },
        )
        .then(resolve);
    });
  });

  return {
    child,
    scope: ownedScope,
    settled,
    kill(signal = "SIGTERM", graceMs = 5_000) {
      if (!ownedScope?.isScopeActive()) return child.kill(signal);
      void terminateScope({ signal, graceMs }).then((result) => {
        if (!scopeTerminationSettled(result)) child.kill("SIGKILL");
      });
      return true;
    },
    terminateScope,
  };
}

export type ScopedExecFileOptions = ExecFileOptions & { encoding?: BufferEncoding | "buffer" | null };

export interface ScopedExecFileResult<T extends string | Buffer = string> {
  stdout: T;
  stderr: T;
}

export interface ScopedExecFileError extends Error {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  cmd?: string;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

const DEFAULT_MAX_BUFFER = 1024 * 1024;

/**
 * `promisify(execFile)(file, args, options)` for `owner`'s process. Off mode
 * calls `execFile` itself. A scoped run is a spawn of the target with the same
 * buffering, timeout and error fields.
 */
export function execFileScoped(
  file: string,
  args: readonly string[],
  options: ScopedExecFileOptions,
  owner: ScopedOwner,
): Promise<ScopedExecFileResult<string | Buffer>> {
  if (getAgentProcessIsolation().policy.mode === "off") {
    return promisify(execFile)(file, [...args], options as ExecFileOptions) as Promise<ScopedExecFileResult<string | Buffer>>;
  }
  return bufferedScoped(file, args, options, owner, "ignore").result;
}

function bufferedScoped(
  file: string,
  args: readonly string[],
  options: ScopedExecFileOptions,
  owner: ScopedOwner,
  stdin: "ignore" | "pipe",
): { child: ChildProcess; result: Promise<ScopedExecFileResult<string | Buffer>> } {
  const { encoding, timeout, maxBuffer, killSignal, signal: abort, ...rest } = options;
  const spawnOptions: SpawnOptions = { ...(rest as SpawnOptions), stdio: [stdin, "pipe", "pipe"] };
  const asBuffer = encoding === "buffer" || encoding === null;
  const limit = typeof maxBuffer === "number" ? maxBuffer : DEFAULT_MAX_BUFFER;
  const scoped = spawnScoped({ command: file, args, options: spawnOptions, owner });
  const child = scoped.child;
  const result = new Promise<ScopedExecFileResult<string | Buffer>>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    let failure: ScopedExecFileError | null = null;
    let timer: NodeJS.Timeout | null = null;
    const cmd = [file, ...args].join(" ");
    const finish = (error: ScopedExecFileError | null, code?: number | null, signal?: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      abort?.removeEventListener("abort", onAbort);
      const stdout = asBuffer ? Buffer.concat(out) : Buffer.concat(out).toString((encoding as BufferEncoding) ?? "utf8");
      const stderr = asBuffer ? Buffer.concat(err) : Buffer.concat(err).toString((encoding as BufferEncoding) ?? "utf8");
      const problem =
        error ??
        failure ??
        (code !== 0 || signal
          ? Object.assign(new Error(`Command failed: ${cmd}\n${asBuffer ? stderr.toString() : stderr}`), {
              code: code ?? null,
            })
          : null);
      if (!problem) return resolve({ stdout, stderr });
      Object.assign(problem, { killed, signal: signal ?? null, cmd, stdout, stderr });
      reject(problem);
    };
    const stop = (error: ScopedExecFileError) => {
      failure ??= error;
      killed = true;
      scoped.kill(typeof killSignal === "string" ? killSignal : "SIGTERM");
    };
    const onAbort = () => {
      const error: ScopedExecFileError = new Error("The operation was aborted");
      error.name = "AbortError";
      error.code = "ABORT_ERR";
      stop(error);
    };
    if (abort) {
      if (abort.aborted) onAbort();
      else abort.addEventListener("abort", onAbort, { once: true });
    }
    if (typeof timeout === "number" && timeout > 0) timer = setTimeout(() => stop(new Error("Command timed out")), timeout);
    const collect = (sink: Buffer[], which: "out" | "err") => (chunk: Buffer) => {
      const bytes = which === "out" ? (outBytes += chunk.length) : (errBytes += chunk.length);
      if (bytes > limit) {
        const error: ScopedExecFileError = new RangeError(`${which === "out" ? "stdout" : "stderr"} maxBuffer length exceeded`);
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        stop(error);
        return;
      }
      sink.push(chunk);
    };
    child.stdout?.on("data", collect(out, "out"));
    child.stderr?.on("data", collect(err, "err"));
    child.once("error", (error: ScopedExecFileError) => finish(error));
    child.once("close", (code, signal) => finish(null, code, signal));
  });
  return { child, result };
}

/**
 * `execFile(file, args, options, callback)` for `owner`'s process: returns the
 * child (with piped stdin) and reports the buffered output to `callback`.
 */
export function execFileCallbackScoped(
  file: string,
  args: readonly string[],
  options: ScopedExecFileOptions,
  owner: ScopedOwner,
  callback: (error: ScopedExecFileError | null, stdout: string, stderr: string) => void,
): ChildProcess {
  if (getAgentProcessIsolation().policy.mode === "off") {
    return execFile(file, [...args], options as ExecFileOptions, callback as never);
  }
  const { child, result } = bufferedScoped(file, args, options, owner, "pipe");
  result.then(
    ({ stdout, stderr }) => callback(null, String(stdout), String(stderr)),
    (error: ScopedExecFileError) => callback(error, String(error.stdout ?? ""), String(error.stderr ?? "")),
  );
  return child;
}

/** `spawn` for a short-lived helper program (ssh and tar clients, git). */
export const spawnAuxiliary = ((command: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
  const args = Array.isArray(argsOrOptions) ? (argsOrOptions as string[]) : [];
  const options = (Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions) as SpawnOptions | undefined;
  return spawnScoped({ command, args, options, owner: { kind: "auxiliary" } }).child;
}) as typeof spawn;

/**
 * `spawnSync` for `owner`'s process. Off mode is `spawnSync` itself. A scoped
 * run waits for the target as usual; what it left behind is stopped afterwards
 * without waiting for it.
 */
export function spawnSyncScoped(
  command: string,
  args: readonly string[],
  options: SpawnOptions & { encoding?: BufferEncoding; input?: string | Buffer; timeout?: number; maxBuffer?: number },
  owner: ScopedOwner,
): SpawnSyncReturns<string | Buffer> {
  const { policy } = getAgentProcessIsolation();
  const plain = () => spawnSync(command, [...args], options as never) as SpawnSyncReturns<string | Buffer>;
  if (policy.mode === "off") return plain();

  const ownerId = owner.id && isOpaqueId(owner.id) ? owner.id : randomUUID();
  if (!isOpaqueId(ownerId) || (owner.companyId != null && !isOpaqueId(owner.companyId))) return plain();
  const prepared = prepareIsolatedLaunch(
    { command, args, options },
    { policy, owner: { kind: owner.kind, id: ownerId, companyId: owner.companyId ?? null } },
  );
  if (prepared.isolation.state !== "requested") return plain();
  const ref = prepared.isolation.record;
  const result = spawnSync(prepared.command, prepared.args, prepared.options as never) as SpawnSyncReturns<string | Buffer>;
  if (result.pid) recordSpawnedProcess(ref, result.pid);
  let status = null;
  try {
    status = readScopeStatus(ref);
  } catch {
    // An unreadable status is treated as no status.
  }
  if (result.error && result.pid === undefined) {
    // The helper itself did not start, so the target did not run either.
    removeScopeRecord(ref);
    return plain();
  }
  if (status?.execError) {
    const error = execFailedError(command, args, /^E[A-Z0-9]+$/.test(status.execError) ? status.execError : undefined);
    void terminateOwnedProcessTree(ref, { instanceId: policy.instanceId }).catch(() => undefined);
    return { ...result, error, status: null } as SpawnSyncReturns<string | Buffer>;
  }
  void terminateOwnedProcessTree(ref, { instanceId: policy.instanceId }).catch(() => undefined);
  return result;
}

/** `execFileScoped` for short-lived helper commands that read text output. */
export function execFileAuxiliary(
  file: string,
  args: readonly string[],
  options: Omit<ScopedExecFileOptions, "encoding"> & { encoding?: BufferEncoding } = {},
  owner: ScopedOwner = { kind: "auxiliary" },
): Promise<{ stdout: string; stderr: string }> {
  return execFileScoped(file, args, options, owner) as Promise<{ stdout: string; stderr: string }>;
}

export function execFileSyncAuxiliary(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSyncAuxiliary(
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptionsWithBufferEncoding,
): Buffer;
export function execFileSyncAuxiliary(
  file: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): string | Buffer;
export function execFileSyncAuxiliary(
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptions = {},
): string | Buffer {
  if (getAgentProcessIsolation().policy.mode === "off") return execFileSync(file, [...args], options);
  const result = spawnSyncScoped(
    file,
    args,
    { ...options, stdio: options.stdio ?? ["pipe", "pipe", "inherit"] } as never,
    { kind: "auxiliary" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `Command failed: ${[file, ...args].join(" ")}${result.stderr?.length ? `\n${result.stderr.toString()}` : ""}`,
    ) as Error & Record<string, unknown>;
    error.status = result.status;
    error.signal = result.signal;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout;
}
