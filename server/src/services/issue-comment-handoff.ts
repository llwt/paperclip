import { and, eq, inArray, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  approvals,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  type Db,
} from "@paperclipai/db";
import {
  ISSUE_COMMENT_HANDOFF_STATUSES,
  describeIssueCommentHandoffReason,
  type IssueCommentHandoffReasonCode,
  type IssueCommentHandoffReceipt,
  type IssueCommentMetadata,
  type IssueStatus,
  type LeadingAgentMention,
} from "@paperclipai/shared";
import { HttpError } from "../errors.js";
import { assertAssignableAgent } from "./agent-assignability.js";
import { executionBlockerPredicate } from "./execution-blocker.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueTreeControlService } from "./issue-tree-control.js";

/**
 * Leading agent mention handoff: eligibility and result construction (fork,
 * SX-1178, plan sections "Author, target and status" and "Gates and refusal
 * result"). Inert: no route calls this yet. PR 3 runs `decideCommentHandoff`
 * once before stopping the old run and again under the final issue lock, then
 * compares the two with `recheckCommentHandoff`.
 */

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Tx = Db | DbTransaction;

export type HandoffReasonCode = IssueCommentHandoffReasonCode;

export type HandoffDecision =
  | { outcome: "assigned"; targetAgentId: string }
  | { outcome: "context_only"; reasonCode: HandoffReasonCode; targetAgentId: string | null }
  | { outcome: "unchanged" }; // no leading candidate, or same assignee

export type HandoffCandidate = { targetAgentId: string } | { ambiguous: true } | null;

