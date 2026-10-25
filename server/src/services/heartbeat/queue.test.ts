import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issues } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch } from "../../modules/run-dispatch/index.js";
import type { createWakeQueue } from "../../modules/wake-queue/index.js";
import { createHeartbeatRunState } from "./run-state.js";
import { createHeartbeatRunPreparation } from "./run-preparation.js";
import { logger } from "../../middleware/logger.js";
import { createHeartbeatQueue, type HeartbeatQueueDependencies } from "./queue.js";

type Run = typeof heartbeatRuns.$inferSelect;
function callbacks(db: Db) {
  const state = createHeartbeatRunState(db);
  const preparation = createHeartbeatRunPreparation(db);
  return {
    ...preparation,
    ...state,
    getAgent: vi.fn<HeartbeatQueueDependencies["getAgent"]>(async () => { throw new Error("Unexpected agent lookup"); }),
    options: {},
    setRunStatus: vi.fn<HeartbeatQueueDependencies["setRunStatus"]>(async (id, status, patch) =>
      db.update(heartbeatRuns).set({ ...patch, status }).where(eq(heartbeatRuns.id, id)).returning().then(rows => rows[0] ?? null)),
    setWakeupStatus: vi.fn<HeartbeatQueueDependencies["setWakeupStatus"]>(async () => undefined),
    appendRunEvent: vi.fn<HeartbeatQueueDependencies["appendRunEvent"]>(async () => undefined),
    finalizeAgentStatus: vi.fn(async () => undefined),
    getAgentInvokability: vi.fn<HeartbeatQueueDependencies["getAgentInvokability"]>(async () => ({ invokable: true })),
    getWorktreeExecutionCutoff: vi.fn(async () => null),
    applyRunDispatchPostCommitEffects: vi.fn(),
    issuesSvc: {
      getDependencyReadiness: vi.fn<HeartbeatQueueDependencies["issuesSvc"]["getDependencyReadiness"]>(),
      listDependencyReadiness: vi.fn(async () => new Map()),
    },
    treeControlSvc: { getActivePauseHoldGate: vi.fn(async () => null) },
    budgets: { getInvocationBlock: vi.fn(async () => null) },
    instanceSettings: { getExperimental: vi.fn<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>() },
    runDispatch: createRunDispatch(db),
    wakeQueue: {
      createAdmissionTransactionScope: vi.fn<ReturnType<typeof createWakeQueue>["createAdmissionTransactionScope"]>(),
      admitWakeBehindIssueExecution: vi.fn<ReturnType<typeof createWakeQueue>["admitWakeBehindIssueExecution"]>(),
    },
    activeRunExecutions: new Set<string>(),
    activeRunExecutionPromises: new Set<Promise<void>>(),
    activeWakeupPromises: new Set<Promise<unknown>>(),
    liveRunExecutions: { has: vi.fn(() => false) },
    isHeartbeatRunTerminalStatus: (status: string | null | undefined) => ["succeeded", "failed", "cancelled", "timed_out"].includes(status ?? ""),
    isSameTaskScope: (left: string | null, right: string | null) => left === right,
    runTaskKey: (run: Run) => typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null,
    filterZombieCoalesceTarget: <T extends { id: string; status: string }>(run: T | null) => run,
    getSchedulingSuppression: vi.fn(async () => ({ suppressed: false, reason: null } as Awaited<ReturnType<HeartbeatQueueDependencies["getSchedulingSuppression"]>>)),
    executeRun: vi.fn(async () => undefined),
    applyWakeQueuePostCommitEffects: vi.fn(async () => undefined),
    releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
    publishRunLifecyclePluginEvent: vi.fn(),
    cancelRunInternal: vi.fn(async () => undefined),
    cancelActiveForAgentInternal: vi.fn(async () => undefined),
    resumeExecutionWaitComments: vi.fn(async () => undefined),
    resumeQueuedCommentInterrupt: vi.fn(async () => undefined),
    resumeSavedLegacyComments: vi.fn(async () => undefined),
    formatIssueIdentifierLink: (_identifier: string | null, fallback: string) => fallback,
    sweepPendingCleanupLeases: vi.fn<HeartbeatQueueDependencies["sweepPendingCleanupLeases"]>(),
    // Fork (SX-1386, SX-1537).
    resumeDeferredExecutionStageWakes: vi.fn<HeartbeatQueueDependencies["resumeDeferredExecutionStageWakes"]>(async () => "none"),
    scheduleOwnerExitRecheck: vi.fn<HeartbeatQueueDependencies["scheduleOwnerExitRecheck"]>(),
  } satisfies HeartbeatQueueDependencies;
}
function guardedDatabase() {
  const access = vi.fn(() => { throw new Error("Unexpected queue database access"); });
  return { db: new Proxy({}, { get: access }) as Db, access };
}

