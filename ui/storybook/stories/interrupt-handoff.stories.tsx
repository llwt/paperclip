import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { buildAgentMentionHref, parseLeadingAgentMention } from "@paperclipai/shared";
import { ArrowRight, User } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  AssigneeChip,
  AssigneeRunningBanner,
  ComposerHandoffPreviewRow,
  ComposerMentionCoach,
  HandoffWakeRow,
  InterruptAssignConfirm,
  PauseAffectsSummaryView,
  RunStatusBadge,
  type HandoffChipResolvers,
} from "@/components/interrupt-handoff/InterruptHandoffViews";
import {
  computeComposerHandoffPreview,
  computePauseAffectsSummary,
  describeReassignInterrupt,
  extractAgentMentionIds,
  type ComposerHandoffPreviewInput,
} from "@/lib/interrupt-handoff";
import { ToastViewport } from "@/components/ToastViewport";
import { recommendationRequestToast } from "@/components/DecisionTriageStrip";
import { useToastActions } from "@/context/ToastContext";

/**
 * Visual states for the interrupt-handoff UX clarity work (PAP-10669). Each card
 * is one row of the design's state matrix: interrupted → handed to QA,
 * interrupted → waiting on user, and no agent selected.
 */

const MENTION_OWNER_ID = "11111111-1111-4111-8111-111111111111";
const MENTION_QA_ID = "22222222-2222-4222-8222-222222222222";

const resolvers: HandoffChipResolvers = {
  agentMap: new Map([
    ["agent-claude", { name: "ClaudeCoder", icon: null }],
    ["agent-qa", { name: "QA", icon: null }],
    [MENTION_OWNER_ID, { name: "ClaudeCoder", icon: null }],
    [MENTION_QA_ID, { name: "QA", icon: null }],
  ]),
  currentUserId: "user-board",
  resolveUserLabel: (id) => (id === "user-board" ? "Riley Board" : null),
};

const claude = { agentId: "agent-claude", userId: null };
const qa = { agentId: "agent-qa", userId: null };
const board = { agentId: null, userId: "user-board" };
const unassigned = { agentId: null, userId: null };

function ActivityCard({
  title,
  state,
  to,
  interruptedRunAttached,
  composerTarget,
  composerCurrent,
  composerHasActiveRun,
}: {
  title: string;
  state: string;
  to: { agentId: string | null; userId: string | null };
  interruptedRunAttached?: boolean;
  composerTarget: string;
  composerCurrent: string;
  composerHasActiveRun: boolean;
}) {
  const preview = computeComposerHandoffPreview({
    reassignTarget: composerTarget,
    currentAssigneeValue: composerCurrent,
    hasActiveRun: composerHasActiveRun,
    bodyHasAgentMention: false,
    plainNameCandidate: null,
  });
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{state}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Timeline run row */}
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium text-foreground">ClaudeCoder</span>
          <span className="text-muted-foreground">run</span>
          <span className="rounded-md border border-border bg-accent/40 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            3a648d1b
          </span>
          <RunStatusBadge status="cancelled" operatorInterrupted />
        </div>

        {/* Assignee change row + wake row */}
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Assignee</span>
            <AssigneeChip assignee={claude} resolvers={resolvers} />
            <ArrowRight className="h-3 w-3 text-muted-foreground" />
            <AssigneeChip assignee={to} resolvers={resolvers} />
          </div>
          <HandoffWakeRow to={to} resolvers={resolvers} interruptedRunAttached={interruptedRunAttached} />
        </div>

        {/* Composer footer preview */}
        <div className="rounded-md border border-dashed border-border/70 p-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Composer preview</div>
          <ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />
        </div>
      </CardContent>
    </Card>
  );
}

const meta: Meta = {
  title: "Surfaces/Interrupt Handoff",
};
export default meta;

type Story = StoryObj;

