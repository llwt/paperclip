import { AGENT_MENTION_SCHEME, parseAgentMentionHref } from "./project-mentions.js";

/**
 * Leading agent mention handoff (fork, SX-1178).
 *
 * A comment whose first content is exactly one structured agent mention is a
 * handoff candidate. Everything else, including a mention later in the body, is
 * context. This module only reads markdown; whether a candidate transfers
 * ownership is decided by the server (`issue-comment-handoff.ts`).
 *
 * The grammar is a bounded prefix scan, not a markdown parser. Anything it does
 * not recognise fails to context.
 */

export const ISSUE_COMMENT_HANDOFF_OUTCOMES = ["assigned", "context_only", "unchanged"] as const;
export type IssueCommentHandoffOutcome = (typeof ISSUE_COMMENT_HANDOFF_OUTCOMES)[number];

export const ISSUE_COMMENT_HANDOFF_REASON_CODES = [
  "ambiguous_prefix",
  "author_not_assignee",
  "assignment_not_allowed",
  "target_unavailable",
  "review_pending",
  "confirmation_pending",
  "interaction_pending",
  "status_requires_explicit_action",
  "lifecycle_owned",
  "explicit_mutation",
  "state_changed",
] as const;
export type IssueCommentHandoffReasonCode = (typeof ISSUE_COMMENT_HANDOFF_REASON_CODES)[number];

/** Statuses from which a leading mention may transfer ownership. */
export const ISSUE_COMMENT_HANDOFF_STATUSES = ["todo", "in_progress"] as const;

export type LeadingAgentMention =
  | { kind: "none" }
  | { kind: "ambiguous" }
  | { kind: "target"; agentId: string; icon: string | null; label: string };

const CANONICAL_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Only the generated `?i=` / `?icon=` suffix is accepted; no path, port,
// credentials, fragment or second parameter.
const HANDOFF_AGENT_HREF_RE = new RegExp(`^agent://(${CANONICAL_UUID})(?:\\?(?:i|icon)=[a-z0-9-]+)?$`);
const INLINE_LINK_RE = /^\[([^[\]\n]*)\]\(([^()\s]*)\)/;
const RECIPIENT_LINK_RE = /^\[[^[\]\n]*\]\((?:agent|user):\/\//i;
const AFTER_LINK_TERMINATOR_RE = /^(?:$|\s|[.,;:!?])/;
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const TABLE_DELIMITER_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

/** Length of the recipient separator run at the start of `text` (whitespace, `, ; : &`, or ` and `). */
function separatorLength(text: string): number {
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch) || ch === "," || ch === ";" || ch === ":" || ch === "&") {
      i += 1;
      continue;
    }
    if (i > 0 && /\s/.test(text[i - 1]!) && /^and\s/i.test(text.slice(i))) {
      i += 3;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Find the leading agent mention of a comment body, if it qualifies as a
 * handoff candidate. See the "Exact markdown grammar" section of the plan.
 */
export function parseLeadingAgentMention(body: string): LeadingAgentMention {
  if (!body) return { kind: "none" };
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let first = 0;
  while (first < lines.length && isBlank(lines[first]!)) first += 1;
  if (first >= lines.length) return { kind: "none" };

  const firstLine = lines[first]!;
  const indent = /^[ \t]*/.exec(firstLine)![0];
  // A tab or four spaces is indented code, not a command.
  if (indent.includes("\t") || indent.length > 3) return { kind: "none" };

  // The first block must stay a plain paragraph: a setext underline or a table
  // delimiter row anywhere in it turns it into a heading or a table.
  for (let i = first + 1; i < lines.length && !isBlank(lines[i]!); i += 1) {
    if (SETEXT_UNDERLINE_RE.test(lines[i]!)) return { kind: "none" };
    if (i === first + 1 && lines[i]!.includes("|") && TABLE_DELIMITER_RE.test(lines[i]!)) return { kind: "none" };
  }

  // Headings, quotes, lists, code, images, escapes and HTML all start with a
  // character other than `[`, so they never match here.
  const rest = lines.slice(first).join("\n").slice(indent.length);
  const link = INLINE_LINK_RE.exec(rest);
  if (!link) return { kind: "none" };
  const label = link[1]!;
  const href = link[2]!;
  if (!href.toLowerCase().startsWith(AGENT_MENTION_SCHEME)) return { kind: "none" };
  const canonical = HANDOFF_AGENT_HREF_RE.exec(href);
  const parsed = canonical ? parseAgentMentionHref(href) : null;
  if (!canonical || !parsed || parsed.agentId !== canonical[1]) return { kind: "none" };

  const after = rest.slice(link[0].length);
  if (!AFTER_LINK_TERMINATOR_RE.test(after)) return { kind: "none" };

  const next = after.slice(separatorLength(after));
  if (RECIPIENT_LINK_RE.test(next)) return { kind: "ambiguous" };

  return { kind: "target", agentId: parsed.agentId, icon: parsed.icon, label };
}

/** True when the body starts with a recipient the server would evaluate (a target or an ambiguous prefix). */
export function hasLeadingHandoffCandidate(mention: LeadingAgentMention): boolean {
  return mention.kind !== "none";
}

const HANDOFF_REASON_TEXT: Record<IssueCommentHandoffReasonCode, string> = {
  ambiguous_prefix: "the comment starts with more than one recipient",
  author_not_assignee: "only the board or the current assignee can hand off this task",
  assignment_not_allowed: "you are not allowed to assign this task to that agent",
  target_unavailable: "the mentioned agent cannot take this task",
  review_pending: "a review stage is waiting on this task",
  confirmation_pending: "a confirmation is waiting on this task",
  interaction_pending: "a question or approval is waiting on this task",
  status_requires_explicit_action: "this task's status needs an explicit assignment",
  lifecycle_owned: "a hold or another workflow controls this task",
  explicit_mutation: "the explicit change in this request takes precedence",
  state_changed: "the task changed while the handoff was checked",
};

/** Short, user-facing reason for a refused handoff. Never names a foreign agent. */
export function describeIssueCommentHandoffReason(reasonCode: IssueCommentHandoffReasonCode): string {
  return HANDOFF_REASON_TEXT[reasonCode];
}
