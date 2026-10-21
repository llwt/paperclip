import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, executionWorkspaces, issues, projects, projectWorkspaces } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const execute = vi.hoisted(() => vi.fn(async (_input: any) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("shared project_primary workspace rebind", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-rebind-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_MULTI_PROJECT_WORKSPACE_SYNC", "false");
    database = await startEmbeddedPostgresTestDatabase("shared-workspace-rebind");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
    // The issue keeps its execution workspace binding only with isolated
    // workspaces enabled, as on instances that hit the stale `_default` cwd.
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    execute.mockImplementation(async (input) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, input.context.issueId));
      return { exitCode: 0, signal: null, timedOut: false };
    });
  }, 30_000);
  afterAll(async () => {
    if (db && heartbeat) await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }, 60_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
  });

  async function createGitRepo(dir: string) {
    await mkdir(dir, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-b", "main");
    await writeFile(path.join(dir, "README.md"), "project repository\n");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "seed");
  }

  async function seedTask() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Rebind", issuePrefix: `B${companyId.slice(0, 6)}`, defaultResponsibleUserId: "responsible-user" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Automation Platform", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Engineer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: "sk-test" } }, runtimeConfig: {}, permissions: {} });
    // An inherited shared workspace binding: reuse_existing makes every later
    // run restore the execution workspace the first run bound to the task.
    await db.insert(issues).values({
      id: issueId, companyId, projectId, title: "Reopened task", status: "todo", assigneeAgentId: agentId,
      executionWorkspacePreference: "reuse_existing", executionWorkspaceSettings: { mode: "shared_workspace" },
    });
    return { companyId, projectId, agentId, issueId };
  }

  async function runTask(task: { agentId: string; issueId: string; projectId: string }) {
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, task.issueId));
    const run = await heartbeat.wakeup(task.agentId, { source: "on_demand", triggerDetail: "manual", contextSnapshot: { issueId: task.issueId, projectId: task.projectId } });
    expect(run).not.toBeNull();
    await vi.waitFor(async () => {
      const latest = await heartbeat.getRun(run!.id);
      expect({ status: latest?.status, errorCode: latest?.errorCode, error: latest?.error }).toEqual({ status: "succeeded", errorCode: null, error: null });
    }, { timeout: 15_000 });
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const calls = execute.mock.calls.filter(([input]) => input.runId === run!.id);
    expect(calls).toHaveLength(1);
    const [issue] = await db.select().from(issues).where(eq(issues.id, task.issueId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, issue!.executionWorkspaceId!));
    return { context: calls[0]![0].context, issue: issue!, workspace: workspace! };
  }

  it("rebinds a task's _default shared workspace to a repo added to the project later", async () => {
    const task = await seedTask();

    const first = await runTask(task);
    expect(first.workspace).toMatchObject({ mode: "shared_workspace", strategyType: "project_primary", projectWorkspaceId: null, repoUrl: null });
    expect(first.workspace.cwd).toContain(`${task.projectId}/_default`);
    expect(first.context.paperclipWorkspace.cwd).toBe(first.workspace.cwd);

    const repo = path.join(root, task.companyId, "repo");
    await createGitRepo(repo);
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId: task.companyId, projectId: task.projectId, name: "llwt/paperclip", sourceType: "local_path", cwd: repo, isPrimary: true,
    });

    const second = await runTask(task);
    expect(second.context.paperclipWorkspace.cwd).toBe(repo);
    expect(second.issue.executionWorkspaceId).toBe(first.workspace.id);
    expect(second.workspace).toMatchObject({
      id: first.workspace.id,
      mode: "shared_workspace",
      strategyType: "project_primary",
      cwd: repo,
      projectWorkspaceId,
    });
    // The rebind resolves the project workspace and repo drift, so the record
    // takes the latest config fingerprint instead of keeping the stale one.
    const fingerprint = (workspace: typeof first.workspace) =>
      (workspace.metadata as { configFingerprint?: { workspaceHash?: string } } | null)?.configFingerprint?.workspaceHash;
    expect(fingerprint(second.workspace)).toBeTruthy();
    expect(fingerprint(second.workspace)).not.toBe(fingerprint(first.workspace));
  }, 40_000);

  it("reuses a shared project_primary workspace whose cwd still matches unchanged", async () => {
    const task = await seedTask();
    const repo = path.join(root, task.companyId, "repo");
    await createGitRepo(repo);
    const projectWorkspaceId = randomUUID();
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId: task.companyId, projectId: task.projectId, name: "llwt/paperclip", sourceType: "local_path", cwd: repo, isPrimary: true,
    });

    const first = await runTask(task);
    expect(first.workspace).toMatchObject({ mode: "shared_workspace", strategyType: "project_primary", cwd: repo, projectWorkspaceId });

    const second = await runTask(task);
    expect(second.context.paperclipWorkspace.cwd).toBe(repo);
    expect(second.workspace).toMatchObject({ id: first.workspace.id, cwd: repo, projectWorkspaceId });
  }, 40_000);
});
