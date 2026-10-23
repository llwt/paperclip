// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionFlowResponse } from "../src/model.js";
import { buildExecutionFlow } from "../src/model.js";
import { STYLES } from "../src/ui/styles.js";
import { card, decision, issue, otherSha, page, sha, stage } from "./fixtures.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Params = { companyId: string; issueId: string; cursor?: string };
type Deferred = { params: Params; resolve: (value: ExecutionFlowResponse) => void; reject: (error: Error) => void };

const pending: Deferred[] = [];

// Mirrors the host hook: old data stays visible across a parameter change until the new result lands.
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  MarkdownBlock: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
  usePluginData: (_key: string, params: Params) => {
    const [state, setState] = useState<{ data: ExecutionFlowResponse | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
    const [tick, setTick] = useState(0);
    const serialized = JSON.stringify(params);
    useEffect(() => {
      let cancelled = false;
      setState((previous) => ({ ...previous, loading: true }));
      new Promise<ExecutionFlowResponse>((resolve, reject) => pending.push({ params: JSON.parse(serialized), resolve, reject })).then(
        (data) => { if (!cancelled) setState({ data, error: null, loading: false }); },
        (error: Error) => { if (!cancelled) setState({ data: null, error, loading: false }); },
      );
      return () => { cancelled = true; };
    }, [serialized, tick]);
    return { ...state, refresh: () => setTick((value) => value + 1) };
  },
}));

const { ExecutionFlow } = await import("../src/ui/index.js");

function respond(options: { company?: string; issueId?: string; cursor?: string; nextCursor?: string | null; items?: ReturnType<typeof decision>[]; cards?: ReturnType<typeof card>[]; stages?: ReturnType<typeof stage>[]; history?: "unavailable"; interactions?: "unavailable"; policy?: boolean } = {}): ExecutionFlowResponse {
  const view = buildExecutionFlow({
    issue: options.policy === false ? {} : issue(options.stages),
    history: options.history === "unavailable" ? { status: "unavailable" } : { status: "available", value: { ...page(options.items ?? []), nextCursor: options.nextCursor ?? null } },
    interactions: options.interactions === "unavailable" ? { status: "unavailable" } : { status: "available", value: options.cards ?? [] },
    requestedCursor: options.cursor,
  });
  return { ...view, subject: { companyId: options.company ?? "company", issueId: options.issueId ?? "issue" } };
}

let container: HTMLElement;
let root: Root;

async function mount(entityId = "issue", companyId = "company") {
  await act(async () => { root.render(<ExecutionFlow context={{ companyId, entityId, entityType: "issue" } as never} />); });
}
async function settle(index: number, value: ExecutionFlowResponse | Error) {
  await act(async () => { value instanceof Error ? pending[index].reject(value) : pending[index].resolve(value); });
}
const text = () => container.textContent ?? "";
const button = (name: RegExp) => [...container.querySelectorAll("button")].find((candidate) => name.test(candidate.textContent ?? ""));

beforeEach(() => {
  pending.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.head.querySelectorAll("style").forEach((node) => node.remove());
});