export const StateMatrix: Story = {
  render: () => (
    <div className="flex flex-col gap-4 p-4" data-testid="interrupt-handoff-matrix">
      <ActivityCard
        title="A. Interrupted → handed to QA"
        state="Durable assigneeAgentId = QA; QA wake queued."
        to={qa}
        interruptedRunAttached
        composerTarget="agent:agent-qa"
        composerCurrent="agent:agent-claude"
        composerHasActiveRun
      />
      <ActivityCard
        title="B. Interrupted → waiting on user"
        state="assigneeUserId set, agent cleared; no agent wake."
        to={board}
        composerTarget="user:user-board"
        composerCurrent="agent:agent-claude"
        composerHasActiveRun
      />
      <ActivityCard
        title="C. No agent selected"
        state="Run interrupted, no durable owner persisted."
        to={unassigned}
        composerTarget="__none__"
        composerCurrent="agent:agent-claude"
        composerHasActiveRun
      />
    </div>
  ),
};

export const ComposerCoach: Story = {
  render: () => (
    <div className="max-w-xl p-4" data-testid="interrupt-handoff-coach">
      <ComposerMentionCoach
        candidate={{ agentId: "agent-qa", matchedText: "QA" }}
        agentDisplayName="QA"
        onInsert={() => {}}
        onDismiss={() => {}}
      />
    </div>
  ),
};

export const PlainTextWarning: Story = {
  render: () => {
    const preview = computeComposerHandoffPreview({
      reassignTarget: "agent:agent-claude",
      currentAssigneeValue: "agent:agent-claude",
      hasActiveRun: true,
      bodyHasAgentMention: false,
      plainNameCandidate: { agentId: "agent-qa", matchedText: "QA" },
    });
    return (
      <div className="max-w-xl p-4" data-testid="interrupt-handoff-plain-warning">
        <ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />
      </div>
    );
  },
};

/** Surface 2 — standalone assignee picker: grouped sections, the live-run
 * banner, and the "Interrupt & assign" confirm step shown mid-run. */
export const AssigneePicker: Story = {
  render: () => {
    const copy = describeReassignInterrupt({ runningAgentName: "ClaudeCoder" });
    const sectionHeader = (text: string) => (
      <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {text}
      </div>
    );
    return (
      <div className="flex flex-col gap-6 p-4 sm:flex-row" data-testid="interrupt-handoff-assignee-picker">
        <div className="w-60 space-y-1 rounded-md border border-border bg-popover p-1">
          <div className="px-1 pt-1">
            <AssigneeRunningBanner copy={copy} />
          </div>
          {sectionHeader("Agents")}
          <button className="flex w-full items-center gap-2 rounded bg-accent px-2 py-1.5 text-left text-xs">
            ClaudeCoder
          </button>
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50">
            QA
          </button>
          {sectionHeader("Board users")}
          <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50">
            <User className="h-3 w-3 text-muted-foreground" /> Assign to me
          </button>
        </div>
        <div className="w-60 rounded-md border border-border bg-popover p-1">
          <InterruptAssignConfirm
            copy={copy}
            to={qa}
            resolvers={resolvers}
            onConfirm={() => {}}
            onCancel={() => {}}
          />
        </div>
      </div>
    );
  },
};

/** Surface 4 — pause/hold dialog "What this affects" bucket summary. */
export const PauseAffects: Story = {
  render: () => {
    const live = computePauseAffectsSummary([
      { assigneeAgentId: "agent-claude", assigneeUserId: null, activeRun: { status: "running" } },
      { assigneeAgentId: "agent-qa", assigneeUserId: null, activeRun: { status: "queued" } },
      { assigneeAgentId: "agent-claude", assigneeUserId: null, activeRun: null },
      { assigneeAgentId: null, assigneeUserId: "user-board", activeRun: null },
      { assigneeAgentId: null, assigneeUserId: null, activeRun: null },
    ]);
    const idle = computePauseAffectsSummary([
      { assigneeAgentId: null, assigneeUserId: "user-board", activeRun: null },
      { assigneeAgentId: null, assigneeUserId: null, activeRun: null },
    ]);
    return (
      <div className="flex max-w-xl flex-col gap-4 p-4" data-testid="interrupt-handoff-pause-affects">
        <PauseAffectsSummaryView summary={live} />
        <PauseAffectsSummaryView summary={idle} />
      </div>
    );
  },
};

