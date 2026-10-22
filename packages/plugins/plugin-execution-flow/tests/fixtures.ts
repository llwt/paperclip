import type { Issue, PluginIssueExecutionDecision, PluginIssueExecutionDecisionsPage } from "@paperclipai/plugin-sdk";
import type { ExecutionIssue, Interaction } from "../src/model.js";

export const timestamp = "2026-10-21T12:00:00.000Z";
export const sha = "abcdef0123456789abcdef0123456789abcdef01";
export const otherSha = "1234567890abcdef1234567890abcdef12345678";
export const agent = (agentId: string) => ({ type: "agent" as const, agentId });
export const user = (userId: string) => ({ type: "user" as const, userId });
export function stage(id: string, type: "review" | "approval" = "review") {
  return { id, type, approvalsNeeded: 1 as const, participants: [{ id: `${id}-participant`, ...agent("reviewer") }] };
}
export function issue(stages = [stage("review"), stage("approve", "approval")]): ExecutionIssue {
  return {
    executionPolicy: { mode: "normal", commentRequired: true, stages },
    executionState: {
      status: "pending", currentStageId: stages[0]?.id ?? null, currentStageIndex: stages.length ? 0 : null,
      currentStageType: stages[0]?.type ?? null, currentParticipant: agent("reviewer"),
      returnAssignee: agent("author"), reviewRequest: null, completedStageIds: [],
      lastDecisionId: null, lastDecisionOutcome: null,
    },
  };
}
export function hostIssue(): Issue {
  return { ...issue(), id: "issue", companyId: "company", title: "Do not return this", description: "Unrelated private data" } as Issue;
}
export function decision(id = "decision", overrides: Partial<PluginIssueExecutionDecision> = {}): PluginIssueExecutionDecision {
  return {
    id, companyId: "company", issueId: "issue", stageId: "review", stageType: "review",
    actorAgentId: "reviewer", actorUserId: null, outcome: "approved", body: "Reviewed",
    createdByRunId: "run", createdAt: timestamp, updatedAt: timestamp, ...overrides,
  };
}
export function page(items: PluginIssueExecutionDecision[] = []): PluginIssueExecutionDecisionsPage {
  return { items, nextCursor: null, principalLabels: { "agent:reviewer": { type: "agent", id: "reviewer", label: "Reviewer" } } };
}
export function card(id = "card", overrides: Partial<Extract<Interaction, { kind: "request_confirmation" }>> = {}): Extract<Interaction, { kind: "request_confirmation" }> {
  return {
    id, companyId: "company", issueId: "issue", kind: "request_confirmation",
    status: "pending", continuationPolicy: "none", resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone", effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "explicit", effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: { requested: null, effective: null },
    createdAt: timestamp, updatedAt: timestamp, payload: { version: 1, prompt: "Confirm?" }, ...overrides,
  };
}