describe("ExecutionFlow", () => {
  it("shows a loading state, then ordered stages with participants and current holder", async () => {
    await mount();
    expect(text()).toContain("Loading execution flow");
    await settle(0, respond());
    const stages = [...container.querySelectorAll('[aria-label="Execution stages"] > li')];
    expect(stages).toHaveLength(2);
    expect(stages[0].textContent).toContain("1. Review");
    expect(stages[1].textContent).toContain("2. Approval");
    expect(stages[0].textContent).toContain("Pending");
    expect(stages[0].textContent).toContain("Configured participants");
    expect(stages[0].textContent).toContain("Current holder");
    expect(text()).toContain("Last refreshed");
  });

  it("injects the stylesheet from JavaScript", async () => {
    await mount();
    await settle(0, respond());
    expect(container.querySelector("style#execution-flow-styles")?.textContent).toContain(".ef-root");
  });

  it("offers read controls only", async () => {
    await mount();
    await settle(0, respond({ items: [decision("d1")], cards: [card("c1")] }));
    const labels = [...container.querySelectorAll("button")].map((node) => (node.textContent ?? "").trim());
    for (const label of labels) expect(label).toMatch(/^(Refresh|Collapse all|Load more|Retry|Show .*|Hide .*)$/);
    expect(container.querySelectorAll("a, form, input, textarea, select")).toHaveLength(0);
  });

  it("keeps stage decisions and card responses in separate lists with their own source", async () => {
    await mount();
    await settle(0, respond({ items: [decision("d1")], cards: [card("c1", { status: "accepted", resolvedAt: new Date("2026-10-21T13:00:00.000Z"), resolvedByUserId: "ops" })] }));
    const decisions = container.querySelector('[aria-label="Recorded decisions"]')!;
    const cards = container.querySelector('[aria-label="Task confirmations"]')!;
    expect(decisions.textContent).toContain("Approved");
    expect(decisions.textContent).toContain("Decision ID");
    expect(decisions.textContent).not.toContain("Card ID");
    expect(cards.textContent).toContain("Card ID");
    expect(cards.textContent).toContain("Accepted");
    expect(cards.textContent).not.toContain("Decision ID");
    expect(decisions.contains(cards)).toBe(false);
    expect(text()).toContain("A card response is not a stage decision");
  });

  it("discloses decision text through a keyboard-reachable button with aria-expanded", async () => {
    await mount();
    await settle(0, respond({ items: [decision("d1", { body: `Looks good\n\nHead SHA: ${sha}` })] }));
    const toggle = button(/Show decision text/)!;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="markdown"]')).toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls")!)}`)?.textContent).toContain("Looks good");
    expect(text()).toContain(sha);
    await act(async () => button(/Collapse all/)!.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows head SHA as not recorded or ambiguous rather than guessing", async () => {
    await mount();
    await settle(0, respond({ items: [decision("none", { body: `see ${sha}` }), decision("two", { body: `Head SHA: ${sha}\nHead SHA: ${otherSha}` })] }));
    const rows = [...container.querySelectorAll('[aria-label="Recorded decisions"] > li')];
    expect(rows[0].textContent).toContain("Not recorded");
    expect(rows[1].textContent).toContain("Ambiguous");
  });

  it("states what the history shows and loads further pages", async () => {
    await mount();
    await settle(0, respond({ items: [decision("d1")], nextCursor: "next" }));
    expect(text()).toContain("Retained records only");
    expect(text()).toContain("more are available");
    await act(async () => button(/Load more/)!.click());
    expect(pending[1].params.cursor).toBe("next");
    await settle(1, respond({ cursor: "next", items: [decision("d1"), decision("d2")] }));
    expect(container.querySelectorAll('[aria-label="Recorded decisions"] > li')).toHaveLength(2);
    expect(button(/Load more/)).toBeUndefined();
  });

  it("lists decisions for stages no longer in the policy under their own heading", async () => {
    await mount();
    await settle(0, respond({ items: [decision("old", { stageId: "removed", stageType: "approval" })] }));
    expect(text()).toContain("Stages no longer in the current policy");
    expect(text()).toContain("removed");
  });

  it("renders each explicit empty and error state", async () => {
    await mount();
    await settle(0, respond({ policy: false, history: "unavailable", interactions: "unavailable" }));
    expect(text()).toContain("Execution data unavailable");
    expect(text()).toContain("Decision history unavailable");
    expect(text()).toContain("Task confirmations unavailable");
  });

  it("shows empty states without a stage policy", async () => {
    await mount();
    await settle(0, respond({ stages: [] }));
    expect(text()).toContain("No execution stages configured");
    expect(text()).toContain("No decisions are recorded for this task.");
    expect(text()).toContain("No task confirmations.");
  });

  it("shows a load failure with a retry and no leftover data", async () => {
    await mount();
    await settle(0, new Error("denied"));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("denied");
    await act(async () => button(/Retry/)!.click());
    expect(pending).toHaveLength(2);
  });

  it("refresh reloads from the first page", async () => {
    await mount();
    await settle(0, respond({ items: [decision("d1")], nextCursor: "next" }));
    await act(async () => button(/Load more/)!.click());
    await settle(1, respond({ cursor: "next", items: [decision("d2")] }));
    await act(async () => button(/^Refresh$/)!.click());
    expect(pending[2].params.cursor).toBeUndefined();
  });

  it("reloads when the window regains focus, not on a timer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await mount();
      await settle(0, respond());
      vi.setSystemTime(Date.now() + 5000);
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(pending).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });

  it("never shows the previous task while another loads, and ignores its late response", async () => {
    await mount("issue-a");
    await settle(0, respond({ issueId: "issue-a", items: [decision("only-a", { body: "ALPHA-BODY" })] }));
    expect(text()).toContain("Stages");
    await mount("issue-b");
    expect(text()).toContain("Loading execution flow");
    expect(text()).not.toContain("Decision ID");
    expect(text()).not.toContain("only-a");
    // A late answer for task A arrives after the switch.
    await settle(0, respond({ issueId: "issue-a", items: [decision("late-a")] }));
    expect(text()).not.toContain("late-a");
    await settle(1, respond({ issueId: "issue-b", items: [decision("only-b")] }));
    expect(text()).toContain("only-b");
    expect(text()).not.toContain("only-a");
  });

  it("clears data when the company changes", async () => {
    await mount("issue", "company-a");
    await settle(0, respond({ company: "company-a", items: [decision("a-decision")] }));
    await mount("issue", "company-b");
    expect(text()).not.toContain("a-decision");
    expect(text()).toContain("Loading execution flow");
  });

  it("refuses a response whose echoed subject is a different task", async () => {
    await mount("issue-b");
    await settle(0, respond({ issueId: "issue-a", items: [decision("wrong-task")] }));
    expect(text()).not.toContain("wrong-task");
  });

  it("asks for a task when none is in context", async () => {
    await act(async () => { root.render(<ExecutionFlow context={{ companyId: null, entityId: null, entityType: "issue" } as never} />); });
    expect(text()).toContain("Open a task");
    expect(pending).toHaveLength(0);
  });
});

describe("styles", () => {
  it("use only host variables for color, with no copied palette", () => {
    expect(STYLES).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(STYLES).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\(/);
    expect(STYLES).not.toMatch(/(?<![-\w])(white|black|red|green|blue|gray|grey)(?![-\w])/);
  });
});
