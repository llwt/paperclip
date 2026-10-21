import type {
  Issue,
  PluginContext,
  PluginIssueExecutionDecision,
  PluginIssueExecutionDecisionsPage,
} from "@paperclipai/plugin-sdk";

export type Interaction = Awaited<ReturnType<PluginContext["issues"]["listInteractions"]>>[number];
type Policy = NonNullable<Issue["executionPolicy"]>;
type State = NonNullable<Issue["executionState"]>;
type Principal = NonNullable<State["currentParticipant"]>;
type Labels = PluginIssueExecutionDecisionsPage["principalLabels"];
export type ExecutionIssue = Partial<Pick<Issue, "executionPolicy" | "executionState">>;
export type ReadResult<T> = { status: "available"; value: T } | { status: "unavailable" };

export interface PrincipalView {
  type: "agent" | "user";
  id: string | null;
  name: string | null;
  displayName: string;
}

export type HeadShaEvidence =
  | { status: "not_recorded"; label: "Not recorded" }
  | { status: "reported"; label: "Reported head SHA"; sha: string; excerpts: string[] }
  | { status: "ambiguous"; label: "Ambiguous"; excerpts: string[] };

/** Only explicitly labeled, full hashes from this record's own text count. */
export function headShaEvidence(texts: Array<string | null | undefined>): HeadShaEvidence {
  const matches = texts.flatMap((text) => [...(text ?? "").matchAll(/\bHead SHA:[ \t]*([a-fA-F0-9]{40})(?![\w-])/g)]);
  const hashes = new Set(matches.map((match) => match[1].toLowerCase()));
  const excerpts = matches.map((match) => match[0]);
  if (hashes.size === 0) return { status: "not_recorded", label: "Not recorded" };
  if (hashes.size > 1) return { status: "ambiguous", label: "Ambiguous", excerpts };
  return { status: "reported", label: "Reported head SHA", sha: [...hashes][0], excerpts };
}

function principalView(principal: Principal | null, labels: Labels): PrincipalView | null {
  if (!principal) return null;
  const id = (principal.type === "agent" ? principal.agentId : principal.userId) ?? null;
  const name = id ? labels[`${principal.type}:${id}`]?.label ?? null : null;
  return { type: principal.type, id, name, displayName: name || id || "Unknown principal" };
}

function actors(agentId: string | null | undefined, userId: string | null | undefined, labels: Labels): PrincipalView[] {
  return [
    ...(agentId ? [principalView({ type: "agent", agentId }, labels)!] : []),
    ...(userId ? [principalView({ type: "user", userId }, labels)!] : []),
  ];
}

export interface DecisionView {
  id: string;
  stageId: string;
  stageType: PluginIssueExecutionDecision["stageType"];
  outcome: PluginIssueExecutionDecision["outcome"];
  label: "Approved" | "Changes requested";
  actors: PrincipalView[];
  createdAt: string;
  body: string;
  headSha: HeadShaEvidence;
}

export interface StageView {
  id: string;
  type: Policy["stages"][number]["type"];
  participants: Array<{ id: string; principal: PrincipalView }>;
  status: "Pending" | "Completed" | "Changes requested" | "Not current";
  decisions: DecisionView[];
}

