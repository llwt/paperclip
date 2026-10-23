import type { DecisionView, ExecutionFlowResponse, PrincipalView } from "../model.js";

export interface Snapshot {
  view: ExecutionFlowResponse;
  decisions: DecisionView[];
  nextCursor: string | null;
  refreshedAt: Date;
}

export function mergeDecisions(existing: DecisionView[], incoming: DecisionView[]): DecisionView[] {
  const seen = new Set(existing.map((decision) => decision.id));
  return [...existing, ...incoming.filter((decision) => !seen.has(decision.id) && seen.add(decision.id))];
}

/** A first page replaces everything; later pages append and keep the last known cursor when their read failed. */
export function applyResponse(previous: Snapshot | null, view: ExecutionFlowResponse, now: Date): Snapshot {
  const continuation = view.history.requestedCursor !== null && previous !== null;
  if (!continuation) return { view, decisions: view.history.decisions, nextCursor: view.history.nextCursor, refreshedAt: now };
  return {
    view,
    decisions: mergeDecisions(previous.decisions, view.history.decisions),
    nextCursor: view.history.status === "available" ? view.history.nextCursor : previous.nextCursor,
    refreshedAt: now,
  };
}

export interface GroupedDecisions {
  byStage: Map<string, DecisionView[]>;
  current: DecisionView[];
  formerStages: Array<{ id: string; decisions: DecisionView[] }>;
  unclassified: DecisionView[];
}

/** Regroups across every loaded page; the worker only classifies the page it returned. */
export function groupDecisions(view: ExecutionFlowResponse, decisions: DecisionView[]): GroupedDecisions {
  const stageIds = new Set(view.execution.stages.map((stage) => stage.id));
  const byStage = new Map<string, DecisionView[]>();
  const current: DecisionView[] = [];
  const former = new Map<string, DecisionView[]>();
  const unclassified: DecisionView[] = [];
  for (const decision of decisions) {
    if (!view.execution.policyKnown) {
      unclassified.push(decision);
    } else if (stageIds.has(decision.stageId)) {
      current.push(decision);
      byStage.set(decision.stageId, [...(byStage.get(decision.stageId) ?? []), decision]);
    } else {
      former.set(decision.stageId, [...(former.get(decision.stageId) ?? []), decision]);
    }
  }
  return { byStage, current, formerStages: [...former].map(([id, entries]) => ({ id, decisions: entries })), unclassified };
}

export function formatTimestamp(value: string | null, options: { locale?: string; timeZone?: string } = {}): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(options.locale, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short", timeZone: options.timeZone,
  }).format(date);
}

export function describePrincipal(principal: PrincipalView): string {
  const kind = principal.type === "agent" ? "Agent" : "Human";
  return `${kind} ${principal.name ?? "(name unavailable)"}, ID ${principal.id ?? "unavailable"}`;
}

export function titleCase(value: string): string {
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

export type Tone = "done" | "active" | "attention" | "blocked" | "muted";

export function stageTone(status: string): Tone {
  switch (status) {
    case "Completed": return "done";
    case "Pending": return "active";
    case "Changes requested": return "attention";
    default: return "muted";
  }
}

export function cardTone(status: string): Tone {
  switch (status) {
    case "accepted": case "answered": return "done";
    case "pending": return "active";
    case "rejected": return "blocked";
    default: return "muted";
  }
}
