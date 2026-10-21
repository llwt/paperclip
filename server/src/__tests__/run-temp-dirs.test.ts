import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { managedAiSessionStateMounts } from "@paperclipai/adapter-utils/local-process-sandbox";
import { HEARTBEAT_RUN_SCRATCH_MARKER } from "../services/run-scratch.js";
import { writeBackManagedAiCredential } from "../services/ai-connection-runtime.js";
import {
  MANAGED_AI_HOME_MARKER,
  MANAGED_AI_WRITEBACK_PENDING,
  RUNLESS_TEMP_DIR_MAX_AGE_MS,
  UNTRACKED_RUN_SWEEP_GRACE_MS,
  holdRunTempDirs,
  isRunProcessAlive,
  linkManagedAiSessionState,
  readRunTempDirMarker,
  removeRunTempDir,
  sweepRunTempDirs,
  writeRunTempDirMarker,
  type RunTempDirRunState,
} from "../services/run-temp-dirs.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
const owner = { companyId: COMPANY, agentId: AGENT, runId: RUN };

let root: string;
let tmpRoot: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "run-temp-dirs-test-"));
  tmpRoot = path.join(root, "tmp");
  await mkdir(tmpRoot);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(p: string) {
  return access(p).then(() => true, () => false);
}

async function makeAiHome(markerOwner: typeof owner | { companyId: string; agentId: string; runId: string | null } = owner, createdAt?: Date) {
  const home = await mkdtemp(path.join(tmpRoot, `paperclip-ai-${markerOwner.companyId}-grant-`));
  await writeRunTempDirMarker(home, markerOwner, createdAt);
  await mkdir(path.join(home, "provider"));
  await writeFile(path.join(home, "provider", "auth.json"), "{}");
  await mkdir(path.join(home, "data", "mise", "installs"), { recursive: true });
  return home;
}

async function makeScratch(runId = RUN) {
  const dir = await mkdtemp(path.join(tmpRoot, "paperclip-run-sx-1-run-"));
  await writeFile(
    path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
    JSON.stringify({ version: 1, companyId: COMPANY, agentId: AGENT, runId, issueId: null, issueIdentifier: "SX-1", createdAt: new Date().toISOString() }),
  );
  await writeFile(path.join(dir, "scratch.txt"), "x");
  return dir;
}

function lookup(runs: RunTempDirRunState[]) {
  return async (ids: string[]) => runs.filter((run) => ids.includes(run.id));
}

function run(status: string, overrides: Partial<RunTempDirRunState> = {}): RunTempDirRunState {
  return {
    id: RUN,
    companyId: COMPANY,
    agentId: AGENT,
    status,
    processPid: 4243,
    processGroupId: 4242,
    finishedAt: new Date("2026-10-21T10:00:00.000Z"),
    updatedAt: new Date("2026-10-21T10:00:00.000Z"),
    ...overrides,
  };
}

const dead = () => false;

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function markWriteBackPending(home: string, credential = "{}") {
  await writeFile(
    path.join(home, MANAGED_AI_WRITEBACK_PENDING),
    JSON.stringify({ version: 1, companyId: COMPANY, connectionId: "conn", grantId: "grant", provider: "openai", credentialSha256: sha256(credential) }),
  );
}

describe("run temp folder marker", () => {
  it("round-trips the owner of a managed AI home", async () => {
    const home = await makeAiHome();
    expect(await readRunTempDirMarker(home)).toMatchObject(owner);
    expect(await exists(path.join(home, MANAGED_AI_HOME_MARKER))).toBe(true);
  });
});

