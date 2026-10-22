import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inArray } from "drizzle-orm";
import { type Db, heartbeatRuns } from "@paperclipai/db";
import { MANAGED_AI_SESSION_STATE_ENTRIES } from "@paperclipai/adapter-utils/local-process-sandbox";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { HEARTBEAT_RUN_SCRATCH_MARKER } from "./run-scratch.js";
import { isPidAlive, isProcessGroupAlive } from "./local-service-supervisor.js";

/**
 * Run temp folders in the OS temp directory: the managed AI home
 * (`paperclip-ai-*`, the run's HOME, CLAUDE_CONFIG_DIR and CODEX_HOME) and the
 * run scratch folder (`paperclip-run-*`). Each carries an ownership marker so a
 * later sweep can match it to its run after a server restart.
 */
export const MANAGED_AI_HOME_PREFIX = "paperclip-ai-";
export const MANAGED_AI_HOME_MARKER = ".paperclip-ai-home.json";
export const RUN_SCRATCH_PREFIX = "paperclip-run-";
/**
 * Present in a managed AI home while a refreshed credential may still need to
 * be saved back to its secret. A home with this record is never removed until
 * the write-back has run.
 */
export const MANAGED_AI_WRITEBACK_PENDING = ".paperclip-ai-writeback.json";

const RUN_TEMP_DIR_KINDS = [
  { prefix: MANAGED_AI_HOME_PREFIX, marker: MANAGED_AI_HOME_MARKER },
  { prefix: RUN_SCRATCH_PREFIX, marker: HEARTBEAT_RUN_SCRATCH_MARKER },
] as const;

/** A home made outside a run (adapter test routes) is swept after this age. */
export const RUNLESS_TEMP_DIR_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * A run that recorded no process id and no process group is swept only this
 * long after it ended, since nothing else shows its provider has stopped.
 */
export const UNTRACKED_RUN_SWEEP_GRACE_MS = 30 * 60 * 1000;
const REMOVE_ATTEMPTS = 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RunTempDirOwner {
  companyId: string;
  agentId: string;
  runId: string | null;
}

export interface RunTempDirMarker extends RunTempDirOwner {
  createdAt: string;
}

export type RunTempDirRemoveResult =
  | { removed: true; dir: string }
  | {
      removed: false;
      dir: string;
      reason: "missing" | "unmarked" | "owner_mismatch" | "process_alive" | "writeback_pending" | "busy";
    };

/** The provider process of a run, as recorded on the run row. */
export interface RunTempDirProcess {
  processPid: number | null;
  processGroupId: number | null;
}

export type IsRunProcessAlive = (process: RunTempDirProcess) => boolean;

/** A run's provider counts as alive while its process id or its process group is. */
export const isRunProcessAlive: IsRunProcessAlive = (process) =>
  (process.processPid !== null && isPidAlive(process.processPid)) || isProcessGroupAlive(process.processGroupId);

/**
 * Runs whose own teardown is still in progress in this server process. The
 * sweep leaves their folders alone, so it cannot remove a home between the
 * run turning terminal and its credential write-back.
 */
const heldRunTempDirRuns = new Map<string, number>();

