import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedAiSessionStateMounts } from "@paperclipai/adapter-utils/local-process-sandbox";
import { HEARTBEAT_RUN_SCRATCH_MARKER } from "../services/run-scratch.js";
import {
  MANAGED_AI_HOME_MARKER,
  RUNLESS_TEMP_DIR_MAX_AGE_MS,
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
  return { id: RUN, companyId: COMPANY, agentId: AGENT, status, processGroupId: 4242, ...overrides };
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
    const result = await removeRunTempDir({ dir: home, owner, processGroupId: 4242, isProcessGroupAlive: () => false, tmpRoot });
    expect(result).toEqual({ removed: true, dir: home });
    expect(await exists(home)).toBe(false);
  });

  it("keeps the home while the run's process group is alive", async () => {
    const home = await makeAiHome();
    const result = await removeRunTempDir({ dir: home, owner, processGroupId: 4242, isProcessGroupAlive: () => true, tmpRoot });
    expect(result).toMatchObject({ removed: false, reason: "process_group_alive" });
    expect(await exists(path.join(home, "provider", "auth.json"))).toBe(true);
  });

  it("keeps a home whose marker names another owner", async () => {
    const home = await makeAiHome({ ...owner, companyId: OTHER_COMPANY });
    const result = await removeRunTempDir({ dir: home, owner, isProcessGroupAlive: () => false, tmpRoot });
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
    expect(await linkManagedAiSessionState({ providerHome, stateDir })).toEqual(["projects", "sessions", "archived_sessions"]);
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

    expect(await removeRunTempDir({ dir: home, owner, isProcessGroupAlive: () => false, tmpRoot })).toMatchObject({ removed: true });
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
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run(status)]), isProcessGroupAlive: () => false, tmpRoot });
    expect(result.removed.sort()).toEqual([home, scratch].sort());
    expect(await exists(home)).toBe(false);
    expect(await exists(scratch)).toBe(false);
  });

  it.each(["queued", "running"])("keeps folders of a %s run", async (status) => {
    const home = await makeAiHome();
    const scratch = await makeScratch();
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run(status)]), isProcessGroupAlive: () => false, tmpRoot });
    expect(result.removed).toEqual([]);
    expect(result.kept).toEqual(expect.arrayContaining([{ dir: home, reason: "run_active" }, { dir: scratch, reason: "run_active" }]));
    expect(await exists(home)).toBe(true);
  });

  it("keeps folders of an ended run whose process group is alive", async () => {
    const home = await makeAiHome();
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run("failed")]), isProcessGroupAlive: (pg) => pg === 4242, tmpRoot });
    expect(result.kept).toEqual([{ dir: home, reason: "process_group_alive" }]);
    expect(await exists(home)).toBe(true);
  });

  it("keeps a folder when the run lookup does not prove the same company and agent", async () => {
    const otherCompany = await makeAiHome({ ...owner, companyId: OTHER_COMPANY });
    const result = await sweepRunTempDirs({ lookupRuns: lookup([run("succeeded")]), isProcessGroupAlive: () => false, tmpRoot });
    expect(result.kept).toEqual([{ dir: otherCompany, reason: "owner_mismatch" }]);

    const unknownRun = "55555555-5555-4555-8555-555555555555";
    const unknown = await makeAiHome({ ...owner, runId: unknownRun });
    const second = await sweepRunTempDirs({ lookupRuns: lookup([]), isProcessGroupAlive: () => false, tmpRoot });
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