describe("removeRunTempDir at run end", () => {
  it("removes the home of a run that ended normally", async () => {
    const home = await makeAiHome();
    const result = await removeRunTempDir({ dir: home, owner, process: { processPid: null, processGroupId: 4242 }, isRunProcessAlive: dead, tmpRoot });
    expect(result).toEqual({ removed: true, dir: home });
    expect(await exists(home)).toBe(false);
  });

  it("keeps the home while the run's process group is alive", async () => {
    const home = await makeAiHome();
    const result = await removeRunTempDir({ dir: home, owner, process: { processPid: null, processGroupId: 4242 }, isRunProcessAlive: () => true, tmpRoot });
    expect(result).toMatchObject({ removed: false, reason: "process_alive" });
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);
  });

  it("keeps the home while the provider pid is alive and no process group was recorded", async () => {
    const home = await makeAiHome();
    // This test process stands in for a live provider (ACP reports a pid with no group).
    const result = await removeRunTempDir({ dir: home, owner, process: { processPid: process.pid, processGroupId: null }, isRunProcessAlive, tmpRoot });
    expect(result).toMatchObject({ removed: false, reason: "process_alive" });
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);
  });

  it("keeps the home while a credential write-back is pending and nothing can run it", async () => {
    const home = await makeAiHome();
    await markWriteBackPending(home);
    expect(await removeRunTempDir({ dir: home, owner, isRunProcessAlive: dead, tmpRoot })).toMatchObject({ removed: false, reason: "writeback_pending" });
    const failing = vi.fn(async () => { throw new Error("database unavailable"); });
    expect(await removeRunTempDir({ dir: home, owner, isRunProcessAlive: dead, writeBack: failing, tmpRoot })).toMatchObject({ removed: false, reason: "writeback_pending" });
    expect(failing).toHaveBeenCalledWith(home);
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);
  });

  it("keeps a home whose marker names another owner", async () => {
    const home = await makeAiHome({ ...owner, companyId: OTHER_COMPANY });
    const result = await removeRunTempDir({ dir: home, owner, isRunProcessAlive: dead, tmpRoot });
    expect(result).toMatchObject({ removed: false, reason: "owner_mismatch" });
    expect(await exists(home)).toBe(true);
  });

  it("keeps unmarked folders and folders outside the temp root", async () => {
    const unmarked = await mkdtemp(path.join(tmpRoot, "paperclip-ai-old-"));
    expect(await removeRunTempDir({ dir: unmarked, owner, tmpRoot })).toMatchObject({ removed: false, reason: "unmarked" });
    const elsewhere = await mkdtemp(path.join(root, "paperclip-ai-x-"));
    await writeRunTempDirMarker(elsewhere, owner);
    expect(await removeRunTempDir({ dir: elsewhere, owner, tmpRoot })).toMatchObject({ removed: false, reason: "unmarked" });
    expect(await exists(unmarked)).toBe(true);
    expect(await exists(elsewhere)).toBe(true);
  });
});

describe("session state survives removal of the home", () => {
  it("keeps Claude sessions and memory and Codex sessions in the per-agent folder", async () => {
    const home = await makeAiHome();
    const providerHome = path.join(home, "provider");
    const stateDir = path.join(root, "instance", "companies", COMPANY, "agents", AGENT, "ai-session-state");
    await linkManagedAiSessionState({ providerHome, stateDir });
    expect(await readlink(path.join(providerHome, "projects"))).toBe(path.join(stateDir, "projects"));

    // The provider writes through the links during the run.
    const project = path.join(providerHome, "projects", "-work-tree");
    await mkdir(path.join(project, "memory"), { recursive: true });
    await writeFile(path.join(project, "session-1.jsonl"), "{\"type\":\"user\"}\n");
    await writeFile(path.join(project, "memory", "MEMORY.md"), "- fact\n");
    await mkdir(path.join(providerHome, "sessions", "2026", "10", "21"), { recursive: true });
    await writeFile(path.join(providerHome, "sessions", "2026", "10", "21", "rollout-1.jsonl"), "{}\n");

    expect(await managedAiSessionStateMounts(providerHome)).toEqual([
      { path: path.join(stateDir, "projects"), access: "rw" },
      { path: path.join(stateDir, "sessions"), access: "rw" },
      { path: path.join(stateDir, "archived_sessions"), access: "rw" },
    ]);

    expect(await removeRunTempDir({ dir: home, owner, isRunProcessAlive: dead, tmpRoot })).toMatchObject({ removed: true });
    expect(await exists(home)).toBe(false);
    expect(await readFile(path.join(stateDir, "projects", "-work-tree", "session-1.jsonl"), "utf8")).toContain("user");
    expect(await readFile(path.join(stateDir, "projects", "-work-tree", "memory", "MEMORY.md"), "utf8")).toBe("- fact\n");
    expect(await exists(path.join(stateDir, "sessions", "2026", "10", "21", "rollout-1.jsonl"))).toBe(true);
    // Credentials never leave the temp home.
    expect(await exists(path.join(stateDir, "auth.json"))).toBe(false);

    // The next run's home links the same folder and sees the session.
    const next = await makeAiHome();
    await linkManagedAiSessionState({ providerHome: path.join(next, "provider"), stateDir });
    expect(await exists(path.join(next, "provider", "projects", "-work-tree", "session-1.jsonl"))).toBe(true);
  });
});

