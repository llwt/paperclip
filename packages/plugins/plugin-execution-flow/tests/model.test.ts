import { describe, expect, it } from "vitest";
import { buildExecutionFlow, headShaEvidence, type ExecutionIssue, type Interaction } from "../src/model.js";
import { agent, card, decision, issue, otherSha, page, sha, stage, timestamp, user } from "./fixtures.js";

function model(source: ExecutionIssue = issue(), decisions = page(), cards: Interaction[] = []) {
  return buildExecutionFlow({ issue: source, history: { status: "available", value: decisions }, interactions: { status: "available", value: cards } });
}

describe("execution stage fixtures", () => {
  it.each([0, 2, 4])("preserves order and IDs for %i stages, including repeated types", (count) => {
    const stages = Array.from({ length: count }, (_, index) => stage(`stage-${index}`, index % 2 ? "approval" : "review"));
    const view = model(issue(stages));
    expect(view.execution.stages.map(({ id, type }) => ({ id, type }))).toEqual(stages.map(({ id, type }) => ({ id, type })));
    expect(view.execution.message).toBe(count ? null : "No execution stages configured");
    if (count) expect(view.execution.stages.map((s) => s.status)).toEqual(["Pending", ...Array(count - 1).fill("Not current")]);
  });

  it("keeps every candidate and highlights the actual holder separately", () => {
    const source = issue();
    source.executionPolicy!.stages[0].participants.push({ id: "other-participant", ...agent("other") });
    source.executionState!.currentParticipant = agent("other");
    const view = model(source);
    expect(view.execution.stages[0].participants.map((p) => p.principal.id)).toEqual(["reviewer", "other"]);
    expect(view.execution.currentHolder).toMatchObject({ type: "agent", id: "other", displayName: "other" });
  });

  it("never invents a holder from candidates when no participant was recorded", () => {
    const source = issue();
    source.executionState!.currentParticipant = null;
    const view = model(source);
    expect(view.execution.currentHolder).toBeNull();
    expect(view.execution.warnings).toContain("Pending execution has no current stage or participant");
  });

  it("shows human escalation as the actual holder without changing candidates", () => {
    const source = issue();
    source.executionState!.currentParticipant = user("human");
    const view = model(source);
    expect(view.execution.currentHolder).toMatchObject({ type: "user", id: "human" });
    expect(view.execution.stages[0].participants[0].principal.type).toBe("agent");
  });

  it("shows work returned to its author despite a stale reviewer participant", () => {
    const source = issue();
    source.executionState!.status = "changes_requested";
    const view = model(source, page([decision("changes", { outcome: "changes_requested" })]));
    expect(view.execution).toMatchObject({ workReturned: true, currentHolder: { id: "author" }, recordedCurrentParticipant: { id: "reviewer" } });
    expect(view.execution.stages[0]).toMatchObject({ status: "Changes requested", decisions: [{ id: "changes", label: "Changes requested" }] });
  });

  it("marks completed IDs without inventing approval or an active holder", () => {
    const source = issue();
    Object.assign(source.executionState!, { status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null, completedStageIds: ["review", "approve"] });
    const view = model(source);
    expect(view.execution.stages.map((s) => s.status)).toEqual(["Completed", "Completed"]);
    expect(view.execution.stages.flatMap((s) => s.decisions)).toEqual([]);
    expect(view.execution.currentHolder).toBeNull();
  });

  it("keeps every repeated verdict keyed by decision ID and recorded stage type", () => {
    const records = [decision("one", { outcome: "changes_requested" }), decision("two"), decision("three", { actorAgentId: null, actorUserId: "human" })];
    const view = model(issue(), page(records));
    expect(view.execution.stages[0].decisions.map((d) => [d.id, d.label])).toEqual([["one", "Changes requested"], ["two", "Approved"], ["three", "Approved"]]);
    expect(view.history.decisions[2]).toMatchObject({ stageType: "review", actors: [{ type: "user", id: "human" }], createdAt: timestamp, body: "Reviewed" });
  });

  it("retains changed policy IDs under former stages, without merging by type", () => {
    const source = issue([stage("new-review")]);
    source.executionState!.currentStageId = "review";
    const view = model(source, page([decision("one"), decision("two"), decision("three", { stageId: "other-old" })]));
    expect(view.execution.stages[0].decisions).toEqual([]);
    expect(view.history.formerStagesLabel).toBe("Stages no longer in the current policy");
    expect(view.history.formerStages.map((s) => [s.id, s.decisions.map((d) => d.id)])).toEqual([["review", ["one", "two"]], ["other-old", ["three"]]]);
    expect(view.execution.warnings).toContain("Current stage is not in the current policy: review");
  });

  it.each([null, { mode: "normal" as const, commentRequired: true, stages: [] }])("preserves old history when no stages are configured (%j)", (policy) => {
    const view = model({ executionPolicy: policy, executionState: null }, page([decision()]));
    expect(view.execution.message).toBe("No execution stages configured");
    expect(view.history.formerStages[0].decisions[0].id).toBe("decision");
  });

  it.each([{}, { executionPolicy: null }, { executionState: null }])("distinguishes missing SDK fields from no stages (%j)", (source) => {
    const view = model(source, page([decision()]));
    expect(view.execution).toMatchObject({ status: "unavailable", message: "Execution data unavailable" });
    expect(view.history.decisions).toHaveLength(1);
    if (!("executionPolicy" in source)) expect(view.history.unclassifiedDecisions).toHaveLength(1);
  });

  it("keeps inconsistent state visible", () => {
    const source = issue();
    Object.assign(source.executionState!, { currentStageIndex: 1, currentStageType: "approval", completedStageIds: ["review", "removed"] });
    expect(model(source).execution.warnings).toEqual([
      "Completed stage is not in the current policy: removed", "Current stage ID and index disagree", "Current stage ID and type disagree", "Current stage is also marked completed",
    ]);
  });

  it("uses stable IDs for missing names and does not invent missing actors", () => {
    const records = page([decision("no-actor", { actorAgentId: null }), decision("unknown", { actorAgentId: "missing" })]);
    records.principalLabels = {};
    const view = model(issue(), records, [card("resolved", { resolvedByUserId: "missing-user" })]);
    expect(view.execution.stages[0].participants[0].principal.displayName).toBe("reviewer");
    expect(view.history.decisions[0].actors).toEqual([]);
    expect(view.history.decisions[1].actors[0].displayName).toBe("missing");
    expect(view.confirmations.items[0].resolvers[0].displayName).toBe("missing-user");
  });

  it("makes history/card failures explicit without hiding stages", () => {
    const view = buildExecutionFlow({ issue: issue(), history: { status: "unavailable" }, interactions: { status: "unavailable" } });
    expect(view.execution.stages).toHaveLength(2);
    expect(view.history).toMatchObject({ status: "unavailable", message: "Decision history unavailable", hasMore: null });
    expect(view.confirmations).toMatchObject({ status: "unavailable", message: "Task confirmations unavailable" });
  });

  it("exposes page continuation without claiming all-time completeness", () => {
    const records = page([decision()]);
    records.nextCursor = "next";
    const view = buildExecutionFlow({ issue: issue(), history: { status: "available", value: records }, interactions: { status: "available", value: [] }, requestedCursor: "previous" });
    expect(view.history).toMatchObject({ requestedCursor: "previous", nextCursor: "next", hasMore: true });
    expect(view.history.notice).toContain("Retained records only");
    expect(model().history.hasMore).toBe(false);
  });
});

