import { describe, expect, it } from "vitest";
import {
  ISSUE_COMMENT_HANDOFF_REASON_CODES,
  describeIssueCommentHandoffReason,
  parseLeadingAgentMention,
} from "./agent-mention-handoff.js";
import { buildAgentMentionHref, buildUserMentionHref } from "./project-mentions.js";
import {
  addIssueCommentSchema,
  issueCommentHandoffReceiptSchema,
  issueCommentMetadataSchema,
  issueCommentRequestMetadataSchema,
} from "./validators/issue.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const U = "user-board-1";
const mA = `[@Alpha](${buildAgentMentionHref(A)})`;
const mAIcon = `[@Alpha](${buildAgentMentionHref(A, "code")})`;
const mB = `[@Beta](${buildAgentMentionHref(B)})`;
const mU = `[@Steven](${buildUserMentionHref(U)})`;

const target = { kind: "target", agentId: A } as const;
const none = { kind: "none" } as const;
const ambiguous = { kind: "ambiguous" } as const;

function expectKind(body: string, expected: { kind: string; agentId?: string }) {
  const result = parseLeadingAgentMention(body);
  expect(result.kind, JSON.stringify(body)).toBe(expected.kind);
  if (expected.agentId) expect(result).toMatchObject({ agentId: expected.agentId });
}

describe("parseLeadingAgentMention", () => {
  describe("UUID and icon suffix", () => {
    it.each([
      ["sole mention", mA],
      ["mention then prose", `${mA} please take this`],
      ["generated ?i= suffix", `${mAIcon} please take this`],
      ["?icon= suffix", `[@Alpha](agent://${A}?icon=bot) over to you`],
    ])("%s is a candidate", (_name, body) => {
      expectKind(body, target);
    });

    it("returns the icon and label", () => {
      expect(parseLeadingAgentMention(`${mAIcon} go`)).toEqual({
        kind: "target",
        agentId: A,
        icon: "code",
        label: "@Alpha",
      });
    });

    it.each([
      ["non-UUID id", "[@Alpha](agent://qa-agent-id) take this"],
      ["upper-case UUID", "[@Alpha](agent://ABCDEF12-1111-4111-8111-111111111111) take this"],
      ["extra path", `[@Alpha](agent://${A}/extra) take this`],
      ["credentials", `[@Alpha](agent://me:pw@${A}) take this`],
      ["port", `[@Alpha](agent://${A}:8080) take this`],
      ["fragment", `[@Alpha](agent://${A}#x) take this`],
      ["unknown query parameter", `[@Alpha](agent://${A}?x=1) take this`],
      ["two query parameters", `[@Alpha](agent://${A}?i=code&c=fff) take this`],
      ["upper-case scheme", `[@Alpha](AGENT://${A}) take this`],
      ["link title", `[@Alpha](agent://${A} "Alpha") take this`],
    ])("%s is not a candidate", (_name, body) => {
      expectKind(body, none);
    });
  });

  describe("code, quotes, lists, escapes and other blocks", () => {
    it.each([
      ["fenced code", "```\n" + mA + " take this\n```"],
      ["tilde fence", "~~~\n" + mA + "\n~~~"],
      ["inline code", "`" + mA + "` take this"],
      ["indented code (4 spaces)", `    ${mA} take this`],
      ["indented code (tab)", `\t${mA} take this`],
      ["blockquote", `> ${mA} take this`],
      ["bullet list", `- ${mA} take this`],
      ["star list", `* ${mA} take this`],
      ["ordered list", `1. ${mA} take this`],
      ["ATX heading", `# ${mA} take this`],
      ["setext heading (=)", `${mA} take this\n===`],
      ["setext heading (-)", `${mA} take this\n---`],
      ["table header", `${mA} | owner\n--- | ---`],
      ["image", `![@Alpha](agent://${A}) take this`],
      ["escaped link", `\\[@Alpha](agent://${A}) take this`],
      ["HTML", `<a href="agent://${A}">@Alpha</a> take this`],
      ["reference link", `[@Alpha][a] take this\n\n[a]: agent://${A}`],
      ["raw @Name", "@Alpha take this"],
      ["bare URL", `agent://${A} take this`],
      ["autolink", `<agent://${A}> take this`],
    ])("%s is not a candidate", (_name, body) => {
      expectKind(body, none);
    });
  });

  describe("CRLF, blank lines and indentation", () => {
    it.each([
      ["leading LF blank lines", `\n\n${mA} take this`],
      ["leading CRLF blank lines", `\r\n\r\n${mA} take this\r\nthanks`],
      ["whitespace-only blank lines", ` \n\t\n${mA} take this`],
      ["one space indent", ` ${mA} take this`],
      ["three space indent", `   ${mA} take this`],
      ["CRLF after mention", `${mA}\r\nplease take this`],
    ])("%s is a candidate", (_name, body) => {
      expectKind(body, target);
    });

    it("rejects four spaces after CRLF blank lines", () => {
      expectKind(`\r\n    ${mA} take this`, none);
    });

    it("rejects a CRLF setext heading", () => {
      expectKind(`${mA} take this\r\n---\r\n`, none);
    });

    it.each([["empty body", ""], ["only whitespace", " \r\n\t\n"]])("%s is not a candidate", (_name, body) => {
      expectKind(body, none);
    });
  });

  describe("punctuation after the link", () => {
    it.each([
      ["colon", `${mA}: please take this`],
      ["comma", `${mA}, please take this`],
      ["period", `${mA}. Over to you.`],
      ["question mark", `${mA}? can you take this`],
      ["exclamation mark", `${mA}! yours now`],
      ["semicolon", `${mA}; yours now`],
    ])("%s qualifies", (_name, body) => {
      expectKind(body, target);
    });

    it.each([
      ["glued word", `${mA}please take this`],
      ["glued apostrophe", `${mA}'s turn`],
      ["glued dash", `${mA}-take this`],
      ["glued paren", `${mA}(take this)`],
    ])("%s does not qualify", (_name, body) => {
      expectKind(body, none);
    });
  });

  describe("two recipients", () => {
    it.each([
      ["space", `${mA} ${mB} take this`],
      ["comma", `${mA}, ${mB} take this`],
      ["semicolon", `${mA}; ${mB} take this`],
      ["colon", `${mA}: ${mB} take this`],
      ["ampersand", `${mA} & ${mB} take this`],
      ["and", `${mA} and ${mB} take this`],
      ["AND", `${mA} AND ${mB} take this`],
      ["newline", `${mA}\n${mB} take this`],
      ["blank line", `${mA}\n\n${mB} take this`],
      ["user mention second", `${mA} ${mU} take this`],
      ["user mention second with and", `${mA} and ${mU} please`],
      ["same target twice", `${mA} ${mA} take this`],
      ["same target with icon", `${mA}, ${mAIcon} take this`],
      ["second recipient malformed", `${mA} [@Beta](agent://beta) take this`],
    ])("%s is ambiguous", (_name, body) => {
      expectKind(body, ambiguous);
    });

    it("a user mention first is not a candidate", () => {
      expectKind(`${mU} ${mA} take this`, none);
    });

    it("a user mention alone is not a candidate", () => {
      expectKind(`${mU} take this`, none);
    });

    it("substantive text before the second mention targets the first only", () => {
      expectKind(`${mA} please ask ${mB} about testing`, target);
    });

    it("a word containing 'and' is substantive text", () => {
      expectKind(`${mA} android ${mB}`, target);
    });

    it("'and' glued to the link is not a separator", () => {
      expectKind(`${mA}and ${mB}`, none);
    });
  });

  describe("later mentions", () => {
    it.each([
      ["later in the paragraph", `Context first, ${mA} please look`],
      ["later paragraph", `Some context.\n\n${mA} please take this`],
      ["after a heading", `# Notes\n\n${mA} please take this`],
      ["after a quote", `> earlier\n\n${mA} take this`],
    ])("%s is not a candidate", (_name, body) => {
      expectKind(body, none);
    });
  });
});