/** Same shape as the assignment actor of the PR 1 assignment command. */
export type HandoffActor = {
  actorType: "user" | "agent";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

/** Issue snapshot the decision reads. The first fields match PR 1's assignment expectation. */
export type HandoffIssueState = {
  issueId: string;
  companyId: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  status: IssueStatus;
  statusVersion: number;
  executionRunId: string | null;
  executionState: unknown;
  conversationAgentId: string | null;
  /** Non-null when a plugin or another workflow owns the issue lifecycle (see `issueLifecycleOwner`). */
  lifecycleOwner: string | null;
};

export type HandoffGateFacts = {
  /** A review/approval stage is pending, or the execution state is unreadable. */
  pendingStage: boolean;
  pendingConfirmation: boolean;
  /** Any other pending thread interaction (questions, suggested tasks, verdicts, connection intents). */
  pendingInteraction: boolean;
  /** A resolved card whose response continuation is still queued or deferred for any agent. */
  queuedInteractionResponse: boolean;
  pendingApproval: boolean;
  recoveryHold: boolean;
  pauseHold: boolean;
};

export type CommentHandoffDeps = {
  isTargetAssignable: (tx: Tx, companyId: string, agentId: string) => Promise<boolean>;
  readGates: (tx: Tx, issue: Pick<HandoffIssueState, "companyId" | "issueId" | "executionState">) => Promise<HandoffGateFacts>;
};

const CONFIRMATION_INTERACTION_KINDS = new Set(["request_confirmation", "request_checkbox_confirmation"]);
const HANDOFF_STATUSES = new Set<string>(ISSUE_COMMENT_HANDOFF_STATUSES);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `assertAssignableAgent` policy denials: unknown (404), ineligible (409), foreign (422). */
const ASSIGNABILITY_DENIAL_STATUSES = new Set([404, 409, 422]);

export function toHandoffCandidate(mention: LeadingAgentMention): HandoffCandidate {
  if (mention.kind === "target") return { targetAgentId: mention.agentId };
  if (mention.kind === "ambiguous") return { ambiguous: true };
  return null;
}

/** Plugin-created issues keep their own lifecycle; a mention never takes them over. */
export function issueLifecycleOwner(issue: { originKind: string | null }): string | null {
  return issue.originKind?.startsWith("plugin:") ? issue.originKind : null;
}

export async function isHandoffTargetAssignable(tx: Tx, companyId: string, agentId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return false;
  try {
    await assertAssignableAgent(tx as Db, companyId, agentId);
    return true;
  } catch (error) {
    // Unknown, foreign, terminated and pending-approval targets all read the same.
    // Anything else (database, network) is an infrastructure failure and propagates.
    if (error instanceof HttpError && ASSIGNABILITY_DENIAL_STATUSES.has(error.status)) return false;
    throw error;
  }
}

/** Gate reads for the decision. Run on the caller's transaction so the final check sees locked state. */
export async function readCommentHandoffGates(
  tx: Tx,
  issue: Pick<HandoffIssueState, "companyId" | "issueId" | "executionState">,
): Promise<HandoffGateFacts> {
  const { companyId, issueId } = issue;
  const executionState = parseIssueExecutionState(issue.executionState);
  // Drifted or malformed execution state fails closed.
  const pendingStage = issue.executionState != null && (!executionState || executionState.status === "pending");

  const interactions = await tx
    .select({ kind: issueThreadInteractions.kind })
    .from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, companyId),
      eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.status, "pending"),
    ));
  const pendingConfirmation = interactions.some((row) => CONFIRMATION_INTERACTION_KINDS.has(row.kind));
  const pendingInteraction = interactions.some((row) => !CONFIRMATION_INTERACTION_KINDS.has(row.kind));

  // A card leaves "pending" before its response continuation runs. Same join as
  // `hasQueuedInteractionResponse`, but for any agent (the current owner included)
  // and on the caller's transaction.
  const [queuedResponse] = await tx
    .select({ id: agentWakeupRequests.id })
    .from(agentWakeupRequests)
    .innerJoin(issueThreadInteractions, and(
      eq(issueThreadInteractions.companyId, agentWakeupRequests.companyId),
      sql`${issueThreadInteractions.id}::text = ${agentWakeupRequests.payload}->>'interactionId'`,
      eq(issueThreadInteractions.issueId, issueId),
      inArray(issueThreadInteractions.status, ["accepted", "answered", "rejected"]),
    ))
    .where(and(
      eq(agentWakeupRequests.companyId, companyId),
      inArray(agentWakeupRequests.status, ["deferred_issue_execution", "queued"]),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
      sql`${agentWakeupRequests.payload}->>'mutation' = 'interaction'`,
    ))
    .limit(1);

  const [approval] = await tx
    .select({ id: approvals.id })
    .from(issueApprovals)
    .innerJoin(approvals, and(eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, companyId)))
    .where(and(
      eq(issueApprovals.companyId, companyId),
      eq(issueApprovals.issueId, issueId),
      inArray(approvals.status, ["pending", "revision_requested"]),
    ))
    .limit(1);

  const [recovery] = await tx
    .select({ id: issueRecoveryActions.id })
    .from(issueRecoveryActions)
    .where(and(
      eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, issueId),
      executionBlockerPredicate(),
    ))
    .limit(1);

  const pauseHold = await issueTreeControlService(tx as Db).getActivePauseHoldGate(companyId, issueId);

  return {
    pendingStage,
    pendingConfirmation,
    pendingInteraction,
    queuedInteractionResponse: Boolean(queuedResponse),
    pendingApproval: Boolean(approval),
    recoveryHold: Boolean(recovery),
    pauseHold: Boolean(pauseHold),
  };
}

const defaultDeps: CommentHandoffDeps = {
  isTargetAssignable: isHandoffTargetAssignable,
  readGates: readCommentHandoffGates,
};

/**
 * Decide what a comment's leading mention does. Never mutates. Gate reads run
 * on `tx`. The order is: candidate, same assignee, explicit mutation, author,
 * target, lifecycle, status, gates, assignment permission.
 */