describe("sweepRunTempDirs", () => {
  it.each(["succeeded", "failed", "cancelled", "timed_out", "interrupted"])("removes folders of a %s run", async (status) => {
    const home = await makeAiHome();
    const scratch = await makeScratch();
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run(status)]), isRunProcessAlive: dead, tmpRoot });
    expect(result.removed.sort()).toEqual([home, scratch].sort());
    expect(await exists(home)).toBe(false);
    expect(await exists(scratch)).toBe(false);
  });

  it.each(["queued", "running"])("keeps folders of a %s run", async (status) => {
    const home = await makeAiHome();
    const scratch = await makeScratch();
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run(status)]), isRunProcessAlive: dead, tmpRoot });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(expect.arrayContaining([{ dir: home, reason: "run_active" }, { dir: scratch, reason: "run_active" }]));
    expect(await exists(home)).toBe(true);
  });

  it("keeps folders of an ended run whose process group is alive", async () => {
    const home = await makeAiHome();
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run("failed")]), isRunProcessAlive: (p) => p.processGroupId === 4242, tmpRoot });
    expect(result.kept).toEqual([{ dir: home, reason: "process_alive" }]);
    expect(await exists(home)).toBe(true);
  });

  it.each(["failed", "cancelled"])("keeps folders of a %s run whose provider pid is alive with no process group", async (status) => {
    const home = await makeAiHome();
    const scratch = await makeScratch();
    const result = await sweepRunTempDirs({
      lookupRuns: lookup([run(status, { processPid: process.pid, processGroupId: null })]),
      isRunProcessAlive,
      tmpRoot,
    });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(expect.arrayContaining([{ dir: home, reason: "process_alive" }, { dir: scratch, reason: "process_alive" }]));
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);
  });

  it("waits a grace period before removing folders of a run that recorded no process", async () => {
    const finishedAt = new Date("2026-10-21T10:00:00.000Z");
    const home = await makeAiHome();
    const untracked = run("failed", { processPid: null, processGroupId: null, finishedAt });
    const early = await sweepRunTempDirs({ lookupRuns: lookup([untracked]), isRunProcessAlive: dead, tmpRoot, now: new Date(finishedAt.getTime() + 60_000) });
    expect(early.kept).toEqual([{ dir: home, reason: "untracked_process_recent" }]);
    const late = await sweepRunTempDirs({ lookupRuns: lookup([untracked]), isRunProcessAlive: dead, tmpRoot, now: new Date(finishedAt.getTime() + UNTRACKED_RUN_SWEEP_GRACE_MS + 1) });
    expect(late.removed).toEqual([home]);
  });

  it("keeps a folder when the run lookup does not prove the same company and agent", async () => {
    const otherCompany = await makeAiHome({ ...owner, companyId: OTHER_COMPANY });
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run("succeeded")]), isRunProcessAlive: dead, tmpRoot });
    expect(result.kept).toEqual([{ dir: otherCompany, reason: "owner_mismatch" }]);

    const unknownRun = "55555555-5555-4555-8555-555555555555";
    const unknown = await makeAiHome({ ...owner, runId: unknownRun });
    const second = await sweepRunTempDirs({ lookupRuns: lookup([]), isRunProcessAlive: dead, tmpRoot });
    expect(second.kept).toEqual(expect.arrayContaining([{ dir: unknown, reason: "run_unknown" }]));
    expect(await exists(otherCompany)).toBe(true);
    expect(await exists(unknown)).toBe(true);
  });

  it("leaves unmarked folders and unrelated temp entries alone", async () => {
    const unmarked = await mkdtemp(path.join(tmpRoot, "paperclip-run-db-"));
    const unrelated = await mkdtemp(path.join(tmpRoot, "other-"));
    const result = await sweepRunTempDirs({ lookupRuns: lookup([]), tmpRoot });
    expect(result).toEqual({ scanned: 1, removed: [], kept: [{ dir: unmarked, reason: "unmarked" }] });
    expect(await exists(unrelated)).toBe(true);
  });

  it("removes a home made outside a run only after a day", async () => {
    const created = new Date("2026-10-20T00:00:00.000Z");
    const home = await makeAiHome({ ...owner, runId: null }, created);
    const early = await sweepRunTempDirs({ lookupRuns: lookup([]), tmpRoot, now: new Date(created.getTime() + 60_000) });
    expect(early.kept).toEqual([{ dir: home, reason: "runless_recent" }]);
    const late = await sweepRunTempDirs({ lookupRuns: lookup([]), tmpRoot, now: new Date(created.getTime() + RUNLESS_TEMP_DIR_MAX_AGE_MS + 1) });
    expect(late.removed).toEqual([home]);
  });
});