describe("heartbeat queue module boundary", () => {
  it("constructs without querying, dispatching, or registering background work", () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    createHeartbeatQueue(database.db, deps);
    expect(database.access).not.toHaveBeenCalled();
    for (const callback of Object.values(deps)) if (vi.isMockFunction(callback)) expect(callback).not.toHaveBeenCalled();
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(deps.activeWakeupPromises.size).toBe(0);
  });

  it.each(["startNextQueuedRunForAgent", "resumeQueuedRuns"] as const)("honors suppression before %s reads or resumes work", async (operation) => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    deps.getSchedulingSuppression.mockResolvedValue({ suppressed: true, reason: "task_drain" });
    const queue = createHeartbeatQueue(database.db, deps);
    await queue[operation]("agent");
    expect(database.access).not.toHaveBeenCalled();
    expect(deps.getAgent).not.toHaveBeenCalled();
    expect(deps.resumeExecutionWaitComments).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("tracks pending wakes across instances and clears each rejected wake", async () => {
    const database = guardedDatabase();
    const deps = callbacks(database.db);
    let rejectFirst!: (reason: Error) => void;
    let rejectSecond!: (reason: Error) => void;
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }));
    deps.getAgent.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSecond = reject; }));
    const first = createHeartbeatQueue(database.db, deps).trackWakeup("first");
    const second = createHeartbeatQueue(database.db, deps).trackWakeup("second");
    const firstCheck = expect(first).rejects.toThrow("first lookup failed");
    const secondCheck = expect(second).rejects.toThrow("second lookup failed");
    expect(deps.activeWakeupPromises).toEqual(new Set([first, second]));
    rejectFirst(new Error("first lookup failed"));
    await firstCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises).toEqual(new Set([second]));
    rejectSecond(new Error("second lookup failed"));
    await secondCheck;
    await Promise.resolve();
    expect(deps.activeWakeupPromises.size).toBe(0);
    expect(deps.activeRunExecutionPromises.size).toBe(0);
    expect(database.access).not.toHaveBeenCalled();
  });

  it("uses the same policy limits for dispatch and execution", () => {
    const database = guardedDatabase();
    const queue = createHeartbeatQueue(database.db, callbacks(database.db));
    const agent = { adapterType: "paperclip_runner", adapterConfig: { provider: "openai_dot" }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 20, maxDailyRuns: 3.8 } } } as unknown as typeof agents.$inferSelect;
    expect(queue.parseHeartbeatPolicy(agent)).toMatchObject({ maxConcurrentRuns: 1, maxDailyRuns: 3 });
    expect(queue.parseHeartbeatPolicy({ ...agent, adapterConfig: { provider: "codex" } })).toMatchObject({ maxConcurrentRuns: 20, maxDailyRuns: 3 });
    expect(database.access).not.toHaveBeenCalled();
  });
});

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Skipping queue module database tests: ${support.reason}`);
describe.skipIf(!support.supported)("heartbeat queue database wiring", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-queue-module");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });
  beforeEach(async () => {
    await db.execute(sql`truncate table companies restart identity cascade`);
  });

  async function fixture(status = "running") {
    const [company] = await db.insert(companies).values({ name: "Queue module", issuePrefix: "QM" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Queue task", status: "todo", assigneeAgentId: agent.id }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "assignment", status: "claimed", claimedAt: new Date() }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status, invocationSource: "assignment", wakeupRequestId: wake.id, startedAt: status === "running" ? new Date() : null, contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: run.id, executionAgentNameKey: agent.name, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    return { company, agent, issue, wake, run };
  }

  it.each(["claimed", "cancelled"] as const)("releases a running claim while preserving a %s wake", async (wakeStatus) => {
    const { run, issue, wake } = await fixture();
    await db.update(agentWakeupRequests).set({ status: wakeStatus }).where(eq(agentWakeupRequests.id, wake.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [releasedIssue] = await db.select().from(issues).where(eq(issues.id, issue.id));
    const [releasedWake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    expect(released).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    expect(releasedIssue).toMatchObject({ executionRunId: null, executionAgentNameKey: null, executionLockedAt: null });
    expect(releasedWake.status).toBe(wakeStatus === "cancelled" ? "cancelled" : "queued");
    if (wakeStatus === "claimed") expect(releasedWake.claimedAt).toBeNull();
  });

  it("preserves a newer execution owner when releasing an old claim", async () => {
    const { run, issue, agent, company } = await fixture();
    const [newOwner] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running", invocationSource: "assignment" }).returning();
    await db.update(issues).set({ executionRunId: newOwner.id }).where(eq(issues.id, issue.id));
    await createHeartbeatQueue(db, callbacks(db)).releaseRunClaimedJustBeforeSuppression(run.id);
    const [current] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(current.executionRunId).toBe(newOwner.id);
  });

  it("leaves a queued run and its issue unchanged when the claim hits the open routine execution constraint, and still claims the next run", async () => {
    const [company] = await db.insert(companies).values({ name: "Routine collision", issuePrefix: "RC" }).returning();
    const [ownerAgent] = await db.insert(agents).values({ companyId: company.id, name: "Owner agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: { heartbeat: { maxConcurrentRuns: 5 } } }).returning();
    const routine = { originKind: "routine_execution", originId: "routine-1", originFingerprint: "fingerprint-1" };
    const [liveRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: ownerAgent.id, status: "running", invocationSource: "automation", startedAt: new Date() }).returning();
    await db.insert(issues).values({ companyId: company.id, title: "Open routine issue", status: "in_progress", assigneeAgentId: ownerAgent.id, executionRunId: liveRun.id, ...routine });
    const [collidingIssue] = await db.insert(issues).values({ companyId: company.id, title: "Colliding routine issue", status: "todo", assigneeAgentId: agent.id, ...routine }).returning();
    const [otherIssue] = await db.insert(issues).values({ companyId: company.id, title: "Unrelated issue", status: "todo", assigneeAgentId: agent.id }).returning();
    const [collidingWake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "automation", status: "queued" }).returning();
    const [collidingRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued", invocationSource: "automation", responsibleUserId: "user-1", wakeupRequestId: collidingWake.id, contextSnapshot: { issueId: collidingIssue.id } }).returning();
    const [otherWake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "automation", status: "queued" }).returning();
    const [otherRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued", invocationSource: "automation", responsibleUserId: "user-1", wakeupRequestId: otherWake.id, contextSnapshot: { issueId: otherIssue.id } }).returning();

    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({} as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    const warn = vi.spyOn(logger, "warn");
    try {
      await createHeartbeatQueue(db, deps).resumeQueuedRuns();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: collidingRun.id, issueId: collidingIssue.id, constraint: "issues_open_routine_execution_uq" }),
        expect.stringContaining("open routine execution constraint"),
      );
    } finally {
      warn.mockRestore();
    }

    expect(deps.executeRun).toHaveBeenCalledTimes(1);
    expect(deps.executeRun).toHaveBeenCalledWith(otherRun.id);
    const [stillQueued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, collidingRun.id));
    const [untouchedIssue] = await db.select().from(issues).where(eq(issues.id, collidingIssue.id));
    const [claimedOther] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherRun.id));
    const [lockedOther] = await db.select().from(issues).where(eq(issues.id, otherIssue.id));
    expect(stillQueued.status).toBe("queued");
    expect(untouchedIssue.executionRunId).toBeNull();
    expect(claimedOther.status).toBe("running");
    expect(lockedOther.executionRunId).toBe(otherRun.id);
  });

  it("claimQueuedRun called directly (the executeRun path) returns null and leaves the run queued, not failed, on the open routine execution constraint", async () => {
    const [company] = await db.insert(companies).values({ name: "Routine direct claim", issuePrefix: "RD" }).returning();
    const [ownerAgent] = await db.insert(agents).values({ companyId: company.id, name: "Owner agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Queue agent", role: "engineer", status: "idle", adapterType: "process", adapterConfig: {} }).returning();
    const routine = { originKind: "routine_execution", originId: "routine-2", originFingerprint: "fingerprint-2" };
    const [liveRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: ownerAgent.id, status: "running", invocationSource: "automation", startedAt: new Date() }).returning();
    await db.insert(issues).values({ companyId: company.id, title: "Open routine issue", status: "in_progress", assigneeAgentId: ownerAgent.id, executionRunId: liveRun.id, ...routine });
    const [collidingIssue] = await db.insert(issues).values({ companyId: company.id, title: "Colliding routine issue", status: "todo", assigneeAgentId: agent.id, ...routine }).returning();
    const [wake] = await db.insert(agentWakeupRequests).values({ companyId: company.id, agentId: agent.id, source: "automation", status: "queued" }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "queued", invocationSource: "automation", responsibleUserId: "user-1", wakeupRequestId: wake.id, contextSnapshot: { issueId: collidingIssue.id } }).returning();

    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(agent);
    deps.instanceSettings.getExperimental.mockResolvedValue({} as Awaited<ReturnType<HeartbeatQueueDependencies["instanceSettings"]["getExperimental"]>>);
    const warn = vi.spyOn(logger, "warn");
    try {
      await expect(createHeartbeatQueue(db, deps).claimQueuedRun(run)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ runId: run.id, issueId: collidingIssue.id, constraint: "issues_open_routine_execution_uq" }),
        expect.stringContaining("open routine execution constraint"),
      );
    } finally {
      warn.mockRestore();
    }

    const [stillQueued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [untouchedIssue] = await db.select().from(issues).where(eq(issues.id, collidingIssue.id));
    expect(stillQueued).toMatchObject({ status: "queued", errorCode: null, startedAt: null, finishedAt: null });
    expect(untouchedIssue.executionRunId).toBeNull();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });

  it("cancels at the daily run cap before claiming or dispatching", async () => {
    const { run, agent } = await fixture("queued");
    const cappedAgent = { ...agent, runtimeConfig: { heartbeat: { maxDailyRuns: 0 } } };
    const deps = callbacks(db);
    deps.getAgent.mockResolvedValue(cappedAgent);
    expect(await createHeartbeatQueue(db, deps).claimQueuedRun(run)).toBeNull();
    const [cancelled] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(cancelled).toMatchObject({ status: "cancelled", errorCode: "heartbeat.daily_run_limit" });
    expect(deps.setWakeupStatus).toHaveBeenCalledWith(run.wakeupRequestId, "skipped", expect.any(Object));
    expect(deps.releaseIssueExecutionAndPromote).toHaveBeenCalledWith(cancelled, { suppressImmediateRecovery: true });
    expect(deps.treeControlSvc.getActivePauseHoldGate).not.toHaveBeenCalled();
    expect(deps.executeRun).not.toHaveBeenCalled();
  });
});
