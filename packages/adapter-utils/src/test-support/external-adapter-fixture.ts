import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { runChildProcess } from "../server-utils.js";

/**
 * A conforming external adapter: it starts its provider only through the shared
 * launch API (runChildProcess), so the provider is in an agent process scope from
 * its first instruction and every descendant is stopped with it. It must stay free
 * of raw child_process use; the process-launch coverage gate scans this file.
 */
export async function executeConformingExternalAdapter(
  ctx: Pick<AdapterExecutionContext, "runId" | "config" | "onLog">,
): Promise<AdapterExecutionResult> {
  const command = String(ctx.config.command ?? "/bin/sh");
  const args = Array.isArray(ctx.config.args) ? ctx.config.args.map(String) : [];
  const result = await runChildProcess(ctx.runId, command, args, {
    cwd: String(ctx.config.cwd ?? process.cwd()),
    env: {},
    timeoutSec: Number(ctx.config.timeoutSec ?? 30),
    graceSec: Number(ctx.config.graceSec ?? 1),
    onLog: ctx.onLog,
  });
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  };
}
