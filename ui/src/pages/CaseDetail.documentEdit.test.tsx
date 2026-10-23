// @vitest-environment jsdom

import { act as reactAct } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseDetail as CaseDetailData } from "@/api/cases";
import { CaseDetail } from "./CaseDetail";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const companyState = vi.hoisted(() => ({ selectedCompanyId: "company-1" }));
const mockCasesApi = vi.hoisted(() => ({
  get: vi.fn(),
  listEvents: vi.fn(),
  list: vi.fn(),
  listChildren: vi.fn(),
  patch: vi.fn(),
  getDocument: vi.fn(),
  listRevisions: vi.fn(),
  upsertDocument: vi.fn(),
  lockDocument: vi.fn(),
  unlockDocument: vi.fn(),
  restoreDocumentRevision: vi.fn(),
  deleteDocument: vi.fn(),
}));
const mockIssuesApi = vi.hoisted(() => ({ listLabels: vi.fn(), createLabel: vi.fn() }));
const panelState = vi.hoisted(() => ({ openPanel: vi.fn(), closePanel: vi.fn() }));

vi.mock("@/context/CompanyContext", () => ({ useCompany: () => companyState }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("@/context/PanelContext", () => ({ usePanel: () => panelState }));
vi.mock("@/api/cases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/cases")>()),
  casesApi: mockCasesApi,
}));
vi.mock("@/api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: vi.fn(() => Promise.resolve()) }));
vi.mock("@/components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="md">{children}</div>,
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));
vi.mock("@/components/IssueDocumentAnnotations", () => ({
  DocumentAnnotationsCountChip: () => null,
  IssueDocumentAnnotations: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuRadioItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ caseIdentifier: "SX-C2" }),
  useLocation: () => ({ hash: "" }),
  Navigate: () => null,
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/SX/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

const CASE_ID = "case-c2";
const DOC_ROW = {
  id: "doc-1",
  companyId: "company-1",
  title: "body",
  format: "markdown",
  latestBody: "# Day plan\n\nOriginal text.",
  latestRevisionId: "rev-1",
  latestRevisionNumber: 1,
  createdByAgentId: null,
  createdByUserId: "user-1",
  updatedByAgentId: null,
  updatedByUserId: "user-1",
  lockedAt: null,
  lockedByAgentId: null,
  lockedByUserId: null,
  createdAt: "2026-10-23T06:00:00.000Z",
  updatedAt: "2026-10-23T06:00:00.000Z",
};

function sxC2(): CaseDetailData {
  return {
    id: CASE_ID,
    companyId: "company-1",
    projectId: null,
    caseNumber: 2,
    identifier: "SX-C2",
    caseType: "day_plan",
    key: null,
    title: "Day plan Friday 2026-10-23",
    summary: null,
    status: "in_progress",
    fields: { open_count: 4, top_priorities: ["Fix trim crash", "Review PRs"], carried_over_from: null },
    parent: null,
    parentCaseId: "case-c3",
    createdByAgentId: null,
    createdByUserId: null,
    completedAt: null,
    createdAt: "2026-10-23T06:00:00.000Z",
    updatedAt: "2026-10-23T06:00:00.000Z",
    labels: [],
    issueLinks: [],
    documents: [{ key: "body", document: DOC_ROW }],
    attachments: [],
  } as unknown as CaseDetailData;
}

async function flush() {
  await reactAct(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void, timeoutMs = 3000) {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await reactAct(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
  }
}

function typeInto(textarea: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  setter.call(textarea, text);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CaseDetail document editing (SX-C2 shape)", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    panelState.openPanel.mockClear();
    panelState.closePanel.mockClear();
    mockCasesApi.get.mockReset().mockResolvedValue(sxC2());
    mockCasesApi.listEvents.mockReset().mockResolvedValue([]);
    mockCasesApi.list.mockReset().mockResolvedValue([]);
    mockCasesApi.listChildren.mockReset().mockResolvedValue([]);
    mockCasesApi.getDocument.mockReset();
    mockCasesApi.listRevisions.mockReset().mockResolvedValue({ key: "body", document: DOC_ROW, revisions: [] });
    mockIssuesApi.listLabels.mockReset().mockResolvedValue([]);
  });
  afterEach(() => {
    container.remove();
  });

  it("edits and saves the body document without the page error, and keeps saving", async () => {
    let revision = 1;
    // Mirrors the PUT /cases/:id/documents/:key response: the raw document row
    // with latestBody, and no top-level `key` or `body`.
    mockCasesApi.upsertDocument.mockReset().mockImplementation(
      async (_id: string, _key: string, data: { body: string }) => {
        revision += 1;
        return {
          document: {
            ...DOC_ROW,
            latestBody: data.body,
            latestRevisionId: `rev-${revision}`,
            latestRevisionNumber: revision,
            updatedAt: "2026-10-23T07:00:00.000Z",
          },
          revision: { id: `rev-${revision}`, revisionNumber: revision, body: data.body },
        };
      },
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await reactAct(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CaseDetail />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(container.textContent).toContain("Original text."));

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Edit document"),
    );
    expect(editButton).toBeTruthy();
    await reactAct(async () => {
      editButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]');
    expect(editor).toBeTruthy();
    await reactAct(async () => {
      typeInto(editor!, "# Day plan\n\nFirst edit.");
    });
    await waitFor(() => expect(mockCasesApi.upsertDocument).toHaveBeenCalledTimes(1));
    expect(mockCasesApi.upsertDocument).toHaveBeenCalledWith(
      "SX-C2",
      "body",
      expect.objectContaining({ body: "# Day plan\n\nFirst edit.", baseRevisionId: "rev-1" }),
    );
    await flush();

    await reactAct(async () => {
      typeInto(container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')!, "# Day plan\n\nSecond edit.");
    });
    await waitFor(() => expect(mockCasesApi.upsertDocument).toHaveBeenCalledTimes(2));
    expect(mockCasesApi.upsertDocument).toHaveBeenLastCalledWith(
      "SX-C2",
      "body",
      expect.objectContaining({ body: "# Day plan\n\nSecond edit.", baseRevisionId: "rev-2" }),
    );
    await flush();

    expect(errors).toEqual([]);
    expect(container.textContent).not.toContain("This page hit an error");
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="editor"]')?.value).toBe(
      "# Day plan\n\nSecond edit.",
    );
    const cached = queryClient.getQueryData<CaseDetailData>(["cases", "detail", "SX-C2"]);
    if (cached) expect(cached.documents.map((entry) => entry.key)).toEqual(["body"]);

    window.removeEventListener("error", onError);
    consoleError.mockRestore();
    await reactAct(async () => {
      root.unmount();
    });
    queryClient.clear();
  });
});