describe("task confirmation fixtures", () => {
  it.each([
    ["pending", null], ["accepted", "accepted"], ["rejected", "rejected"],
    ["expired", "stale_target"], ["cancelled", "withdrawn"], ["cancelled", "superseded_by_comment"],
  ] as const)("keeps real status %s and outcome %s, separate from native stages", (status, outcome) => {
    const view = model(issue(), page(), [card("card", { status, result: outcome ? { version: 1, outcome } : null, resolvedByUserId: "human", resolvedAt: timestamp })]);
    expect(view.confirmations.items[0]).toMatchObject({ status, outcome, resolvers: [{ type: "user", id: "human" }], resolvedAt: timestamp });
    expect(view.confirmations.label).toBe("Task confirmations");
    expect(view.execution.stages[0]).toMatchObject({ status: "Pending", decisions: [] });
  });

  it.each(["toolAction", "secretProposal", "connectionAuthorization"])("omits %s authorization confirmations", (key) => {
    const authCard = card();
    Object.assign(authCard.payload, { [key]: {} });
    expect(model(issue(), page(), [authCard]).confirmations.items).toEqual([]);
  });

  it("omits connection intents, task suggestions and question forms", () => {
    const cards = ["connection_intent", "suggest_tasks", "ask_user_questions"].map((kind) => ({ ...card(), kind }) as Interaction);
    expect(model(issue(), page(), cards).confirmations.items).toEqual([]);
  });

  it("keeps checkbox selections and each item verdict's actual resolver", () => {
    const checkbox: Interaction = { ...card(), kind: "request_checkbox_confirmation", payload: { version: 1, prompt: "Select", options: [{ id: "option", label: "Option" }] }, result: { version: 1, outcome: "accepted", selectedOptionIds: ["option"] } };
    const verdicts: Interaction = { ...card("verdicts"), kind: "request_item_verdicts", payload: { version: 1, prompt: "Judge", items: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }, result: { version: 1, outcome: "resolved", complete: false, items: [{ id: "a", verdict: "reject", reason: "Needs work", resolvedByUserId: "human", resolvedAt: timestamp }] } };
    const view = model(issue(), page(), [checkbox, verdicts]);
    expect(view.confirmations.items[0]).toMatchObject({ selectedOptionIds: ["option"], options: [{ id: "option", label: "Option" }] });
    expect(view.confirmations.items[1]).toMatchObject({ complete: false, items: [{ id: "a", verdict: "reject", resolvers: [{ type: "user", id: "human" }] }, { id: "b", verdict: null, resolvers: [] }] });
  });

  it("reads SHA evidence only from a card's own prompt/details, never target or result", () => {
    const source = card("card", { payload: { version: 1, prompt: "Confirm", target: { type: "custom", key: "head", revisionId: sha } }, result: { version: 1, outcome: "accepted", reason: `Head SHA: ${sha}` } });
    expect(model(issue(), page(), [source]).confirmations.items[0].headSha.label).toBe("Not recorded");
    source.payload.detailsMarkdown = `Reported by author. Head SHA: ${sha}`;
    expect(model(issue(), page(), [source]).confirmations.items[0].headSha).toMatchObject({ status: "reported", sha, excerpts: [`Head SHA: ${sha}`] });
    source.payload.prompt = `Head SHA: ${otherSha}`;
    expect(model(issue(), page(), [source]).confirmations.items[0].headSha.status).toBe("ambiguous");
  });
});

