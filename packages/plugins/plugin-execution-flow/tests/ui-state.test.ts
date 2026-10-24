import { describe, expect, it } from "vitest";
import { buildExecutionFlow } from "../src/model.js";
import type { ExecutionFlowResponse } from "../src/model.js";
import { applyResponse, cardTone, formatTimestamp, groupDecisions, mergeDecisions, stageTone } from "../src/ui/state.js";
import { card, decision, issue, page, stage } from "./fixtures.js";

function response(options: { cursor?: string; nextCursor?: string | null; items?: ReturnType<typeof decision>[]; policy?: boolean } = {}): ExecutionFlowResponse {
  const base = options.policy === false ? {} : issue();
  const view = buildExecutionFlow({
    issue: base,
    history: { status: "available", value: { ...page(options.items ?? []), nextCursor: options.nextCursor ?? null } },
    interactions: { status: "available", value: [card()] },
    requestedCursor: options.cursor,
  });
  return { ...view, subject: { companyId: "company", issueId: "issue" } };
}

const now = new Date("2026-10-22T10:00:00.000Z");

describe("applyResponse", () => {
  it("replaces everything on a first page", () => {
    const first = applyResponse(null, response({ items: [decision("a")], nextCursor: "c1" }), now);
    expect(first.decisions.map((d) => d.id)).toEqual(["a"]);
    expect(first.nextCursor).toBe("c1");
    const reloaded = applyResponse(first, response({ items: [decision("b")] }), now);
    expect(reloaded.decisions.map((d) => d.id)).toEqual(["b"]);
    expect(reloaded.nextCursor).toBeNull();
  });

  it("appends a continuation page and drops duplicates", () => {
    const first = applyResponse(null, response({ items: [decision("a"), decision("b")], nextCursor: "c1" }), now);
    const next = applyResponse(first, response({ cursor: "c1", items: [decision("b"), decision("c")] }), now);
    expect(next.decisions.map((d) => d.id)).toEqual(["a", "b", "c"]);
    expect(next.nextCursor).toBeNull();
  });

  it("keeps the previous cursor when a continuation read fails", () => {
    const first = applyResponse(null, response({ items: [decision("a")], nextCursor: "c1" }), now);
    const failed = buildExecutionFlow({ issue: issue(), history: { status: "unavailable" }, interactions: { status: "available", value: [] }, requestedCursor: "c1" });
    const next = applyResponse(first, { ...failed, subject: { companyId: "company", issueId: "issue" } }, now);
    expect(next.decisions.map((d) => d.id)).toEqual(["a"]);
    expect(next.nextCursor).toBe("c1");
  });
});

describe("mergeDecisions", () => {
  it("is stable for repeated input", () => {
    const view = response({ items: [decision("a")] });
    expect(mergeDecisions(view.history.decisions, view.history.decisions)).toHaveLength(1);
  });
});

describe("groupDecisions", () => {
  it("regroups across pages by the current policy", () => {
    const view = response({ items: [decision("a", { stageId: "review" }), decision("b", { stageId: "gone" })] });
    const grouped = groupDecisions(view, view.history.decisions);
    expect(grouped.current.map((d) => d.id)).toEqual(["a"]);
    expect(grouped.formerStages).toEqual([{ id: "gone", decisions: [expect.objectContaining({ id: "b" })] }]);
    expect(grouped.byStage.get("review")).toHaveLength(1);
  });

  it("does not call decisions former stages when no policy is known", () => {
    const view = response({ policy: false, items: [decision("a")] });
    expect(view.execution.policyKnown).toBe(false);
    const grouped = groupDecisions(view, view.history.decisions);
    expect(grouped.formerStages).toEqual([]);
    expect(grouped.unclassified.map((d) => d.id)).toEqual(["a"]);
  });

  it("keeps repeated review stages separate", () => {
    const stages = [stage("r1"), stage("r2"), stage("r3"), stage("r4", "approval")];
    const view = buildExecutionFlow({
      issue: issue(stages),
      history: { status: "available", value: page([decision("x", { stageId: "r1" }), decision("y", { stageId: "r3" })]) },
      interactions: { status: "available", value: [] },
    });
    const grouped = groupDecisions({ ...view, subject: { companyId: "company", issueId: "issue" } }, view.history.decisions);
    expect([...grouped.byStage.keys()]).toEqual(["r1", "r3"]);
  });
});

describe("formatTimestamp", () => {
  it("includes the time zone", () => {
    expect(formatTimestamp("2026-10-21T12:00:00.000Z", { locale: "en-US", timeZone: "America/Chicago" })).toBe("Oct 21, 2026, 7:00:00 AM CDT");
  });
  it("handles missing and invalid values without inventing a time", () => {
    expect(formatTimestamp(null)).toBe("Not recorded");
    expect(formatTimestamp("garbage")).toBe("garbage");
  });
});

describe("tones", () => {
  it("map status to a tone", () => {
    expect(stageTone("Completed")).toBe("done");
    expect(stageTone("Changes requested")).toBe("attention");
    expect(cardTone("rejected")).toBe("blocked");
    expect(cardTone("expired")).toBe("muted");
  });
});
