import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, type Db } from "@paperclipai/db";
import { parseObject } from "../adapters/utils.js";
import { conflict } from "../errors.js";
import {
  acknowledgedNativeReassignmentStopExecutionHasStopped,
  acknowledgedNativeStopExecutionHasStopped,
  hasAcknowledgedNativeReassignmentStopIntent,
  hasAcknowledgedNativeStopIntent,
} from "./acknowledged-native-stop.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";

// The shared assignment step. One ownership change stops the old executor,
// commits the new owner under the issue lock, and builds one guarded wake.
// Two agents must never execute one issue: every uncertain step fails closed
// and leaves the current owner in place.

type HeartbeatRunRow = typeof heartbeatRuns.$inferSelect;

export type AssignmentActor = {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
  agentApiKeyId?: string | null;
  responsibleUserId?: string | null;
};

/** Snapshot captured before the stop; compared under the issue lock. */
export type AssignmentExpectation = {
  issueId: string;
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: string;
  statusVersion: number;
  executionRunId: string | null;
};

export type StopReceipt =
  | { kind: "none" }
  | { kind: "stopped"; interruptedRunId: string; issueMutationStopId: string };

export type OwnershipStopVerdict = "stopped" | "unacknowledged" | "uncertain";

const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "timed_out"]);
const NATIVE_STOP_VERIFICATION_TIMEOUT_MS = 3_000;
const NATIVE_STOP_VERIFICATION_POLL_MS = 100;

/**
 * A `cancelled` row is not a stop receipt: for an untracked process or a
 * native session this server does not hold, cancellation only flips the row.
 * Accept a stop only when the executor acknowledged it and, for native and
 * remote execution, its leases and processes are verified gone.
 */
export async function verifyOwnershipStop(
  db: Db,
  run: HeartbeatRunRow,
  options: { verificationTimeoutMs?: number } = {},
): Promise<OwnershipStopVerdict> {
  if (run.status !== "cancelled") return "unacknowledged";
  if (run.runtimeMode === "native") {
    const reassignment = hasAcknowledgedNativeReassignmentStopIntent(run);
    if (!reassignment && !hasAcknowledgedNativeStopIntent(run)) return "unacknowledged";
    const deadline = Date.now() + (options.verificationTimeoutMs ?? NATIVE_STOP_VERIFICATION_TIMEOUT_MS);
    for (;;) {
      const current = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null);
      if (!current) return "uncertain";
      const stopped = reassignment
        ? await acknowledgedNativeReassignmentStopExecutionHasStopped(db, current)
        : await acknowledgedNativeStopExecutionHasStopped(db, current);
      if (stopped) return "stopped";
      // Cleanup can finish shortly after the acknowledgement. Wait a bounded
      // time without any row lock, then fail closed.
      if (Date.now() >= deadline) return "uncertain";
      await new Promise<void>((resolve) => setTimeout(resolve, NATIVE_STOP_VERIFICATION_POLL_MS));
    }
  }
  if (parseObject(parseObject(run.resultJson).executionCancellation).state !== "acknowledged") {
    return "unacknowledged";
  }
  // Killing the local bridge of a remote execution target does not prove the
  // remote provider stopped. Require its termination receipt.
  const leases = await db
    .select()
    .from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  if (leases.some((lease) => lease.provider !== "local" && !hasRemoteTerminationReceipt(lease))) {
    return "uncertain";
  }
  return "stopped";
}

export type OwnershipStopDeps = {
  db: Db;
  heartbeat: {
    cancelRun: (
      runId: string,
      reason?: string,
      options?: {
        errorCode?: string;
        resultJson?: Record<string, unknown>;
        eventMessage?: string;
        eventPayload?: Record<string, unknown>;
        suppressImmediateRecovery?: boolean;
      },
    ) => Promise<HeartbeatRunRow | null>;
    getRun: (runId: string) => Promise<HeartbeatRunRow | null>;
  };
  /** Pauses or clears the old owner's runner goal and waits for it. */
  stopRunnerGoal: (input: { companyId: string; issueId: string; agentId: string }) => Promise<unknown>;
  /** The old owner's live run on this issue, if any. */
  resolveActiveRun: (expectation: AssignmentExpectation) => Promise<{ id: string } | null>;
};

function assertStopVerified(verdict: OwnershipStopVerdict, runId: string) {
  if (verdict === "unacknowledged") {
    throw conflict(
      "The active agent run was cancelled, but its executor did not acknowledge the stop. The assignee was not changed.",
      { code: "run_stop_unacknowledged", runId },
    );
  }
  if (verdict === "uncertain") {
    throw conflict(
      "The active agent run was cancelled, but its execution could not be verified as stopped. The assignee was not changed.",
      { code: "run_stop_uncertain", runId },
    );
  }
}

/**
 * Stops the old owner's execution before an ownership change. Holds no row
 * lock while it waits for the runner goal or the provider. `interruptedRunId`
 * is a run an operator interrupt already stopped in this request; it must
 * carry the same acknowledgement.
 */
