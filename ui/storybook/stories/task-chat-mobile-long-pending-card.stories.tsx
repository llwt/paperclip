import { useState, type CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AskUserQuestionsInteraction, IssueComment, RequestConfirmationInteraction } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MobileBottomNav } from "@/components/MobileBottomNav";
import { TaskChatThread } from "@/components/TaskChatThread";
import { queryKeys } from "@/lib/queryKeys";
import {
  pendingAskUserQuestionsInteraction,
  pendingRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import { storybookAgentMap } from "../fixtures/paperclipData";

const issueId = "task-mobile-long-pending-card";
const longMarkdown = Array.from(
  { length: 60 },
  (_, index) => `${index + 1}. Plan step ${index + 1}: check the synthetic report section ${index + 1} and record the result.`,
).join("\n");

const longConfirmation: RequestConfirmationInteraction = {
  ...pendingRequestConfirmationInteraction,
  id: "long-confirmation",
  issueId,
  title: "Approve the long plan",
  payload: {
    version: 1,
    prompt: "Approve this 60 step plan?",
    acceptLabel: "Approve",
    rejectLabel: "Request changes",
    rejectRequiresReason: true,
    detailsMarkdown: longMarkdown,
  },
};

const longQuestions: AskUserQuestionsInteraction = {
  ...pendingAskUserQuestionsInteraction,
  id: "long-questions",
  issueId,
  title: "Choose the report options",
  payload: {
    version: 1,
    supersedeOnUserComment: false,
    questions: Array.from({ length: 8 }, (_, index) => ({
      id: `question-${index + 1}`,
      prompt: `Question ${index + 1}: which option should section ${index + 1} use?`,
      selectionMode: "single" as const,
      required: true,
      options: [
        { id: "a", label: `Option A for section ${index + 1}` },
        { id: "b", label: `Option B for section ${index + 1}` },
        { id: "c", label: `Option C for section ${index + 1}` },
      ],
    })),
  },
};

function comment(index: number): IssueComment {
  const at = new Date(Date.UTC(2026, 3, 1, 12, index));
  return { id: `history-${index}`, companyId: longQuestions.companyId, issueId,
    body: `Earlier message ${index + 1}: the synthetic report set is progressing as planned.`,
    authorType: index % 2 ? "agent" : "user", authorAgentId: index % 2 ? longQuestions.createdByAgentId ?? null : null,
    authorUserId: index % 2 ? null : "user-board", presentation: null, metadata: null, createdAt: at, updatedAt: at };
}
const history = Array.from({ length: 12 }, (_, index) => comment(index));

function LongPendingCard({ interaction }: { interaction: RequestConfirmationInteraction | AskUserQuestionsInteraction }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData([...queryKeys.issues.documents(issueId), "plan"], null);
    return client;
  });
  return <QueryClientProvider client={queryClient}>
    <div className="flex min-h-dvh flex-col bg-background px-4 pb-(--tc-composer-visible-nav-offset) text-foreground"
      style={{ "--tc-composer-bottom": "var(--tc-composer-visible-nav-offset)" } as CSSProperties}>
      <TaskChatThread comments={history} interactions={[interaction]} issueId={issueId} issueStatus="in_progress"
        currentUserId="user-board" agentMap={storybookAgentMap} enableLiveTranscriptPolling={false}
        threadHeader={<div className="p-4"><h1 className="text-xl font-semibold">Prepare the yearly report set</h1></div>}
        onAdd={async () => {}} onAcceptInteraction={async () => {}} onRejectInteraction={async () => {}}
        onSubmitInteractionAnswers={async () => {}} />
      <MobileBottomNav visible />
    </div>
  </QueryClientProvider>;
}

const meta = {
  title: "Task chat/Mobile long pending card",
  component: LongPendingCard,
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "A pending card with a long body above the composer on a phone. The card is bounded to the viewport and scrolls on its own. Synthetic data only." } },
  },
  globals: { theme: "light", viewport: { value: "mobile", isRotated: false } },
} satisfies Meta<typeof LongPendingCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const LongConfirmation: Story = { args: { interaction: longConfirmation } };
export const LongQuestions: Story = { args: { interaction: longQuestions } };