describe("conservative head SHA evidence", () => {
  it.each(["", sha, `revisionId: ${sha}`, `head sha: ${sha}`, `Head SHA: ${sha.slice(0, 39)}`, `Head SHA: ${sha}a`, `Head SHA: ${sha}x`, `Head SHA: ${sha}-suffix`])("does not infer a full labeled hash from %s", (body) => {
    expect(headShaEvidence([body])).toEqual({ status: "not_recorded", label: "Not recorded" });
  });
  it("accepts one explicitly labeled full hash with its exact source excerpt", () => {
    const body = `Review complete. Head SHA: ${sha.toUpperCase()}\nChecked`;
    expect(model(issue(), page([decision("sha", { body })])).history.decisions[0].headSha).toEqual({ status: "reported", label: "Reported head SHA", sha, excerpts: [`Head SHA: ${sha.toUpperCase()}`] });
  });
  it("marks conflicting labeled hashes as ambiguous", () => {
    expect(headShaEvidence([`Head SHA: ${sha}\nHead SHA: ${otherSha}`])).toMatchObject({ status: "ambiguous", label: "Ambiguous" });
  });
  it("does not call case variants of the same reported hash conflicting", () => {
    expect(headShaEvidence([`Head SHA: ${sha}`, `Head SHA: ${sha.toUpperCase()}`]).status).toBe("reported");
  });
});