export async function stopIssueExecutionForOwnershipChange(
  deps: OwnershipStopDeps,
  input: {
    expectation: AssignmentExpectation;
    issueMutationStopId: string;
    interruptedRunId?: string | null;
  },
): Promise<StopReceipt> {
  const { expectation, issueMutationStopId } = input;
  const verifyEarlierStop = async (runId: string): Promise<StopReceipt> => {
    const stopped = await deps.heartbeat.getRun(runId);
    if (!stopped) {
      throw conflict("The interrupted agent run could not be found before reassignment", {
        code: "runner_goal_reassignment_stop_unconfirmed",
        runId,
      });
    }
    // A run that already ended on its own was not stopped by this request,
    // and its executor finalized it.
    if (stopped.status !== "cancelled" && TERMINAL_RUN_STATUSES.has(stopped.status)) {
      return { kind: "stopped", interruptedRunId: runId, issueMutationStopId };
    }
    assertStopVerified(await verifyOwnershipStop(deps.db, stopped), runId);
    return { kind: "stopped", interruptedRunId: runId, issueMutationStopId };
  };
  if (!expectation.assigneeAgentId) {
    return input.interruptedRunId ? verifyEarlierStop(input.interruptedRunId) : { kind: "none" };
  }
  await deps.stopRunnerGoal({
    companyId: expectation.companyId,
    issueId: expectation.issueId,
    agentId: expectation.assigneeAgentId,
  });
  const runToStop = await deps.resolveActiveRun(expectation);
  if (!runToStop) {
    return input.interruptedRunId ? verifyEarlierStop(input.interruptedRunId) : { kind: "none" };
  }
  const cancelled = await deps.heartbeat.cancelRun(runToStop.id, "Cancelled before issue reassignment", {
    errorCode: "issue_reassigned",
    resultJson: { reassignmentStopConfirmed: true, issueMutationStopId },
    eventMessage: "run cancelled before issue reassignment",
    eventPayload: { issueId: expectation.issueId },
    // The old owner is still assigned until the commit. A recovery run queued
    // now would be bound to it and could start before the successor.
    suppressImmediateRecovery: true,
  });
  if (!cancelled || cancelled.status !== "cancelled") {
    throw conflict("The active agent run could not be stopped before reassignment", {
      code: "runner_goal_reassignment_stop_unconfirmed",
      runId: runToStop.id,
    });
  }
  assertStopVerified(await verifyOwnershipStop(deps.db, cancelled), cancelled.id);
  return { kind: "stopped", interruptedRunId: cancelled.id, issueMutationStopId };
}

export type AssignmentWakeup = {
  source: "assignment";
  triggerDetail: "system";
  reason: "issue_assigned";
  payload: Record<string, unknown>;
  requestedByActorType: "user" | "agent";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
  issueStateGuard: { assigneeAgentId: string; statuses: string[]; statusVersion: number };
  idempotencyKey: string;
};

/**
 * Pure. Builds the normal `issue_assigned` wake for a committed assignment.
 * The guard binds it to the committed owner and version, so a later
 * reassignment makes it stale at admission.
 */
export function buildAssignmentWakeup(input: {
  issue: { id: string; assigneeAgentId: string | null; status: string; statusVersion: number };
  commentId: string | null;
  interruptedRunId: string | null;
  actor: Pick<AssignmentActor, "actorType" | "actorId">;
  resumeRequested?: boolean;
}): { agentId: string; wakeup: AssignmentWakeup } | null {
  const { issue, commentId, interruptedRunId } = input;
  if (!issue.assigneeAgentId) return null;
  const resume = input.resumeRequested === true ? { resumeIntent: true, followUpRequested: true } : {};
  return {
    agentId: issue.assigneeAgentId,
    wakeup: {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId: issue.id,
        ...(commentId ? { commentId } : {}),
        mutation: "update",
        ...resume,
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
      requestedByActorType: input.actor.actorType,
      requestedByActorId: input.actor.actorId,
      contextSnapshot: {
        issueId: issue.id,
        ...(commentId ? { taskId: issue.id, commentId, wakeCommentId: commentId } : {}),
        source: "issue.update",
        ...resume,
        ...(interruptedRunId ? { interruptedRunId } : {}),
      },
      issueStateGuard: {
        assigneeAgentId: issue.assigneeAgentId,
        // An explicit assignment may target a blocked or in-review issue; the
        // committed status stays valid. The version pins the ownership change.
        statuses: [...new Set(["todo", "in_progress", issue.status])],
        statusVersion: issue.statusVersion,
      },
      idempotencyKey: `issue-assigned:${issue.id}:${issue.statusVersion}:${commentId ?? "none"}`,
    },
  };
}

/**
 * Runs inside `issueService.update` on the ownership commit's transaction,
 * after the issue row is locked, so runs are locked second (issue-before-run
 * order). Fails closed when a run other than the one this request stopped is
 * executing the issue for the old owner: a recovery or promoted run that
 * started after the stop. It is not cancelled here, so there is no
 * cancel-and-retry loop. Queued and scheduled holders are left to the claim
 * and promotion guards, which cancel them against the committed owner.
 */
export async function assertNoLiveRunForPreviousOwner(
  tx: Db,
  input: {
    companyId: string;
    issueId: string;
    previousAssigneeAgentId: string | null;
    executionRunId: string | null;
    checkoutRunId: string | null;
    stoppedRunId: string | null;
  },
): Promise<void> {
  const holderIds = [input.executionRunId, input.checkoutRunId].filter((id): id is string => Boolean(id));
  const ownedByIssue = [
    ...(holderIds.length > 0 ? [inArray(heartbeatRuns.id, holderIds)] : []),
    ...(input.previousAssigneeAgentId
      ? [and(
          eq(heartbeatRuns.agentId, input.previousAssigneeAgentId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${input.issueId}`,
        )]
      : []),
  ];
  if (ownedByIssue.length === 0) return;
  const live = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.status, "running"),
      or(...ownedByIssue),
      ...(input.stoppedRunId ? [ne(heartbeatRuns.id, input.stoppedRunId)] : []),
    ))
    .for("update");
  if (live.length > 0) {
    throw conflict("Another agent run started on this issue before the reassignment committed. The assignee was not changed.", {
      code: "issue_state_changed",
      runId: live[0]!.id,
    });
  }
}