describe("describeIssueCommentHandoffReason", () => {
  it("has copy for every reason code", () => {
    for (const code of ISSUE_COMMENT_HANDOFF_REASON_CODES) {
      expect(describeIssueCommentHandoffReason(code).length).toBeGreaterThan(0);
    }
  });
});

describe("metadata.handoff receipt", () => {
  const RUN = "33333333-3333-4333-8333-333333333333";
  const sections = [{ title: "Handoff", rows: [{ type: "text", text: "Comment saved." }] }];
  const assigned = { version: 1, outcome: "assigned", targetAgentId: A, statusVersion: 4, interruptedRunId: RUN } as const;
  const refused = { version: 1, outcome: "context_only", reasonCode: "confirmation_pending", targetAgentId: A } as const;

  it.each([
    ["assigned", assigned],
    ["assigned without a stopped run", { version: 1, outcome: "assigned", targetAgentId: A, statusVersion: 0 }],
    ["context only", refused],
    ["context only without a target", { version: 1, outcome: "context_only", reasonCode: "target_unavailable" }],
    ["unchanged", { version: 1, outcome: "unchanged", targetAgentId: A }],
  ])("accepts a consistent %s receipt", (_name, receipt) => {
    expect(issueCommentHandoffReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it.each([
    ["assigned with a reason", { ...assigned, reasonCode: "state_changed" }],
    ["assigned without a version", { version: 1, outcome: "assigned", targetAgentId: A }],
    ["assigned without a target", { version: 1, outcome: "assigned", statusVersion: 1 }],
    ["context only without a reason", { version: 1, outcome: "context_only" }],
    ["context only with a version", { ...refused, statusVersion: 2 }],
    ["context only with a stopped run", { ...refused, interruptedRunId: RUN }],
    ["unchanged with a reason", { version: 1, outcome: "unchanged", reasonCode: "ambiguous_prefix" }],
    ["unknown reason", { ...refused, reasonCode: "because" }],
    ["unknown field", { ...assigned, grantedBy: "board" }],
    ["non-UUID target", { ...refused, targetAgentId: "qa" }],
  ])("rejects %s", (_name, receipt) => {
    expect(issueCommentHandoffReceiptSchema.safeParse(receipt).success).toBe(false);
  });

  it("stored metadata keeps a server-authored receipt", () => {
    const parsed = issueCommentMetadataSchema.parse({ version: 1, handoff: assigned, sections });
    expect(parsed.handoff).toEqual(assigned);
  });

  it("request metadata rejects a caller-supplied receipt", () => {
    expect(issueCommentRequestMetadataSchema.safeParse({ version: 1, sections }).success).toBe(true);
    expect(issueCommentRequestMetadataSchema.safeParse({ version: 1, handoff: assigned, sections }).success).toBe(false);
  });

  it("POST comment bodies cannot carry a receipt", () => {
    const body = { body: `${mA} take this`, metadata: { version: 1, handoff: assigned, sections } };
    const result = addIssueCommentSchema.safeParse(body);
    expect(result.success).toBe(false);
    expect(addIssueCommentSchema.safeParse({ ...body, metadata: { version: 1, sections } }).success).toBe(true);
  });
});
