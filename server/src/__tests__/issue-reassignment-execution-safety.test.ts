import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companyMemberships,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runningProcesses } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { buildAssignmentWakeup, verifyOwnershipStop } from "../services/issue-assignment.ts";
import { remoteTerminationReceipt } from "../services/remote-execution-termination.ts";
import { issueService } from "../services/issues.ts";

// Concurrency review (SX-1213) section 7: each guard against two agents
// executing one issue after a reassignment, proven on the real database and
// queue rather than on mocked services.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres reassignment safety tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const parseResult = (value: unknown) => (value && typeof value === "object" ? value as Record<string, unknown> : {});

describeEmbeddedPostgres("issue reassignment execution safety", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-reassignment-execution-safety-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  const children: ChildProcess[] = [];

  // Scratch triggers a test installs to fail or interleave a write.
  const triggers: Array<{ name: string; table: string }> = [];
  async function installTrigger(input: { name: string; table: string; timing: "BEFORE INSERT" | "AFTER UPDATE"; body: string }) {
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${input.name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${input.body} RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${input.name} ${input.timing} ON ${input.table} FOR EACH ROW EXECUTE FUNCTION ${input.name}()`));
    triggers.push({ name: input.name, table: input.table });
  }

  afterEach(async () => {
    for (const trigger of triggers.splice(0)) {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${trigger.name} ON ${trigger.table}`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${trigger.name}()`));
    }
    for (const child of children.splice(0)) child.kill("SIGKILL");
    runningProcesses.clear();
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(nativeRunFinalizations);
    await db.delete(environmentLeases);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(companyId: string, agent?: { agentId: string; runId: string }, routeDb: typeof db = db) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = agent
        ? { type: "agent", agentId: agent.agentId, companyId, runId: agent.runId, source: "agent_jwt" }
        : {
            type: "board",
            userId: "board-user",
            companyIds: [companyId],
            memberships: [{ companyId, membershipRole: "admin", status: "active" }],
            isInstanceAdmin: false,
            source: "session",
          };
      next();
    });
    app.use("/api", issueRoutes(routeDb, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed(input: { liveRun?: "untracked" | "native" | "tracked" | "none" } = {}) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const successorAgentId = randomUUID();
    const otherAgentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    await db.insert(agents).values(
      [
        [ownerAgentId, "Owner"],
        [successorAgentId, "Successor"],
        [otherAgentId, "Other"],
      ].map(([id, name]) => ({
        id: id!,
        companyId,
        name: name!,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      })),
    );
    const live = (input.liveRun ?? "none") !== "none";
    if (live) {
      // A run this server holds no live session or child process for, as
      // after a server restart. Cancelling it only flips the row; a native
      // one records `dispatched: false`.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: ownerAgentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "running",
        startedAt: new Date(),
        runtimeModeResolvedAt: new Date(),
        ...(input.liveRun === "native" ? { runtimeMode: "native", nativeIssueId: issueId } : {}),
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      });
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Reassignment safety",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: ownerAgentId,
      ...(live
        ? { executionRunId: runId, executionAgentNameKey: "owner", executionLockedAt: new Date() }
        : {}),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    if (input.liveRun === "native") {
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    }
    if (input.liveRun === "tracked") {
      // A local child process this server owns: the stop kills it and
      // records the acknowledgement.
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.push(child);
      runningProcesses.set(runId, { child, graceSec: 1, processGroupId: null });
      await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, runId));
    }
    return { companyId, ownerAgentId, successorAgentId, otherAgentId, issueId, runId };
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  it("keeps the existing activity entry and guarded issue_assigned wake for an explicit PATCH reassignment", async () => {
    const { companyId, successorAgentId, issueId } = await seed();
    const before = await readIssue(issueId);

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId });

    expect(res.status).toBe(200);
    const after = await readIssue(issueId);
    expect(after.assigneeAgentId).toBe(successorAgentId);
    expect(after.statusVersion).toBe(before.statusVersion + 1);
    const activity = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
    expect(activity).toHaveLength(1);
    await expect.poll(async () =>
      db
        .select({ reason: agentWakeupRequests.reason, idempotencyKey: agentWakeupRequests.idempotencyKey })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, successorAgentId)),
    ).toEqual([
      { reason: "issue_assigned", idempotencyKey: `issue-assigned:${issueId}:${after.statusVersion}:none` },
    ]);
  });

  // Change 1: a cancelled row is not a stop receipt.
  it.each(["untracked", "native"] as const)("returns 409 run_stop_unacknowledged and keeps the owner when the %s stop was not acknowledged", async (liveRun) => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "run_stop_unacknowledged", runId });
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    // Today's cancellation still flips the row; it carries no acknowledgement.
    expect(run.status).toBe("cancelled");
    expect((run.resultJson as Record<string, any> | null)?.executionCancellation?.state).not.toBe("acknowledged");
    expect((await readIssue(issueId)).assigneeAgentId).toBe(ownerAgentId);
    const successorWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, successorAgentId));
    expect(successorWakes).toEqual([]);
  });

  // Change 2: the reassignment stop promotes nothing for the old owner, who is
  // still assigned until the ownership commit.
  it.each(["untracked", "native"] as const)("promotes no deferred wake and starts no recovery run for the old owner when the %s stop fails closed", async (liveRun) => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun });
    const deferredWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: deferredWakeId,
      companyId,
      agentId: ownerAgentId,
      source: "automation",
      triggerDetail: "system",
      reason: "approval_approved",
      payload: { issueId },
      status: "deferred_issue_execution",
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId });

    expect(res.status).toBe(409);
    const ownerRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, ownerAgentId));
    expect(ownerRuns).toEqual([{ id: runId, status: "cancelled" }]);
    const deferred = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, deferredWakeId))
      .then((rows) => rows[0]!);
    expect(deferred.status).toBe("deferred_issue_execution");
    // Without suppression, the release recovery tail acts for the old owner
    // and moves the issue to blocked before the ownership change could commit.
    expect(await readIssue(issueId)).toMatchObject({
      status: "in_progress",
      statusVersion: 0,
      assigneeAgentId: ownerAgentId,
      executionRunId: null,
    });
  });

  // Change 4: the assignment wake is bound to the committed owner and version.
  it("records issue_state_guard_mismatch and creates no run when the assignment wake arrives after a later reassignment", async () => {
    const { companyId, successorAgentId, otherAgentId, issueId } = await seed();
    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId, status: "todo" });
    expect(res.status).toBe(200);
    const committed = await readIssue(issueId);
    // Let the route's own wake land first, so the only stale delivery is the
    // one this test sends.
    await expect.poll(async () =>
      db
        .select({ reason: agentWakeupRequests.reason })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.agentId, successorAgentId)),
    ).toEqual([{ reason: "issue_assigned" }]);
    // The same wake, built for that commit, is delivered only after a later
    // reassignment committed.
    const stale = buildAssignmentWakeup({
      issue: committed,
      commentId: null,
      interruptedRunId: null,
      actor: { actorType: "user", actorId: "board-user" },
    })!;
    await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    const runsBefore = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns);

    const run = await heartbeatService(db).wakeup(stale.agentId, stale.wakeup);

    expect(run).toBeNull();
    const skipped = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.agentId, successorAgentId),
        eq(agentWakeupRequests.reason, "issue_state_guard_mismatch"),
      ));
    expect(skipped).toEqual([{ status: "skipped", idempotencyKey: stale.wakeup.idempotencyKey }]);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)).toEqual(runsBefore);
  });

  // Change 5: a reassignment between the staleness pass and the claim cannot
  // start the old owner's queued run.
  it("cancels the old owner's queued run at the claim when the issue is reassigned after the staleness pass", async () => {
    const { companyId, ownerAgentId, successorAgentId, issueId } = await seed();
    const queuedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: queuedRunId,
      companyId,
      agentId: ownerAgentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "queued",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_continuation_needed" },
    });
    await db.update(issues).set({ executionRunId: queuedRunId }).where(eq(issues.id, issueId));
    let reassignedAtClaim = false;
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage, runId }) => {
        if (stage !== "claim" || runId !== queuedRunId) return;
        // The staleness pass committed with the old owner still assigned.
        await db
          .update(issues)
          .set({ assigneeAgentId: successorAgentId, executionRunId: null })
          .where(eq(issues.id, issueId));
        reassignedAtClaim = true;
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect(reassignedAtClaim).toBe(true);
    const run = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRunId)).then((rows) => rows[0]!);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_assignee_changed" });
    expect(run.startedAt).toBeNull();
    const invocations = await db
      .select({ eventType: heartbeatRunEvents.eventType })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, queuedRunId), inArray(heartbeatRunEvents.eventType, ["adapter.invoke"])));
    expect(invocations).toEqual([]);
    expect((await readIssue(issueId)).executionRunId).toBeNull();
  });

  // Change 3: the update compares the snapshot owner and version under the
  // issue lock, so concurrent handoffs from one owner cannot both commit.
  it("lets exactly one of two concurrent A-to-B and A-to-C reassignments commit and wake", async () => {
    const { companyId, ownerAgentId, successorAgentId, otherAgentId, issueId } = await seed();
    const app = createApp(companyId);
    // Hold the issue row so both requests read owner A and queue on the lock.
    let release!: () => void;
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await holding;
    const toSuccessor = request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId }).then((res) => res);
    const toOther = request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: otherAgentId }).then((res) => res);
    await expect.poll(async () => {
      const rows = await db.execute<{ waiting: number }>(
        `select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`,
      );
      return Number((rows as unknown as Array<{ waiting: number }>)[0]?.waiting ?? 0);
    }, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    release();
    await holder;
    const results = await Promise.all([toSuccessor, toOther]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const loser = results.find((res) => res.status === 409)!;
    expect(loser.body.details).toMatchObject({ code: "issue_state_changed", expected: { assigneeAgentId: ownerAgentId } });
    const winnerAgentId = results.find((res) => res.status === 200)!.body.assigneeAgentId;
    expect([successorAgentId, otherAgentId]).toContain(winnerAgentId);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(winnerAgentId);
    await expect.poll(async () =>
      db
        .select({ agentId: agentWakeupRequests.agentId })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.reason, "issue_assigned")),
    ).toEqual([{ agentId: winnerAgentId }]);
  });

  // Change 2, commit side: a run that started for the old owner after the stop
  // fails the ownership commit instead of running next to the successor.
  it("fails the ownership commit with issue_state_changed when another old-owner run is live", async () => {
    const { companyId, ownerAgentId, successorAgentId, issueId } = await seed();
    // The run this request stopped, and one a recovery path started after it.
    const stoppedRunId = randomUUID();
    const replacementRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: stoppedRunId, status: "cancelled", errorCode: "issue_reassigned" },
      { id: replacementRunId, status: "running", startedAt: new Date() },
    ].map((run) => ({
      ...run,
      companyId,
      agentId: ownerAgentId,
      invocationSource: "automation" as const,
      triggerDetail: "system" as const,
      contextSnapshot: { issueId, taskId: issueId },
    })));
    const before = await readIssue(issueId);

    await expect(issueService(db).update(issueId, {
      assigneeAgentId: successorAgentId,
      expectedAssigneeAgentId: ownerAgentId,
      expectedStatusVersion: before.statusVersion,
      ownershipStopRunId: stoppedRunId,
    })).rejects.toMatchObject({ status: 409, details: { code: "issue_state_changed", runId: replacementRunId } });

    expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, statusVersion: before.statusVersion });
  });

  // Change 6: the handoff commits in one transaction.
  it("rolls the assignee back when the handoff comment cannot bind its attachments", async () => {
    const { companyId, ownerAgentId, successorAgentId, issueId } = await seed();

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId, comment: "Over to you", attachmentIds: [randomUUID()] });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(ownerAgentId);
    expect(await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId))).toEqual([]);
    expect(
      await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, successorAgentId)),
    ).toEqual([]);
  });

  // Acceptance criterion 2: a run that hands its own issue off is stopped, and
  // the stop authorizes only the mutation that requested it.
  it("lets a stopped run finish its own handoff and nothing after it", async () => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun: "tracked" });
    const app = createApp(companyId, { agentId: ownerAgentId, runId });

    const handoff = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("x-paperclip-run-id", runId)
      .send({ assigneeAgentId: successorAgentId });

    expect(handoff.status).toBe(200);
    const stopped = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
    expect(stopped).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect((stopped.resultJson as Record<string, any>).executionCancellation?.state).toBe("acknowledged");
    expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
    await expect.poll(async () =>
      db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, successorAgentId), eq(agentWakeupRequests.reason, "issue_assigned"))),
    ).toEqual([{ payload: expect.objectContaining({ issueId, interruptedRunId: runId }) }]);

    const lateWrite = await request(app)
      .patch(`/api/issues/${issueId}`)
      .set("x-paperclip-run-id", runId)
      .send({ title: "Late edit from the stopped run" });

    expect(lateWrite.status).toBeGreaterThanOrEqual(400);
    expect((await readIssue(issueId)).title).toBe("Reassignment safety");
  });

  async function readRun(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  }

  async function wakesFor(agentId: string) {
    return db.select({ reason: agentWakeupRequests.reason }).from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
  }

  // A remote execution lease of the old run. The local bridge process is
  // killed and acknowledged, but only a provider receipt proves the stop.
  async function addRemoteLease(companyId: string, issueId: string, runId: string) {
    const [lease] = await db.insert(environmentLeases).values({
      companyId,
      issueId,
      heartbeatRunId: runId,
      provider: "test-remote",
      providerLeaseId: `lease-${runId}`,
    }).returning();
    return lease!;
  }

  async function recordRemoteTerminationReceipt(lease: typeof environmentLeases.$inferSelect) {
    await db.update(environmentLeases).set({
      status: "released",
      releasedAt: new Date(),
      cleanupStatus: "success",
      metadata: {
        remoteExecutionTermination: remoteTerminationReceipt(lease, { providerLeaseId: lease.providerLeaseId, state: "stopped" }),
      },
    }).where(eq(environmentLeases.id, lease.id));
  }

  // Change 6: the owner, the plain handoff comment and their audit commit
  // together. Any failed write leaves the old owner and wakes nobody.
  it.each([
    ["the plain handoff comment", "issue_comments", ""],
    ["the issue.updated audit entry", "activity_log", "IF NEW.action = 'issue.updated' THEN "],
    ["the issue.comment_added audit entry", "activity_log", "IF NEW.action = 'issue.comment_added' THEN "],
  ] as const)("rolls the handoff back when %s cannot be written", async (_label, table, condition) => {
    const { companyId, ownerAgentId, successorAgentId, issueId } = await seed();
    const before = await readIssue(issueId);
    await installTrigger({
      name: "test_reject_handoff_write",
      table,
      timing: "BEFORE INSERT",
      body: condition
        ? `${condition}RAISE EXCEPTION 'synthetic write failure'; END IF;`
        : "RAISE EXCEPTION 'synthetic write failure';",
    });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId, comment: "Synthetic handoff instruction" });

    expect(res.status).toBe(500);
    expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, statusVersion: before.statusVersion });
    expect(await db.select({ id: issueComments.id }).from(issueComments).where(eq(issueComments.issueId, issueId))).toEqual([]);
    expect(await db.select({ id: activityLog.id }).from(activityLog).where(eq(activityLog.entityId, issueId))).toEqual([]);
    // Give a stray post-response wake time to land before asserting none did.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await wakesFor(successorAgentId)).toEqual([]);
  });

  it("commits the handoff comment and both audit entries with the new owner", async () => {
    const { companyId, successorAgentId, issueId } = await seed();

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId, comment: "Synthetic handoff instruction" });

    expect(res.status).toBe(200);
    const [comment] = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comment).toMatchObject({ body: "Synthetic handoff instruction" });
    const activity = await db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId));
    expect(activity.map((row) => row.action).sort()).toEqual(["issue.comment_added", "issue.updated"]);
    expect(activity.find((row) => row.action === "issue.comment_added")!.details).toMatchObject({ commentId: comment!.id });
    await expect.poll(async () =>
      db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(and(eq(agentWakeupRequests.agentId, successorAgentId), eq(agentWakeupRequests.reason, "issue_assigned"))),
    ).toEqual([{ payload: expect.objectContaining({ issueId, commentId: comment!.id }) }]);
  });

  // Change 1, remote target: an acknowledged local stop is not enough while
  // the provider has not confirmed the remote execution stopped.
  it("returns 409 run_stop_uncertain and keeps the owner while a remote lease has no termination receipt", async () => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun: "tracked" });
    await addRemoteLease(companyId, issueId, runId);

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "run_stop_uncertain", runId });
    expect((await readRun(runId)).resultJson).toMatchObject({ executionCancellation: { state: "acknowledged" } });
    expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, statusVersion: 0 });
    expect(await wakesFor(successorAgentId)).toEqual([]);
  });

  // Change 1, native: an acknowledged reassignment intent proves nothing
  // until the local lease and process cleanup finished.
  it("treats an acknowledged native reassignment stop as uncertain until its cleanup finished", async () => {
    const { companyId, issueId, runId } = await seed({ liveRun: "native" });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    await db.update(heartbeatRuns).set({
      status: "cancelled",
      errorCode: "issue_reassigned",
      processPid: child.pid ?? null,
      resultJson: {
        reassignmentStopRequested: true,
        nativeCancellation: {
          schema: "paperclip.native-cancellation.v1",
          runId,
          companyId,
          issueId,
          scope: "run",
          reasonCode: "cancellation_run_only",
          dispatchState: "acknowledged",
          dispatched: true,
          intentAuditId: randomUUID(),
          acknowledgementAuditId: randomUUID(),
        },
      },
    }).where(eq(heartbeatRuns.id, runId));
    const [lease] = await db.insert(environmentLeases).values({ companyId, issueId, heartbeatRunId: runId, provider: "local" }).returning();

    // Lease still held and process alive.
    expect(await verifyOwnershipStop(db, await readRun(runId), { verificationTimeoutMs: 0 })).toBe("uncertain");
    await db.update(environmentLeases).set({ releasedAt: new Date(), cleanupStatus: "success", status: "released" })
      .where(eq(environmentLeases.id, lease!.id));
    // Lease released, process still alive.
    expect(await verifyOwnershipStop(db, await readRun(runId), { verificationTimeoutMs: 0 })).toBe("uncertain");
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(await verifyOwnershipStop(db, await readRun(runId), { verificationTimeoutMs: 0 })).toBe("stopped");
  });

  // The route's database, with `inject` run once in its own committed
  // transaction before the first transaction that opens after `ready()`.
  // That puts a concurrent writer between the stop and the ownership commit,
  // where the real claimant would have to wait for the stop's issue lock.
  function dbInjectingAfter(ready: () => Promise<boolean>, inject: () => Promise<void>): typeof db {
    let injected = false;
    return new Proxy(db, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (prop !== "transaction") return typeof value === "function" ? value.bind(target) : value;
        return async (...args: Parameters<typeof db.transaction>) => {
          if (!injected && await ready()) {
            injected = true;
            await inject();
          }
          return target.transaction(...args);
        };
      },
    });
  }

  // Criteria 3 and 5 through the real PATCH commit: after the request stopped
  // the old run, a queued run of the old owner wins its claim (or a
  // replacement run starts) and takes the execution lock. The commit fails
  // closed and keeps that run and its lock.
  it.each(["queued claimant", "replacement run"] as const)("fails the PATCH with issue_state_changed and keeps the live lock when a %s of the old owner starts after the stop", async (kind) => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun: "tracked" });
    const otherRunId = randomUUID();
    const otherRun = {
      id: otherRunId,
      companyId,
      agentId: ownerAgentId,
      invocationSource: "automation" as const,
      triggerDetail: "system" as const,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_continuation_needed" },
    };
    if (kind === "queued claimant") await db.insert(heartbeatRuns).values({ ...otherRun, status: "queued" });
    const routeDb = dbInjectingAfter(
      async () => (await readRun(runId)).status === "cancelled",
      async () => {
        await db.transaction(async (tx) => {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
          if (kind === "queued claimant") {
            await tx.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, otherRunId));
          } else {
            await tx.insert(heartbeatRuns).values({ ...otherRun, status: "running", startedAt: new Date() });
          }
          await tx.update(issues)
            .set({ executionRunId: otherRunId, executionAgentNameKey: "owner", executionLockedAt: new Date() })
            .where(eq(issues.id, issueId));
        });
      },
    );

    const res = await request(createApp(companyId, undefined, routeDb))
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId });

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "issue_state_changed", runId: otherRunId });
    expect(await readIssue(issueId)).toMatchObject({
      assigneeAgentId: ownerAgentId,
      statusVersion: 0,
      executionRunId: otherRunId,
    });
    expect((await readRun(runId)).status).toBe("cancelled");
    expect((await readRun(otherRunId)).status).toBe("running");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await wakesFor(successorAgentId)).toEqual([]);
  });

  // Sticky refusal (SX-1442): a retry finds no active run, because the first
  // attempt already cancelled it, and must still refuse while the stop of
  // that run is unverified.
  it.each(["run_stop_unacknowledged", "run_stop_uncertain"] as const)("refuses a retry of a reassignment refused with %s", async (code) => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({
      liveRun: code === "run_stop_uncertain" ? "tracked" : "untracked",
    });
    if (code === "run_stop_uncertain") await addRemoteLease(companyId, issueId, runId);
    const app = createApp(companyId);

    const first = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId });
    const retry = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId });

    expect(first.status).toBe(409);
    expect(first.body.details).toMatchObject({ code, runId });
    expect(retry.status).toBe(409);
    expect(retry.body.details).toMatchObject({ code, runId });
    expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, status: "in_progress", statusVersion: 0 });
    expect(await wakesFor(successorAgentId)).toEqual([]);
  });

  it.each(["acknowledgement", "termination receipt"] as const)("commits the retry once the %s of the earlier stop arrived", async (proof) => {
    const { companyId, successorAgentId, issueId, runId } = await seed({
      liveRun: proof === "termination receipt" ? "tracked" : "untracked",
    });
    const lease = proof === "termination receipt" ? await addRemoteLease(companyId, issueId, runId) : null;
    const app = createApp(companyId);
    expect((await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId })).status).toBe(409);

    if (lease) {
      await recordRemoteTerminationReceipt(lease);
    } else {
      await db.update(heartbeatRuns).set({
        resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || '{"executionCancellation": {"state": "acknowledged"}}'::jsonb`,
      }).where(eq(heartbeatRuns.id, runId));
    }
    const retry = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId });

    expect(retry.status).toBe(200);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
    expect((await readRun(runId)).resultJson).toMatchObject({ reassignmentPendingIssueId: null });
    await expect.poll(() => wakesFor(successorAgentId)).toEqual([{ reason: "issue_assigned" }]);
  });

  it("commits a board override of an unverified stop and records it in the reassignment activity", async () => {
    const { companyId, successorAgentId, issueId, runId } = await seed({ liveRun: "untracked" });
    const app = createApp(companyId);
    expect((await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId })).status).toBe(409);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId, acceptUnverifiedStop: true });

    expect(res.status).toBe(200);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
    const [activity] = await db
      .select({ actorType: activityLog.actorType, actorId: activityLog.actorId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
    expect(activity).toMatchObject({
      actorType: "user",
      actorId: "board-user",
      details: {
        unverifiedStopOverrides: [{
          runId,
          reason: "run_stop_unacknowledged",
          acceptedByActorType: "user",
          acceptedByActorId: "board-user",
        }],
      },
    });
    await expect.poll(() => wakesFor(successorAgentId)).toEqual([{ reason: "issue_assigned" }]);
  });

  it("refuses the unverified-stop override from an agent with its own code and changes nothing", async () => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun: "tracked" });

    const res = await request(createApp(companyId, { agentId: ownerAgentId, runId }))
      .patch(`/api/issues/${issueId}`)
      .set("x-paperclip-run-id", runId)
      .send({ assigneeAgentId: successorAgentId, acceptUnverifiedStop: true });

    expect(res.status).toBe(403);
    expect(res.body.details).toMatchObject({ code: "unverified_stop_override_forbidden" });
    expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, statusVersion: 0, executionRunId: runId });
    expect((await readRun(runId)).status).toBe("running");
    expect(await wakesFor(successorAgentId)).toEqual([]);
  });

  it("ends the stickiness once a reassignment committed", async () => {
    const { companyId, ownerAgentId, successorAgentId, otherAgentId, issueId, runId } = await seed({ liveRun: "untracked" });
    const app = createApp(companyId);
    expect((await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId })).status).toBe(409);
    expect((await request(app)
      .patch(`/api/issues/${issueId}`)
      .send({ assigneeAgentId: successorAgentId, acceptUnverifiedStop: true })).status).toBe(200);
    expect((await readRun(runId)).resultJson).toMatchObject({ reassignmentPendingIssueId: null });

    // Back to the old owner, then on: the older unverified run no longer blocks.
    expect((await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: ownerAgentId })).status).toBe(200);
    const res = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: otherAgentId });

    expect(res.status).toBe(200);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(otherAgentId);
  });

  // A board comment that interrupts and reassigns in one PATCH cancels the run
  // as `operator_interrupted` before the shared assignment step. Its refusal
  // must be as sticky as that of a reassignment stop.
  const interruptHandoff = (successorAgentId: string, extra: Record<string, unknown> = {}) => ({
    assigneeAgentId: successorAgentId,
    comment: "Synthetic interrupt handoff",
    interrupt: true,
    ...extra,
  });

  it.each(["run_stop_unacknowledged", "run_stop_uncertain"] as const)("refuses a retry of an interrupting handoff refused with %s", async (code) => {
    const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({
      liveRun: code === "run_stop_uncertain" ? "tracked" : "untracked",
    });
    if (code === "run_stop_uncertain") await addRemoteLease(companyId, issueId, runId);
    const app = createApp(companyId);

    const first = await request(app).patch(`/api/issues/${issueId}`).send(interruptHandoff(successorAgentId));
    const retry = await request(app).patch(`/api/issues/${issueId}`).send(interruptHandoff(successorAgentId));

    expect(first.status).toBe(409);
    expect(first.body.details).toMatchObject({ code, runId });
    expect(await readRun(runId)).toMatchObject({
      errorCode: "operator_interrupted",
      resultJson: expect.objectContaining({ reassignmentPendingIssueId: issueId }),
    });
    expect(retry.status).toBe(409);
    expect(retry.body.details).toMatchObject({ code, runId });
    // A plain retry without the interrupt is refused as well.
    const plain = await request(app).patch(`/api/issues/${issueId}`).send({ assigneeAgentId: successorAgentId });
    expect(plain.status).toBe(409);
    expect(plain.body.details).toMatchObject({ code, runId });
    expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, status: "in_progress", statusVersion: 0 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await wakesFor(successorAgentId)).toEqual([]);
  });

  it("commits the retry of an interrupting handoff once the termination receipt arrived", async () => {
    const { companyId, successorAgentId, issueId, runId } = await seed({ liveRun: "tracked" });
    const lease = await addRemoteLease(companyId, issueId, runId);
    const app = createApp(companyId);
    expect((await request(app).patch(`/api/issues/${issueId}`).send(interruptHandoff(successorAgentId))).status).toBe(409);

    await recordRemoteTerminationReceipt(lease);
    const retry = await request(app).patch(`/api/issues/${issueId}`).send(interruptHandoff(successorAgentId));

    expect(retry.status).toBe(200);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
    expect((await readRun(runId)).resultJson).toMatchObject({ reassignmentPendingIssueId: null });
    await expect.poll(() => wakesFor(successorAgentId)).toEqual([{ reason: "issue_assigned" }]);
  });

  it("commits a board override of an interrupting handoff and records it in the reassignment activity", async () => {
    const { companyId, successorAgentId, issueId, runId } = await seed({ liveRun: "untracked" });
    const app = createApp(companyId);
    expect((await request(app).patch(`/api/issues/${issueId}`).send(interruptHandoff(successorAgentId))).status).toBe(409);

    const res = await request(app)
      .patch(`/api/issues/${issueId}`)
      .send(interruptHandoff(successorAgentId, { acceptUnverifiedStop: true }));

    expect(res.status).toBe(200);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
    const [activity] = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
    expect(activity?.details).toMatchObject({
      unverifiedStopOverrides: [{
        runId,
        reason: "run_stop_unacknowledged",
        acceptedByActorType: "user",
        acceptedByActorId: "board-user",
      }],
    });
    expect((await readRun(runId)).resultJson).toMatchObject({ reassignmentPendingIssueId: null });
    await expect.poll(() => wakesFor(successorAgentId)).toEqual([{ reason: "issue_assigned" }]);
  });

  it("leaves an ordinary interrupting comment without a reassignment unmarked", async () => {
    const { companyId, ownerAgentId, issueId, runId } = await seed({ liveRun: "untracked" });

    const res = await request(createApp(companyId))
      .patch(`/api/issues/${issueId}`)
      .send({ comment: "Synthetic interrupt", interrupt: true });

    expect(res.status).toBe(200);
    expect((await readIssue(issueId)).assigneeAgentId).toBe(ownerAgentId);
    const run = await readRun(runId);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "operator_interrupted" });
    expect(parseResult(run.resultJson).reassignmentPendingIssueId).toBeUndefined();
  });

  // A newer run of the same owner starts on the issue after a refused
  // reassignment (for example a recovery run). The retry stops and verifies
  // that newer run; it must still refuse on the older, unverified stop,
  // because the commit releases every pending stop.
  async function startNewerRun(input: { companyId: string; ownerAgentId: string; issueId: string; tracked: boolean; takeLock?: boolean }) {
    const newerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: newerRunId,
      companyId: input.companyId,
      agentId: input.ownerAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      runtimeModeResolvedAt: new Date(),
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId, wakeReason: "issue_assigned" },
    });
    if (input.takeLock !== false) {
      await db.update(issues)
        .set({ executionRunId: newerRunId, executionAgentNameKey: "owner", executionLockedAt: new Date() })
        .where(eq(issues.id, input.issueId));
    }
    if (input.tracked) {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      children.push(child);
      runningProcesses.set(newerRunId, { child, graceSec: 1, processGroupId: null });
      await db.update(heartbeatRuns).set({ processPid: child.pid ?? null }).where(eq(heartbeatRuns.id, newerRunId));
    }
    return newerRunId;
  }

  async function acknowledgeStop(runId: string) {
    await db.update(heartbeatRuns).set({
      resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || '{"executionCancellation": {"state": "acknowledged"}}'::jsonb`,
    }).where(eq(heartbeatRuns.id, runId));
  }

  const handoffBody = (via: "plain" | "interrupt", successorAgentId: string, extra: Record<string, unknown> = {}) =>
    via === "interrupt" ? interruptHandoff(successorAgentId, extra) : { assigneeAgentId: successorAgentId, ...extra };
  // Stopping the newer run of a process adapter in a plain handoff opens a
  // reconciliation hold after the route read the active recovery action, so
  // the successor's wake waits behind that hold. An interrupt is an expected
  // cancellation and opens none. Either way the successor, and only the
  // successor, gets the one wake.
  const successorWake = (via: "plain" | "interrupt") =>
    [{ reason: via === "interrupt" ? "issue_assigned" : "execution_reconciliation_required" }];

  describe.each(["plain", "interrupt"] as const)("with a newer stopped run of the old owner (%s handoff)", (via) => {
    it.each(["run_stop_uncertain", "run_stop_unacknowledged"] as const)("refuses the retry on the older stop refused with %s", async (code) => {
      const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({
        liveRun: code === "run_stop_uncertain" ? "tracked" : "untracked",
      });
      if (code === "run_stop_uncertain") await addRemoteLease(companyId, issueId, runId);
      const app = createApp(companyId);
      const first = await request(app).patch(`/api/issues/${issueId}`).send(handoffBody(via, successorAgentId));
      expect(first.status).toBe(409);
      expect(first.body.details).toMatchObject({ code, runId });
      const newerRunId = await startNewerRun({ companyId, ownerAgentId, issueId, tracked: true });

      const retry = await request(app).patch(`/api/issues/${issueId}`).send(handoffBody(via, successorAgentId));

      expect(retry.status).toBe(409);
      expect(retry.body.details).toMatchObject({ code, runId });
      expect(await readRun(newerRunId)).toMatchObject({ status: "cancelled" });
      expect(await verifyOwnershipStop(db, await readRun(newerRunId))).toBe("stopped");
      expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, status: "in_progress", statusVersion: 0 });
      expect((await readRun(runId)).resultJson).toMatchObject({ reassignmentPendingIssueId: issueId });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await wakesFor(successorAgentId)).toEqual([]);
    });

    it.each(["run_stop_uncertain", "run_stop_unacknowledged"] as const)("commits the retry once the older stop refused with %s is verified", async (code) => {
      const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({
        liveRun: code === "run_stop_uncertain" ? "tracked" : "untracked",
      });
      const lease = code === "run_stop_uncertain" ? await addRemoteLease(companyId, issueId, runId) : null;
      const app = createApp(companyId);
      expect((await request(app).patch(`/api/issues/${issueId}`).send(handoffBody(via, successorAgentId))).status).toBe(409);
      const newerRunId = await startNewerRun({ companyId, ownerAgentId, issueId, tracked: true });

      if (lease) await recordRemoteTerminationReceipt(lease);
      else await acknowledgeStop(runId);
      const retry = await request(app).patch(`/api/issues/${issueId}`).send(handoffBody(via, successorAgentId));

      expect(retry.status).toBe(200);
      expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
      expect((await readRun(runId)).resultJson).toMatchObject({ reassignmentPendingIssueId: null });
      expect(parseResult((await readRun(newerRunId)).resultJson).reassignmentPendingIssueId ?? null).toBeNull();
      await expect.poll(() => wakesFor(successorAgentId)).toEqual(successorWake(via));
      expect(await wakesFor(ownerAgentId)).toEqual([]);
    });

    it("commits a board override of two unverified stops and records both in the reassignment activity", async () => {
      const { companyId, ownerAgentId, successorAgentId, issueId, runId } = await seed({ liveRun: "untracked" });
      const app = createApp(companyId);
      expect((await request(app).patch(`/api/issues/${issueId}`).send(handoffBody(via, successorAgentId))).status).toBe(409);
      const newerRunId = await startNewerRun({ companyId, ownerAgentId, issueId, tracked: false });

      const res = await request(app)
        .patch(`/api/issues/${issueId}`)
        .send(handoffBody(via, successorAgentId, { acceptUnverifiedStop: true }));

      expect(res.status).toBe(200);
      expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
      const [activity] = await db
        .select({ details: activityLog.details })
        .from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.updated")));
      const overrides = parseResult(activity?.details).unverifiedStopOverrides as Array<Record<string, unknown>>;
      expect(overrides).toHaveLength(2);
      expect(overrides).toEqual(expect.arrayContaining([runId, newerRunId].map((id) => ({
        runId: id,
        reason: "run_stop_unacknowledged",
        acceptedByActorType: "user",
        acceptedByActorId: "board-user",
      }))));
      for (const id of [runId, newerRunId]) {
        expect(parseResult((await readRun(id)).resultJson).reassignmentPendingIssueId ?? null).toBeNull();
      }
      await expect.poll(() => wakesFor(successorAgentId)).toEqual(successorWake(via));
      expect(await wakesFor(ownerAgentId)).toEqual([]);
    });
  });

  // The interrupt of a combined handoff cancels run R1 before the shared step
  // looks up the old owner's active run. When that lookup finds a second run
  // R2 (already running, or admitted in this same request), R1 must still be
  // verified on its own: stopping R2 does not prove R1 stopped.
  describe.each(["already running", "admitted in this request"] as const)("with a second old-owner run %s during an interrupting handoff", (when) => {
    async function patchWithSecondRun(input: { r1: "untracked" | "tracked"; remoteLease: boolean; r2Tracked: boolean }) {
      const seeded = await seed({ liveRun: input.r1 });
      const { companyId, ownerAgentId, successorAgentId, issueId, runId } = seeded;
      if (input.remoteLease) await addRemoteLease(companyId, issueId, runId);
      let secondRunId: string | null = null;
      let routeDb: typeof db = db;
      if (when === "already running") {
        secondRunId = await startNewerRun({ companyId, ownerAgentId, issueId, tracked: input.r2Tracked, takeLock: false });
      } else {
        routeDb = dbInjectingAfter(
          async () => (await readRun(runId)).status === "cancelled",
          async () => {
            secondRunId = await startNewerRun({ companyId, ownerAgentId, issueId, tracked: input.r2Tracked });
          },
        );
      }
      const res = await request(createApp(companyId, undefined, routeDb))
        .patch(`/api/issues/${issueId}`)
        .send(interruptHandoff(successorAgentId));
      expect(secondRunId).not.toBeNull();
      return { ...seeded, res, secondRunId: secondRunId! };
    }

    it.each(["run_stop_unacknowledged", "run_stop_uncertain"] as const)("refuses with %s for the interrupted run and changes nothing", async (code) => {
      const { res, ownerAgentId, successorAgentId, issueId, runId } = await patchWithSecondRun({
        r1: code === "run_stop_uncertain" ? "tracked" : "untracked",
        remoteLease: code === "run_stop_uncertain",
        r2Tracked: true,
      });

      expect(res.status).toBe(409);
      expect(res.body.details).toMatchObject({ code, runId });
      expect(await readIssue(issueId)).toMatchObject({ assigneeAgentId: ownerAgentId, status: "in_progress", statusVersion: 0 });
      const first = await readRun(runId);
      expect(first).toMatchObject({
        status: "cancelled",
        errorCode: "operator_interrupted",
        resultJson: expect.objectContaining({ reassignmentPendingIssueId: issueId }),
      });
      expect(await verifyOwnershipStop(db, first, { verificationTimeoutMs: 0 }))
        .toBe(code === "run_stop_uncertain" ? "uncertain" : "unacknowledged");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await wakesFor(successorAgentId)).toEqual([]);
    });

    it("commits when both the interrupted run and the second run acknowledged their stop", async () => {
      const { res, ownerAgentId, successorAgentId, issueId, runId, secondRunId } = await patchWithSecondRun({
        r1: "tracked",
        remoteLease: false,
        r2Tracked: true,
      });

      expect(res.status).toBe(200);
      expect((await readIssue(issueId)).assigneeAgentId).toBe(successorAgentId);
      for (const id of [runId, secondRunId]) {
        const run = await readRun(id);
        expect(run.status).toBe("cancelled");
        expect(await verifyOwnershipStop(db, run, { verificationTimeoutMs: 0 })).toBe("stopped");
        expect(parseResult(run.resultJson).reassignmentPendingIssueId ?? null).toBeNull();
      }
      await expect.poll(async () => (await wakesFor(successorAgentId)).length).toBe(1);
      expect(await wakesFor(ownerAgentId)).toEqual([]);
    });
  });
});