export async function decideCommentHandoff(
  tx: Tx,
  input: {
    companyId: string;
    issue: HandoffIssueState;
    actor: HandoffActor;
    candidate: HandoffCandidate;
    /** PATCH carried assignee, status, decision, resume or reopen. */
    explicitMutation: boolean;
    /** Route-provided `tasks:assign` check with the destination scope. */
    canAssign: (targetAgentId: string) => Promise<boolean>;
  },
  deps: CommentHandoffDeps = defaultDeps,
): Promise<HandoffDecision> {
  const { candidate, issue, actor } = input;
  if (!candidate) return { outcome: "unchanged" };
  if ("ambiguous" in candidate) {
    return { outcome: "context_only", reasonCode: "ambiguous_prefix", targetAgentId: null };
  }
  const targetAgentId = candidate.targetAgentId;
  if (issue.companyId !== input.companyId) {
    return { outcome: "context_only", reasonCode: "target_unavailable", targetAgentId: null };
  }
  if (targetAgentId === issue.assigneeAgentId) return { outcome: "unchanged" };

  // Until the target resolves in this company its id is not echoed back.
  const refuse = (reasonCode: HandoffReasonCode, resolved = true): HandoffDecision => ({
    outcome: "context_only",
    reasonCode,
    targetAgentId: resolved ? targetAgentId : null,
  });

  if (input.explicitMutation) return refuse("explicit_mutation", false);

  // Mention-scoped access, seniority and onBehalfOfUserId do not count.
  const isBoard = actor.actorType === "user";
  const isCurrentAssignee = actor.actorType === "agent" && actor.agentId !== null && actor.agentId === issue.assigneeAgentId;
  if (!isBoard && !isCurrentAssignee) return refuse("author_not_assignee", false);

  if (!(await deps.isTargetAssignable(tx, input.companyId, targetAgentId))) {
    return refuse("target_unavailable", false);
  }

  if (issue.conversationAgentId || issue.lifecycleOwner) return refuse("lifecycle_owned");
  if (!HANDOFF_STATUSES.has(issue.status)) return refuse("status_requires_explicit_action");

  const gates = await deps.readGates(tx, issue);
  if (gates.pauseHold || gates.recoveryHold) return refuse("lifecycle_owned");
  if (gates.pendingStage) return refuse("review_pending");
  if (gates.pendingConfirmation) return refuse("confirmation_pending");
  if (gates.pendingInteraction || gates.queuedInteractionResponse || gates.pendingApproval) {
    return refuse("interaction_pending");
  }

  if (!(await input.canAssign(targetAgentId))) return refuse("assignment_not_allowed");

  return { outcome: "assigned", targetAgentId };
}

/**
 * Compare the decision made before the stop with the one made under the final
 * lock. Only an unchanged "assigned" answer may commit.
 */
export function recheckCommentHandoff(preflight: HandoffDecision, locked: HandoffDecision): HandoffDecision {
  if (preflight.outcome !== "assigned") return preflight;
  if (locked.outcome === "assigned" && locked.targetAgentId === preflight.targetAgentId) return locked;
  return { outcome: "context_only", reasonCode: "state_changed", targetAgentId: preflight.targetAgentId };
}

/** Build the server-authored `metadata.handoff` receipt and its human-readable section. */
export function buildHandoffReceipt(input: {
  decision: HandoffDecision;
  committed?: { statusVersion: number; interruptedRunId: string | null };
}): { metadata: IssueCommentMetadata; summary: string } {
  const { decision } = input;
  let handoff: IssueCommentHandoffReceipt;
  let summary: string;
  if (decision.outcome === "assigned") {
    if (!input.committed) throw new Error("An assigned handoff receipt requires the committed assignment");
    const { statusVersion, interruptedRunId } = input.committed;
    handoff = {
      version: 1,
      outcome: "assigned",
      targetAgentId: decision.targetAgentId,
      statusVersion,
      ...(interruptedRunId ? { interruptedRunId } : {}),
    };
    summary = interruptedRunId
      ? "Comment saved. Stopped the current run and handed this task to the mentioned agent."
      : "Comment saved. Handed this task to the mentioned agent.";
  } else if (decision.outcome === "context_only") {
    handoff = {
      version: 1,
      outcome: "context_only",
      reasonCode: decision.reasonCode,
      ...(decision.targetAgentId ? { targetAgentId: decision.targetAgentId } : {}),
    };
    summary = `Comment saved. No handoff: ${describeIssueCommentHandoffReason(decision.reasonCode)}.`;
  } else {
    handoff = { version: 1, outcome: "unchanged" };
    summary = "Comment saved. No ownership change.";
  }
  return {
    metadata: {
      version: 1,
      handoff,
      sections: [{ title: "Handoff", rows: [{ type: "text", text: summary }] }],
    },
    summary,
  };
}