const qaMention = `[@QA](${buildAgentMentionHref(MENTION_QA_ID)})`;
const devMention = `[@Dev](${buildAgentMentionHref("33333333-3333-4333-8333-333333333333")})`;

function LeadingMentionRow({
  title,
  body,
  input,
}: {
  title: string;
  body: string;
  input?: Partial<ComposerHandoffPreviewInput>;
}) {
  const mentionedAgentIds = extractAgentMentionIds(body);
  const preview = computeComposerHandoffPreview({
    reassignTarget: `agent:${MENTION_OWNER_ID}`,
    currentAssigneeValue: `agent:${MENTION_OWNER_ID}`,
    hasActiveRun: false,
    bodyHasAgentMention: mentionedAgentIds.length > 0,
    mentionedAgentId: mentionedAgentIds[0] ?? null,
    plainNameCandidate: null,
    leadingMention: parseLeadingAgentMention(body),
    ...input,
  });
  return (
    <div className="space-y-1 rounded-md border border-dashed border-border/70 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{title}</div>
      <div className="font-mono text-[11px] text-muted-foreground">{body.replace(/\(agent:\/\/[^)]+\)/g, "(agent://…)")}</div>
      <ComposerHandoffPreviewRow preview={preview} resolvers={resolvers} />
    </div>
  );
}

/** Leading-mention handoff preview (SX-1178). Availability is off in the app until the server path ships. */
export const LeadingMentionPreview: Story = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3 p-4" data-testid="leading-mention-preview">
      <div className="text-xs font-medium">Availability off (current default)</div>
      <LeadingMentionRow title="Leading mention" body={`${qaMention} please take this`} />
      <LeadingMentionRow title="Later mention" body={`Context first, ${qaMention} please look`} />
      <div className="pt-2 text-xs font-medium">Availability on (PR 3)</div>
      <LeadingMentionRow
        title="Later mention"
        body={`Context first, ${qaMention} please look`}
        input={{ handoffAvailable: true }}
      />
      <LeadingMentionRow
        title="Unknown gates"
        body={`${qaMention} please take this`}
        input={{ handoffAvailable: true }}
      />
      <LeadingMentionRow
        title="Refused: confirmation pending"
        body={`${qaMention} please take this`}
        input={{ handoffAvailable: true, handoffCheck: { kind: "refused", reasonCode: "confirmation_pending" } }}
      />
      <LeadingMentionRow
        title="Refused: two recipients"
        body={`${qaMention} ${devMention} take this`}
        input={{ handoffAvailable: true }}
      />
      <LeadingMentionRow
        title="Eligible, agent running"
        body={`${qaMention} please take this`}
        input={{ handoffAvailable: true, hasActiveRun: true, handoffCheck: { kind: "eligible" } }}
      />
      <LeadingMentionRow
        title="Explicit picker wins"
        body={`${qaMention} please take this`}
        input={{ handoffAvailable: true, reassignTarget: "user:user-board", handoffCheck: { kind: "eligible" } }}
      />
    </div>
  ),
};

function RecommendationToastDemo() {
  const { pushToast } = useToastActions();
  useEffect(() => {
    pushToast({ ...recommendationRequestToast("Planner"), ttlMs: 600_000 });
  }, [pushToast]);
  return <ToastViewport />;
}

/** Decisions desk "Ask agent for recommendation" success toast. */
export const DecisionsDeskRecommendationToast: Story = {
  render: () => (
    <div className="min-h-[200px] p-4" data-testid="decisions-desk-toast">
      <RecommendationToastDemo />
    </div>
  ),
};