describe("run teardown and the sweep", () => {
  it("does not remove a home while its run's teardown still has to write back the credential", async () => {
    // The run is terminal and its provider has exited, but teardown has not
    // reached the credential write-back yet.
    const home = await makeAiHome();
    await writeFile(path.join(home, "provider", "auth.json"), "refreshed");
    await markWriteBackPending(home, "original");
    const release = holdRunTempDirs(RUN);
    let pendingWriteBack!: () => void;
    const teardownPaused = new Promise<void>((resolve) => { pendingWriteBack = resolve; });
    const savedCredentials: string[] = [];
    const teardown = (async () => {
      try {
        await teardownPaused;
        savedCredentials.push(await readFile(path.join(home, "provider", "auth.json"), "utf8"));
        await rm(path.join(home, MANAGED_AI_WRITEBACK_PENDING));
        return await removeRunTempDir({ dir: home, owner, process: { processPid: null, processGroupId: 4242 }, isRunProcessAlive: dead, tmpRoot });
      } finally {
        release();
      }
    })();

    const swept = await sweepRunTempDirs({ lookupRuns: lookup([run("succeeded")]), isRunProcessAlive: dead, tmpRoot });
    expect(swept.kept).toEqual([{ dir: home, reason: "teardown_active" }]);
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);

    pendingWriteBack();
    expect(await teardown).toMatchObject({ removed: true });
    expect(savedCredentials).toEqual(["refreshed"]);
    expect(await exists(home)).toBe(false);
  });

  it("runs a write-back left pending by a crashed server before removing the home", async () => {
    const home = await makeAiHome();
    await writeFile(path.join(home, "provider", "auth.json"), "refreshed");
    await markWriteBackPending(home, "original");

    const withoutWriteBack = await sweepRunTempDirs({ lookupRuns: lookup([run("interrupted")]), isRunProcessAlive: dead, tmpRoot });
    expect(withoutWriteBack.kept).toEqual([{ dir: home, reason: "writeback_pending" }]);

    const failed = await sweepRunTempDirs({
      lookupRuns: lookup([run("interrupted")]),
      isRunProcessAlive: dead,
      writeBack: async () => { throw new Error("database unavailable"); },
      tmpRoot,
    });
    expect(failed.kept).toEqual([{ dir: home, reason: "writeback_pending" }]);
    expect(await readFile(path.join(home, "provider", "auth.json"), "utf8")).toBe("refreshed");

    const saved: string[] = [];
    const recovered = await sweepRunTempDirs({
      lookupRuns: lookup([run("interrupted")]),
      isRunProcessAlive: dead,
      writeBack: async (dir) => {
        saved.push(await readFile(path.join(dir, "provider", "auth.json"), "utf8"));
        await rm(path.join(dir, MANAGED_AI_WRITEBACK_PENDING));
      },
      tmpRoot,
    });
    expect(saved).toEqual(["refreshed"]);
    expect(recovered.removed).toEqual([home]);
  });
});

