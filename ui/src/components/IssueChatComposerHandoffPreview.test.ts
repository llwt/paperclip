import { describe, expect, it } from "vitest";
import { buildAgentMentionHref, buildUserMentionHref, parseLeadingAgentMention } from "@paperclipai/shared";
import {
  computeComposerHandoffPreview,
  extractAgentMentionIds,
  knownComposerHandoffRefusal,
  type ComposerHandoffPreviewInput,
} from "../lib/interrupt-handoff";
import { shouldRenderComposerHandoffPreview } from "./IssueChatThread";

describe("shouldRenderComposerHandoffPreview", () => {
  it("skips the spacer wrapper when the preview is empty", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-claude",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });

    expect(preview.kind).toBe("none");
    expect(shouldRenderComposerHandoffPreview("Wake Claude", preview)).toBe(false);
  });

  it("renders the spacer wrapper only when body text and a visible preview are present", () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-qa",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: null,
    });

    expect(preview.kind).not.toBe("none");
    expect(shouldRenderComposerHandoffPreview("Wake QA", preview)).toBe(true);
    expect(shouldRenderComposerHandoffPreview("   ", preview)).toBe(false);
  });
});

describe("composer preview for a leading agent mention", () => {
  const OWNER = "11111111-1111-4111-8111-111111111111";
  const QA = "22222222-2222-4222-8222-222222222222";
  const DEV = "33333333-3333-4333-8333-333333333333";
  const qa = `[@QA](${buildAgentMentionHref(QA, "bug")})`;
  const dev = `[@Dev](${buildAgentMentionHref(DEV)})`;

  // Same inputs the composer passes, derived from the body.
  function preview(body: string, overrides: Partial<ComposerHandoffPreviewInput> = {}) {
    const mentionedAgentIds = extractAgentMentionIds(body);
    return computeComposerHandoffPreview({
      reassignTarget: `agent:${OWNER}`,
      currentAssigneeValue: `agent:${OWNER}`,
      hasActiveRun: false,
      bodyHasAgentMention: mentionedAgentIds.length > 0,
      mentionedAgentId: mentionedAgentIds[0] ?? null,
      plainNameCandidate: null,
      leadingMention: parseLeadingAgentMention(body),
      ...overrides,
    });
  }

  function promisesHandoff(p: ReturnType<typeof preview>) {
    return /will (stop|hand off)|hand off to|handoff to|notify/i.test(`${p.text} ${p.suffix ?? ""}`);
  }

  describe("with availability off (the default)", () => {
    it.each([
      ["leading mention", `${qa} please take this`],
      ["leading mention with a running agent", `${qa} please take this`],
      ["two recipients", `${qa} ${dev} take this`],
      ["later mention", `Context first, ${qa} please look`],
    ])("%s previews as context and promises nothing", (_name, body) => {
      const p = preview(body, { hasActiveRun: true, handoffCheck: { kind: "eligible" } });
      expect(p.kind).toBe("mention_context");
      expect(promisesHandoff(p)).toBe(false);
    });

    it("is off when the input is omitted", () => {
      const p = preview(`${qa} please take this`, { handoffCheck: { kind: "eligible" } });
      expect(p.kind).toBe("mention_context");
    });
  });

  describe("with availability on", () => {
    const on = { handoffAvailable: true } as const;

    it("unknown gates: says the handoff is checked when sent", () => {
      const p = preview(`${qa} please take this`, on);
      expect(p.kind).toBe("mention_handoff_unknown");
      expect(p.chip).toEqual({ kind: "agent", id: QA });
      expect(`${p.text} ${p.suffix}`).toBe("Handoff to will be checked when sent");
    });

    it("eligible: will hand off", () => {
      const p = preview(`${qa} please take this`, { ...on, handoffCheck: { kind: "eligible" } });
      expect(p).toMatchObject({ kind: "mention_handoff", text: "Will hand off to", chip: { kind: "agent", id: QA } });
    });

    it("eligible with a running agent: will stop the run and hand off", () => {
      const p = preview(`${qa} please take this`, { ...on, hasActiveRun: true, handoffCheck: { kind: "eligible" } });
      expect(p).toMatchObject({ kind: "mention_interrupt_handoff", text: "Will stop the current run and hand off to" });
    });

    it("refused: context only with the reason", () => {
      const p = preview(`${qa} please take this`, {
        ...on,
        handoffCheck: { kind: "refused", reasonCode: "confirmation_pending" },
      });
      expect(p).toMatchObject({
        kind: "mention_handoff_refused",
        tone: "warn",
        text: "Context only: a confirmation is waiting on this task",
      });
      expect(p.chip).toBeUndefined();
    });

    it("refused by status known to the composer", () => {
      const p = preview(`${qa} please take this`, { ...on, handoffCheck: knownComposerHandoffRefusal({ issueStatus: "in_review" }) });
      expect(p.kind).toBe("mention_handoff_refused");
      expect(p.text).toMatch(/explicit assignment/);
    });

    it("two recipients: refused as ambiguous, even if the client thinks it is eligible", () => {
      const p = preview(`${qa} and ${dev} take this`, { ...on, handoffCheck: { kind: "eligible" } });
      expect(p).toMatchObject({ kind: "mention_handoff_refused", text: "Context only: the comment starts with more than one recipient" });
    });

    it("agent then user mention: refused as ambiguous", () => {
      const p = preview(`${qa} [@Steven](${buildUserMentionHref("user-1")}) take this`, on);
      expect(p.kind).toBe("mention_handoff_refused");
    });

    it("later mention: context only", () => {
      const p = preview(`Context first, ${qa} please look`, { ...on, handoffCheck: { kind: "eligible" } });
      expect(p.kind).toBe("mention_context");
      expect(promisesHandoff(p)).toBe(false);
    });

    it("mention of the current owner: context only", () => {
      const p = preview(`[@Owner](${buildAgentMentionHref(OWNER)}) keep going`, { ...on, handoffCheck: { kind: "eligible" } });
      expect(p.kind).toBe("mention_context");
    });

    it("explicit picker wins over the leading mention", () => {
      const p = preview(`${qa} please take this`, {
        ...on,
        handoffCheck: { kind: "eligible" },
        reassignTarget: `agent:${DEV}`,
        hasActiveRun: true,
      });
      expect(p).toMatchObject({ kind: "interrupt_handoff_agent", chip: { kind: "agent", id: DEV } });
    });

    it("explicit picker to a user wins over the leading mention", () => {
      const p = preview(`${qa} please take this`, { ...on, handoffCheck: { kind: "eligible" }, reassignTarget: "user:user-1" });
      expect(p.kind).toBe("user_handoff");
    });
  });

  describe("knownComposerHandoffRefusal", () => {
    it.each(["todo", "in_progress", undefined])("knows nothing for %s", (issueStatus) => {
      expect(knownComposerHandoffRefusal({ issueStatus })).toBeNull();
    });

    it.each(["backlog", "blocked", "in_review", "done", "cancelled"])("refuses %s", (issueStatus) => {
      expect(knownComposerHandoffRefusal({ issueStatus })).toEqual({
        kind: "refused",
        reasonCode: "status_requires_explicit_action",
      });
    });
  });
});