export function holdRunTempDirs(runId: string): () => void {
  heldRunTempDirRuns.set(runId, (heldRunTempDirRuns.get(runId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = (heldRunTempDirRuns.get(runId) ?? 1) - 1;
    if (count <= 0) heldRunTempDirRuns.delete(runId);
    else heldRunTempDirRuns.set(runId, count);
  };
}

export function isRunTempDirHeld(runId: string): boolean {
  return heldRunTempDirRuns.has(runId);
}

function kindForDir(dir: string) {
  const base = path.basename(dir);
  return RUN_TEMP_DIR_KINDS.find((kind) => base.startsWith(kind.prefix)) ?? null;
}

export async function writeRunTempDirMarker(
  dir: string,
  owner: RunTempDirOwner,
  now = new Date(),
): Promise<void> {
  const kind = kindForDir(dir);
  if (!kind) throw new Error(`Not a run temp folder: ${dir}`);
  const marker = { version: 1, ...owner, createdAt: now.toISOString() };
  await fs.writeFile(path.join(dir, kind.marker), `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
}

export async function readRunTempDirMarker(dir: string): Promise<RunTempDirMarker | null> {
  const kind = kindForDir(dir);
  if (!kind) return null;
  try {
    const rec = JSON.parse(await fs.readFile(path.join(dir, kind.marker), "utf8")) as Record<string, unknown>;
    if (
      !rec || typeof rec !== "object" || Array.isArray(rec) ||
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      (typeof rec.runId !== "string" && rec.runId !== null) ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return { companyId: rec.companyId, agentId: rec.agentId, runId: rec.runId as string | null, createdAt: rec.createdAt };
  } catch {
    return null;
  }
}

/**
 * Remove a marked run temp folder. The marker goes last, so a folder that a
 * stray process keeps writing to stays marked and a later sweep retries it.
 * A pending credential write-back runs first through `writeBack`; without it,
 * or when it fails, the folder is kept.
 */
export async function removeRunTempDir(input: {
  dir: string;
  owner: RunTempDirOwner;
  process?: RunTempDirProcess | null;
  isRunProcessAlive?: IsRunProcessAlive;
  writeBack?: (dir: string) => Promise<void>;
  tmpRoot?: string;
}): Promise<RunTempDirRemoveResult> {
  const tmpRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const dir = path.resolve(input.dir);
  const kind = kindForDir(dir);
  if (!kind || path.dirname(dir) !== tmpRoot) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }
  const marker = await readRunTempDirMarker(dir);
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  const markerPath = path.join(dir, kind.marker);
  const markerBytes = await fs.readFile(markerPath);
  if (
    marker.companyId !== input.owner.companyId ||
    marker.agentId !== input.owner.agentId ||
    marker.runId !== input.owner.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.process && input.isRunProcessAlive?.(input.process) === true) {
    return { removed: false, dir, reason: "process_alive" };
  }
  if (await pathExists(path.join(dir, MANAGED_AI_WRITEBACK_PENDING))) {
    if (!input.writeBack) return { removed: false, dir, reason: "writeback_pending" };
    try {
      await input.writeBack(dir);
    } catch {
      return { removed: false, dir, reason: "writeback_pending" };
    }
    if (await pathExists(path.join(dir, MANAGED_AI_WRITEBACK_PENDING))) {
      return { removed: false, dir, reason: "writeback_pending" };
    }
  }

  for (let attempt = 0; attempt < REMOVE_ATTEMPTS; attempt += 1) {
    const entries = (await fs.readdir(dir)).filter((name) => name !== kind.marker);
    if (entries.length === 0) {
      await fs.rm(markerPath, { force: true });
      try {
        await fs.rmdir(dir);
        return { removed: true, dir };
      } catch (error) {
        // A writer added an entry after the marker went; nothing marks it now,
        // so restore the marker before giving up on this attempt.
        if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await fs.writeFile(markerPath, markerBytes, { mode: 0o600 });
        continue;
      }
    }
    // fs.rm does not follow symlinks, so linked session state outside the folder stays.
    await Promise.all(entries.map((name) => fs.rm(path.join(dir, name), { recursive: true, force: true })));
  }
  return { removed: false, dir, reason: "busy" };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Durable per-agent session state (Claude projects and memory, Codex sessions), outside the OS temp directory. */
export function resolveManagedAiSessionStateDir(companyId: string, agentId: string): string {
  for (const id of [companyId, agentId]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid id for session state path '${id}'.`);
  }
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", companyId, "agents", agentId, "ai-session-state");
}

/**
 * Point the session-state entries of a managed provider home at the durable
 * per-agent folder, so removing the run's temp home keeps what `--resume` and
 * agent memory read. Credentials stay in the temp home.
 *
 * Throws unless every entry ends up as a link to its durable folder, so the
 * caller can stop before the provider starts writing sessions into the temp
 * home. An existing empty folder is replaced by the link; anything else that
 * is already there (a folder with content, a file, a link elsewhere) is left
 * as is and fails the call.
 */
export async function linkManagedAiSessionState(input: {
  providerHome: string;
  stateDir: string;
}): Promise<void> {
  await fs.mkdir(input.stateDir, { recursive: true, mode: 0o700 });
  for (const name of MANAGED_AI_SESSION_STATE_ENTRIES) {
    const target = path.join(input.stateDir, name);
    const link = path.join(input.providerHome, name);
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    let existing: Stats | null = null;
    try {
      existing = await fs.lstat(link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing?.isDirectory() && (await fs.readdir(link)).length === 0) {
      await fs.rmdir(link);
      existing = null;
    }
    if (!existing) await fs.symlink(target, link, "dir");
    const stats = await fs.lstat(link);
    if (!stats.isSymbolicLink() || path.resolve(input.providerHome, await fs.readlink(link)) !== target) {
      throw new Error(`Session state entry '${name}' in ${input.providerHome} is not a link to ${target}`);
    }
  }
}

export interface RunTempDirRunState {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  processPid: number | null;
  processGroupId: number | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

export interface RunTempDirSweepResult {
  scanned: number;
  removed: string[];
  kept: Array<{ dir: string; reason: string }>;
}

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);

/**
 * Remove run temp folders left by runs that ended without cleanup (a server
 * crash or restart mid-run, a cleanup skipped while the process group was
 * alive). A folder goes only when its marker names a run that the run lookup
 * shows as ended, for the same company and agent, with no live process id or
 * process group, and whose teardown is not running in this server. A pending
 * credential write-back runs through `writeBack` before removal.
 */
export async function sweepRunTempDirs(input: {
  lookupRuns: (runIds: string[]) => Promise<RunTempDirRunState[]>;
  isRunProcessAlive?: IsRunProcessAlive;
  writeBack?: (dir: string) => Promise<void>;
  tmpRoot?: string;
  now?: Date;
}): Promise<RunTempDirSweepResult> {
  const tmpRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const now = input.now ?? new Date();
  const result: RunTempDirSweepResult = { scanned: 0, removed: [], kept: [] };
  const candidates: Array<{ dir: string; marker: RunTempDirMarker }> = [];
  for (const entry of await fs.readdir(tmpRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !kindForDir(entry.name)) continue;
    const dir = path.join(tmpRoot, entry.name);
    result.scanned += 1;
    const marker = await readRunTempDirMarker(dir);
    if (!marker) {
      result.kept.push({ dir, reason: "unmarked" });
      continue;
    }
    candidates.push({ dir, marker });
  }

  const runIds = [...new Set(candidates.map((c) => c.marker.runId).filter((id): id is string => !!id && UUID_RE.test(id)))];
  const runs = new Map((runIds.length > 0 ? await input.lookupRuns(runIds) : []).map((run) => [run.id, run]));

  for (const { dir, marker } of candidates) {
    let runProcess: RunTempDirProcess | null = null;
    if (marker.runId === null) {
      const createdAt = Date.parse(marker.createdAt);
      if (!Number.isFinite(createdAt) || now.getTime() - createdAt < RUNLESS_TEMP_DIR_MAX_AGE_MS) {
        result.kept.push({ dir, reason: "runless_recent" });
        continue;
      }
    } else {
      const run = runs.get(marker.runId);
      if (!run) {
        result.kept.push({ dir, reason: "run_unknown" });
        continue;
      }
      if (run.companyId !== marker.companyId || run.agentId !== marker.agentId) {
        result.kept.push({ dir, reason: "owner_mismatch" });
        continue;
      }
      if (!TERMINAL_RUN_STATUSES.has(run.status)) {
        result.kept.push({ dir, reason: "run_active" });
        continue;
      }
      if (isRunTempDirHeld(run.id)) {
        result.kept.push({ dir, reason: "teardown_active" });
        continue;
      }
      if (run.processPid === null && run.processGroupId === null) {
        const endedAt = (run.finishedAt ?? run.updatedAt).getTime();
        if (now.getTime() - endedAt < UNTRACKED_RUN_SWEEP_GRACE_MS) {
          result.kept.push({ dir, reason: "untracked_process_recent" });
          continue;
        }
      }
      runProcess = { processPid: run.processPid, processGroupId: run.processGroupId };
    }
    try {
      const removal = await removeRunTempDir({
        dir,
        owner: marker,
        process: runProcess,
        isRunProcessAlive: input.isRunProcessAlive,
        writeBack: input.writeBack,
        tmpRoot,
      });
      if (removal.removed) result.removed.push(dir);
      else result.kept.push({ dir, reason: removal.reason });
    } catch (error) {
      result.kept.push({ dir, reason: `error: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return result;
}

export function heartbeatRunTempDirLookup(db: Db) {
  return async (runIds: string[]): Promise<RunTempDirRunState[]> =>
    db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        processPid: heartbeatRuns.processPid,
        processGroupId: heartbeatRuns.processGroupId,
        finishedAt: heartbeatRuns.finishedAt,
        updatedAt: heartbeatRuns.updatedAt,
      })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
}
