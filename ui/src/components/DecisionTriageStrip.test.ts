import { describe, expect, it } from "vitest";
import { extractAgentMentionIds, parseLeadingAgentMention } from "@paperclipai/shared";
import { buildRecommendationRequestBody, recommendationRequestToast } from "./DecisionTriageStrip";

describe("buildRecommendationRequestBody", () => {
  const agent = { id: "11111111-1111-4111-8111-111111111111", name: "Planner" };

  it("never starts with a mention, so it cannot become a handoff", () => {
    for (const identifier of ["SX-12", null]) {
      const body = buildRecommendationRequestBody(agent, identifier);
      expect(parseLeadingAgentMention(body)).toEqual({ kind: "none" });
      expect(body).not.toMatch(/^\s*\[/);
    }
  });

  it("still mentions the agent and says there is no reassignment", () => {
    const body = buildRecommendationRequestBody(agent, "SX-12");
    expect(extractAgentMentionIds(body)).toEqual([agent.id]);
    expect(body).toMatch(/no reassignment/);
    expect(body).toContain("on SX-12");
  });
});

describe("recommendationRequestToast", () => {
  it("says a comment was saved and nothing was reassigned", () => {
    const toast = recommendationRequestToast("Planner");
    expect(toast.title).toBe("Comment saved");
    expect(toast.body).toMatch(/not reassigned/);
    expect(`${toast.title} ${toast.body}`).not.toMatch(/dispatch|handed|assigned to/i);
  });
});