export interface ConfirmationView {
  id: string;
  kind: "request_confirmation" | "request_checkbox_confirmation" | "request_item_verdicts";
  status: Interaction["status"];
  outcome: string | null;
  prompt: string;
  details: string | null;
  target: { type: string; key: string; revisionId: string | null; label: string | null } | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvers: PrincipalView[];
  reason: string | null;
  selectedOptionIds: string[];
  options: Array<{ id: string; label: string; description: string | null }>;
  items: Array<{
    id: string;
    label: string;
    description: string | null;
    verdict: "approve" | "reject" | "defer" | null;
    reason: string | null;
    resolvers: PrincipalView[];
    resolvedAt: string | null;
  }>;
  complete: boolean | null;
  headSha: HeadShaEvidence;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function confirmationView(card: Interaction, labels: Labels): ConfirmationView | null {
  if (card.kind !== "request_confirmation" && card.kind !== "request_checkbox_confirmation" && card.kind !== "request_item_verdicts") return null;
  // Authorization cards belong to their own host flow, even when represented as confirmations.
  if ("toolAction" in card.payload || "secretProposal" in card.payload || "connectionAuthorization" in card.payload) return null;
  const target = card.payload.target;
  return {
    id: card.id,
    kind: card.kind,
    status: card.status,
    outcome: card.result?.outcome ?? null,
    prompt: card.payload.prompt,
    details: card.payload.detailsMarkdown ?? null,
    target: target ? { type: target.type, key: target.key, revisionId: target.revisionId ?? null, label: target.label ?? null } : null,
    createdAt: iso(card.createdAt),
    resolvedAt: card.resolvedAt ? iso(card.resolvedAt) : null,
    resolvers: actors(card.resolvedByAgentId, card.resolvedByUserId, labels),
    reason: card.result?.reason ?? null,
    selectedOptionIds: card.kind === "request_checkbox_confirmation" ? card.result?.selectedOptionIds ?? [] : [],
    options: card.kind === "request_checkbox_confirmation" ? card.payload.options.map((option) => ({
      id: option.id, label: option.label, description: option.description ?? null,
    })) : [],
    items: card.kind === "request_item_verdicts" ? card.payload.items.map((item) => {
      const verdict = card.result?.items.find((result) => result.id === item.id);
      return {
        id: item.id, label: item.label, description: item.description ?? null,
        verdict: verdict?.verdict ?? null, reason: verdict?.reason ?? null,
        resolvers: actors(verdict?.resolvedByAgentId, verdict?.resolvedByUserId, labels),
        resolvedAt: verdict ? iso(verdict.resolvedAt) : null,
      };
    }) : [],
    complete: card.kind === "request_item_verdicts" ? card.result?.complete ?? null : null,
    headSha: headShaEvidence([card.payload.prompt, card.payload.detailsMarkdown]),
  };
}

export interface ExecutionFlowView {
  execution: {
    status: "available" | "unavailable";
    message: "Execution data unavailable" | "No execution stages configured" | null;
    stateStatus: State["status"] | null;
    currentStageId: string | null;
    recordedCurrentParticipant: PrincipalView | null;
    currentHolder: PrincipalView | null;
    returnAssignee: PrincipalView | null;
    workReturned: boolean;
    warnings: string[];
    stages: StageView[];
  };
  history: {
    status: "available" | "unavailable";
    message: "Decision history unavailable" | null;
    label: "Recorded decisions";
    notice: string;
    requestedCursor: string | null;
    nextCursor: string | null;
    hasMore: boolean | null;
    decisions: DecisionView[];
    formerStagesLabel: "Stages no longer in the current policy";
    formerStages: Array<{ id: string; decisions: DecisionView[] }>;
    unclassifiedDecisions: DecisionView[];
  };
  confirmations: {
    status: "available" | "unavailable";
    label: "Task confirmations";
    message: "Task confirmations unavailable" | null;
    items: ConfirmationView[];
  };
}

export function buildExecutionFlow(input: {
  issue: ExecutionIssue;
  history: ReadResult<PluginIssueExecutionDecisionsPage>;
  interactions: ReadResult<Interaction[]>;
  requestedCursor?: string;
}): ExecutionFlowView {
  const { issue, history, interactions } = input;
  const labels = history.status === "available" ? history.value.principalLabels : {};
  const available = issue.executionPolicy !== undefined && issue.executionState !== undefined;
  const policyStages = issue.executionPolicy?.stages ?? [];
  const state = issue.executionState;
  const stageIds = new Set(policyStages.map((stage) => stage.id));
  const decisions: DecisionView[] = history.status === "available" ? history.value.items.map((decision) => ({
    id: decision.id, stageId: decision.stageId, stageType: decision.stageType,
    outcome: decision.outcome, label: decision.outcome === "approved" ? "Approved" : "Changes requested",
    actors: actors(decision.actorAgentId, decision.actorUserId, labels),
    createdAt: iso(decision.createdAt), body: decision.body, headSha: headShaEvidence([decision.body]),
  })) : [];
  const currentParticipant = principalView(state?.currentParticipant ?? null, labels);
  const returnAssignee = principalView(state?.returnAssignee ?? null, labels);
  const workReturned = state?.status === "changes_requested";
  const warnings: string[] = [];
  if (state?.currentStageId && !stageIds.has(state.currentStageId)) warnings.push(`Current stage is not in the current policy: ${state.currentStageId}`);
  for (const id of state?.completedStageIds ?? []) {
    if (!stageIds.has(id)) warnings.push(`Completed stage is not in the current policy: ${id}`);
  }
  if (state?.currentStageId && state.currentStageIndex !== null && policyStages[state.currentStageIndex]?.id !== state.currentStageId) warnings.push("Current stage ID and index disagree");
  if (state?.currentStageId && state.currentStageType !== null && policyStages.find((stage) => stage.id === state.currentStageId)?.type !== state.currentStageType) warnings.push("Current stage ID and type disagree");
  if (state?.status === "pending" && (!state.currentStageId || !currentParticipant)) warnings.push("Pending execution has no current stage or participant");
  if (workReturned && !returnAssignee) warnings.push("Changes requested has no return assignee");
  if (state?.currentStageId && state.completedStageIds.includes(state.currentStageId)) warnings.push("Current stage is also marked completed");
  const formerStages = new Map<string, DecisionView[]>();
  if (issue.executionPolicy !== undefined) {
    for (const decision of decisions) {
      if (stageIds.has(decision.stageId)) continue;
      const entries = formerStages.get(decision.stageId) ?? [];
      entries.push(decision);
      formerStages.set(decision.stageId, entries);
    }
  }
  return {
    execution: {
      status: available ? "available" : "unavailable",
      message: !available ? "Execution data unavailable" : policyStages.length === 0 ? "No execution stages configured" : null,
      stateStatus: state?.status ?? null,
      currentStageId: state?.currentStageId ?? null,
      recordedCurrentParticipant: currentParticipant,
      currentHolder: workReturned ? returnAssignee : state?.status === "pending" ? currentParticipant : null,
      returnAssignee,
      workReturned,
      warnings,
      stages: policyStages.map((stage) => ({
        id: stage.id, type: stage.type,
        participants: stage.participants.map((participant) => ({ id: participant.id, principal: principalView(participant, labels)! })),
        status: state?.completedStageIds.includes(stage.id) ? "Completed" : state?.currentStageId === stage.id && workReturned ? "Changes requested" : state?.currentStageId === stage.id && state?.status === "pending" ? "Pending" : "Not current",
        decisions: decisions.filter((decision) => decision.stageId === stage.id),
      })),
    },
    history: {
      status: history.status,
      message: history.status === "unavailable" ? "Decision history unavailable" : null,
      label: "Recorded decisions",
      notice: "Retained records only. Deleted decisions and former policy participants cannot be recovered. Names are current display labels.",
      requestedCursor: input.requestedCursor ?? null,
      nextCursor: history.status === "available" ? history.value.nextCursor : null,
      hasMore: history.status === "available" ? history.value.nextCursor !== null : null,
      decisions,
      formerStagesLabel: "Stages no longer in the current policy",
      formerStages: [...formerStages].map(([id, entries]) => ({ id, decisions: entries })),
      unclassifiedDecisions: issue.executionPolicy === undefined ? decisions : [],
    },
    confirmations: {
      status: interactions.status,
      label: "Task confirmations",
      message: interactions.status === "unavailable" ? "Task confirmations unavailable" : null,
      items: interactions.status === "available" ? interactions.value.flatMap((card) => {
        const view = confirmationView(card, labels);
        return view ? [view] : [];
      }) : [],
    },
  };
}
