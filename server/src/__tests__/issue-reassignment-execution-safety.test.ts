import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
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
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { buildAssignmentWakeup } from "../services/issue-assignment.ts";

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

describeEmbeddedPostgres("issue reassignment execution safety", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("issue-reassignment-execution-safety-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(issueComments);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(nativeRunFinalizations);
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

  function createApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "admin", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  async function seed(input: { liveRun?: "untracked" | "native" | "none" } = {}) {
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
    const statusesSeen: string[] = [];
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
    const events = await db
      .select({ eventType: heartbeatRunEvents.eventType, message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, queuedRunId), inArray(heartbeatRunEvents.eventType, ["adapter.invoke"])));
    statusesSeen.push(...events.map((event) => event.eventType));
    expect(statusesSeen).toEqual([]);
    expect((await readIssue(issueId)).executionRunId).toBeNull();
  });
});
