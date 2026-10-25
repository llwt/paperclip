import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import type { AskUserQuestionsInteraction, IssueComment, RequestConfirmationInteraction } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { TaskChatThread } from "@/components/TaskChatThread";
import {
  pendingAskUserQuestionsInteraction,
  pendingRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

// Fork (SX-1581): one run posts a confirmation and, 0.1 s later, a question
// with a legacy payload (no questionSet, a free-text option, allowOther). The
// user has since written a comment; both cards stay docked anyway (SX-1603).
const issueId = "task-confirmation-and-question-demo";
const confirmation: RequestConfirmationInteraction = {
  ...pendingRequestConfirmationInteraction,
  id: "same-run-confirmation", issueId, sourceRunId: "same-run", title: "Copy route and folder layout",
  createdAt: new Date("2026-04-01T12:01:00.000Z"),
  payload: { version: 1, prompt: "Approve the copy route as in the plan?", acceptLabel: "Approve", rejectLabel: "Request changes" },
};
const question: AskUserQuestionsInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "same-run-question", issueId, sourceRunId: "same-run", title: "Copy of the report set",
  createdAt: new Date("2026-04-01T12:01:00.100Z"),
  payload: {
    version: 1, supersedeOnUserComment: false,
    questions: [
      { id: "route", prompt: "Which route copies the set?", selectionMode: "single", required: true, allowOther: true,
        options: [{ id: "a", label: "A: upload in the browser" }, { id: "b", label: "B: copy over ssh" }] },
      { id: "directory", prompt: "Which folder should hold the set?", selectionMode: "single", required: true,
        options: [{ id: "path", label: "I'll type the path", freeText: true }] },
    ],
  },
};
function comment(id: string, body: string, at: string, agent = false): IssueComment {
  return { id, companyId: question.companyId, issueId, body, authorType: agent ? "agent" : "user",
    authorAgentId: agent ? question.createdByAgentId ?? null : null, authorUserId: agent ? null : "user-board",
    presentation: null, metadata: null, createdAt: new Date(at), updatedAt: new Date(at) };
}

function ConfirmationAndQuestion() {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData([...queryKeys.issues.documents(issueId), "plan"], null);
    return client;
  });
  const [interactions, setInteractions] = useState<Array<RequestConfirmationInteraction | AskUserQuestionsInteraction>>([confirmation, question]);
  const comments = [
    comment("start", "Please prepare the yearly report set and a copy route.", "2026-04-01T12:00:00Z"),
    comment("agent-plan", "The plan is ready. I need your approval and two answers.", "2026-04-01T12:01:01Z", true),
    comment("user-later", "I'll look at the plan tonight.", "2026-04-01T12:05:00Z"),
  ];
  return <QueryClientProvider client={queryClient}><div className="flex h-screen flex-col bg-background text-foreground">
    <TaskChatThread comments={comments} interactions={interactions} issueId={issueId} issueStatus="in_progress"
      currentUserId="user-board" agentMap={storybookAgentMap} enableLiveTranscriptPolling={false}
      threadHeader={<div className="p-4"><h1 className="text-xl font-semibold">Prepare the yearly report set</h1></div>}
      onAdd={async () => {}}
      onAcceptInteraction={async interaction => {
        setInteractions(rows => rows.map(row => row.id === interaction.id ? { ...row, status: "accepted", resolvedAt: new Date() } as typeof row : row));
      }}
      onRejectInteraction={async () => {}}
      onSubmitInteractionAnswers={async (interaction, answers) => {
        setInteractions(rows => rows.map(row => row.id === interaction.id ? { ...row, status: "answered", resolvedAt: new Date(), result: { version: 1, answers } } as typeof row : row));
      }}
    />
  </div></QueryClientProvider>;
}

const meta = {
  title: "Chat & Comments/Task Chat Confirmation And Question",
  parameters: { layout: "fullscreen" },
  component: ConfirmationAndQuestion,
  beforeEach: () => {
    localStorage.removeItem(`paperclip:task-question-dismissals:user-board:${issueId}`);
    for (const key of Object.keys(localStorage)) {
      if (key.includes(`paperclip:task-input:${issueId}:`)) localStorage.removeItem(key);
    }
  },
} satisfies Meta<typeof ConfirmationAndQuestion>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SameRun: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toHaveTextContent("Which route copies the set?"));
    await expect(canvas.getByRole("button", { name: "2 pending" })).toBeVisible();
  },
};
export const SameRunDismissed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: /^Dismiss / }));
    await expect(canvas.getByTestId("task-chat-pending-input-indicator")).toHaveTextContent("2 pending inputs");
  },
};
export const AnswerBoth: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toHaveTextContent("Which route copies the set?"));
    await userEvent.click(canvas.getByRole("button", { name: "2 pending" }));
    await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toHaveTextContent("Approve the copy route"));
    await userEvent.click(canvas.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(canvas.getByTestId("task-chat-composer-takeover")).toHaveTextContent("Which route copies the set?"));
  },
};