describe("writeBackManagedAiCredential", () => {
  const noDb = { transaction: vi.fn(async () => { throw new Error("database unavailable"); }) } as unknown as Db;

  it("drops the pending record without a database call when the credential did not change", async () => {
    const home = await makeAiHome();
    await writeFile(path.join(home, "provider", "auth.json"), "original");
    await markWriteBackPending(home, "original");
    await writeBackManagedAiCredential(noDb, home);
    expect(noDb.transaction).not.toHaveBeenCalled();
    expect(await exists(path.join(home, MANAGED_AI_WRITEBACK_PENDING))).toBe(false);
  });

  it("keeps the pending record when the refreshed credential could not be saved", async () => {
    const home = await makeAiHome();
    await writeFile(path.join(home, "provider", "auth.json"), "refreshed");
    await markWriteBackPending(home, "original");
    await expect(writeBackManagedAiCredential(noDb, home)).rejects.toThrow("database unavailable");
    expect(await exists(path.join(home, MANAGED_AI_WRITEBACK_PENDING))).toBe(true);
    expect(await removeRunTempDir({ dir: home, owner, isRunProcessAlive: dead, writeBack: (dir) => writeBackManagedAiCredential(noDb, dir), tmpRoot }))
      .toMatchObject({ removed: false, reason: "writeback_pending" });
    expect(await readFile(path.join(home, "provider", "auth.json"), "utf8")).toBe("refreshed");
  });

  it("does nothing for a home without a pending record", async () => {
    const home = await makeAiHome();
    await writeBackManagedAiCredential(noDb, home);
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);
  });
});

describe("linkManagedAiSessionState", () => {
  function stateDirFor() {
    return path.join(root, "instance", "companies", COMPANY, "agents", AGENT, "ai-session-state");
  }

  it("replaces an empty folder with the link and accepts an existing correct link", async () => {
    const home = await makeAiHome();
    const providerHome = path.join(home, "provider");
    const stateDir = stateDirFor();
    await mkdir(path.join(providerHome, "projects"));
    await linkManagedAiSessionState({ providerHome, stateDir });
    expect(await readlink(path.join(providerHome, "projects"))).toBe(path.join(stateDir, "projects"));
    await expect(linkManagedAiSessionState({ providerHome, stateDir })).resolves.toBeUndefined();
  });

  it("fails on an existing folder with content and leaves that content in place", async () => {
    const home = await makeAiHome();
    const providerHome = path.join(home, "provider");
    await mkdir(path.join(providerHome, "projects", "-work-tree"), { recursive: true });
    await writeFile(path.join(providerHome, "projects", "-work-tree", "session-0.jsonl"), "{}\n");
    await expect(linkManagedAiSessionState({ providerHome, stateDir: stateDirFor() })).rejects.toThrow("is not a link");
    expect(await exists(path.join(providerHome, "projects", "-work-tree", "session-0.jsonl"))).toBe(true);
  });

  it("fails on a link that points somewhere else", async () => {
    const home = await makeAiHome();
    const providerHome = path.join(home, "provider");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(providerHome, "projects"), "dir");
    await expect(linkManagedAiSessionState({ providerHome, stateDir: stateDirFor() })).rejects.toThrow("is not a link");
  });

  it("fails when the durable folder cannot be made", async () => {
    const home = await makeAiHome();
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "");
    await expect(linkManagedAiSessionState({ providerHome: path.join(home, "provider"), stateDir: path.join(blocker, "ai-session-state") }))
      .rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
