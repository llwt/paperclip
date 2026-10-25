import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { logger } from "../middleware/logger.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Routine clash test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("queued run claim against issues_open_routine_execution_uq", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-routine-execution-clash-");
    db = createDb(tempDb.connectionString);
    // runtimeEnv: {} pins scheduling suppression off; the ambient PAPERCLIP_IN_WORKTREE would no-op the queue.
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    const runIds = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);
    await Promise.all(runIds.map((run) => heartbeat.waitForRunExecutionDrain(run.id)));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIncidentState() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const routineId = randomUUID();
    const liveIssueId = randomUUID();
    const clashingIssueId = randomUUID();
    const liveRunId = randomUUID();
    const queuedRunId = randomUUID();
    const queuedWakeupId = randomUUID();
    const lockedAt = new Date("2026-10-25T12:00:00Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RoutineAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    const routineIssue = {
      companyId,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      originKind: "routine_execution",
      originId: routineId,
      originFingerprint: "fp-1",
    } as const;
    await db.insert(issues).values([
      { ...routineIssue, id: liveIssueId, title: "Routine run task A" },
      { ...routineIssue, id: clashingIssueId, title: "Routine run task B" },
    ]);
    await db.insert(heartbeatRuns).values({
      id: liveRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: lockedAt,
      contextSnapshot: { issueId: liveIssueId, wakeReason: "issue_assigned" },
    });
    await db
      .update(issues)
      .set({ executionRunId: liveRunId, executionAgentNameKey: "routineagent", executionLockedAt: lockedAt })
      .where(eq(issues.id, liveIssueId));
    await db.insert(agentWakeupRequests).values({
      id: queuedWakeupId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: clashingIssueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: queuedWakeupId,
      contextSnapshot: { issueId: clashingIssueId, wakeReason: "issue_assigned" },
    });
    await db.update(agentWakeupRequests).set({ runId: queuedRunId }).where(eq(agentWakeupRequests.id, queuedWakeupId));
    return { companyId, agentId, liveIssueId, clashingIssueId, liveRunId, queuedRunId, queuedWakeupId, lockedAt };
  }

  it("leaves the queued run queued, the live issue unchanged and warns when the claim hits the routine index", async () => {
    const seed = await seedIncidentState();
    const warn = vi.spyOn(logger, "warn");

    await expect(heartbeat.resumeQueuedRuns()).resolves.toBeUndefined();

    const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.queuedRunId));
    expect(queuedRun?.status).toBe("queued");
    expect(queuedRun?.startedAt).toBeNull();

    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, seed.queuedWakeupId));
    expect(wake?.status).toBe("queued");

    const [clashingIssue] = await db.select().from(issues).where(eq(issues.id, seed.clashingIssueId));
    expect(clashingIssue?.executionRunId).toBeNull();
    expect(clashingIssue?.status).toBe("in_progress");

    const [liveIssue] = await db.select().from(issues).where(eq(issues.id, seed.liveIssueId));
    expect(liveIssue?.executionRunId).toBe(seed.liveRunId);
    expect(liveIssue?.executionLockedAt?.toISOString()).toBe(seed.lockedAt.toISOString());
    expect(liveIssue?.status).toBe("in_progress");

    const [liveRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.liveRunId));
    expect(liveRun?.status).toBe("running");

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: seed.clashingIssueId,
        runId: seed.queuedRunId,
        constraint: "issues_open_routine_execution_uq",
      }),
      expect.stringContaining("leaving the run queued"),
    );
  });

  it("starts the queued run once the other routine task leaves the index", async () => {
    const seed = await seedIncidentState();
    await heartbeat.resumeQueuedRuns();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.queuedRunId)))[0]?.status).toBe("queued");

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, seed.liveIssueId));
    await heartbeat.resumeQueuedRuns();
    await heartbeat.waitForRunExecutionDrain(seed.queuedRunId);

    const [queuedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seed.queuedRunId));
    expect(queuedRun?.status).not.toBe("queued");
    expect(queuedRun?.startedAt).not.toBeNull();
  });
});
