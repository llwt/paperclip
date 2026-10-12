import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { agents, agentWakeupRequests, companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const { adapterExecute, prepareCopy } = vi.hoisted(() => ({
  adapterExecute: vi.fn(), prepareCopy: vi.fn(),
}));
vi.mock("../adapters/index.js", () => {
  const adapter = { type: "claude_local", execute: adapterExecute,
    supportsLocalAgentJwt: false, supportsInstructionsBundle: true };
  return { getServerAdapter: () => adapter, findActiveServerAdapter: () => adapter, runningProcesses: new Map() };
});
vi.mock("../services/agent-instruction-working-copies.js", async () => ({
  ...await vi.importActual<typeof import("../services/agent-instruction-working-copies.js")>("../services/agent-instruction-working-copies.js"),
  agentInstructionWorkingCopyService: () => ({
    prepare: prepareCopy, get: vi.fn(async () => null), collectStopped: vi.fn(async () => null),
    release: vi.fn(), reportUnavailable: vi.fn(async () => null), recoverStopped: vi.fn(async () => {}), recoverCaptured: vi.fn(async () => {}),
  }),
}));
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
const describeSupported = support.supported ? describe : describe.skip;
describeSupported("Claude instruction location controller handoff", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("claude-location-controller-");
    db = createDb(database.connectionString);
    root = await mkdtemp(path.join(os.tmpdir(), "claude-location-controller-"));
  }, 30_000);
  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db, { runtimeEnv: {} }));
    vi.clearAllMocks();
  });
  afterAll(async () => {
    await db.$client.end();
    await database.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["local", "remote-copy", "unavailable", "missing"])("dispatches only this run's controller-owned location: %s", async mode => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const cwd = path.join(root, companyId);
    const localRoot = path.join(cwd, "host-copy");
    const entryFile = "nested dir/AGENTS.md";
    await mkdir(path.join(localRoot, "nested dir"), { recursive: true });
    await writeFile(path.join(localRoot, entryFile), "Current instructions.");
    const executionRoot = mode === "remote-copy" ? "/target/agent-files/current-run/live" : localRoot;
    const storedConfig = { engine: "cli", cwd, instructionsFilePath: path.join(cwd, "canonical", "AGENTS.md") };
    await db.insert(companies).values({ id: companyId, name: "Location test", status: "active",
      issuePrefix: `T${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`, defaultResponsibleUserId: "test-user" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Claude", role: "engineer", status: "idle",
      adapterType: "claude_local", adapterConfig: storedConfig, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Instruction location", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "test-user", identifier: `T${companyId.slice(0, 6)}-1` });
    prepareCopy.mockImplementation(async (input: { runId: string }) => {
      if (mode === "unavailable") throw Object.assign(new Error("Instruction editing unavailable"), { status: 403 });
      if (mode === "missing") return null;
      return { id: randomUUID(), companyId, agentId, runId: input.runId,
        localRoot, executionRoot, entryFile, receipt: null, state: "prepared" };
    });
    adapterExecute.mockImplementation(async (_input: AdapterExecutionContext) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, summary: "Done." };
    });
    const service = heartbeatService(db, { runtimeEnv: {} });
    const run = await service.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_commented",
      contextSnapshot: { issueId, taskId: issueId, paperclipInstructionLocation: {
        entryFilePath: "/old-run/live/AGENTS.md", baseDir: "/old-run/live", registeredWorkingCopy: true,
      } } });
    expect(run, JSON.stringify(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId)))).not.toBeNull();
    await vi.waitFor(async () => expect((await service.getRun(run!.id))?.status).toBe("succeeded"), { timeout: 10_000 });
    expect(prepareCopy).toHaveBeenCalledTimes(1);
    expect(adapterExecute).toHaveBeenCalledTimes(1);
    const dispatched = adapterExecute.mock.calls[0][0] as AdapterExecutionContext;
    if (mode === "unavailable" || mode === "missing") {
      expect(dispatched.context).not.toHaveProperty("paperclipInstructionLocation");
      expect(dispatched.config.instructionsFilePath).toBe(storedConfig.instructionsFilePath);
      if (mode === "unavailable") expect(dispatched.context.paperclipTaskMarkdown).toContain("No editable agent instruction working copy");
    } else {
      expect(dispatched.context.paperclipInstructionLocation).toEqual({
        entryFilePath: path.join(executionRoot, entryFile), baseDir: path.join(executionRoot, "nested dir"), registeredWorkingCopy: true,
      });
      expect(dispatched.config.instructionsFilePath).toBe(path.join(localRoot, entryFile));
      expect(dispatched.context.paperclipTaskMarkdown).toContain(executionRoot);
      expect(dispatched.context.paperclipTaskMarkdownCompact).toContain(executionRoot);
    }
    const [stored] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(stored.adapterConfig).toEqual(storedConfig);
  });
});
