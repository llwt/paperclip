import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { __liveUpdatesTestUtils } from "@/context/LiveUpdatesProvider";
import { useToastActions } from "@/context/ToastContext";
import { ToastViewport } from "@/components/ToastViewport";
import { Button } from "@/components/ui/button";

// Fork (SX-2551): replays the `heartbeat.run.status` events the server
// publishes for a stop, in order, through the real toast builder. Synthetic
// data only.

type Scenario = "self" | "other" | "failed";

const stop = {
  runId: "run-review-1",
  agentId: "agent-reviewer",
  issueId: "task-1",
  status: "cancelled",
  error: "Cancelled before issue reassignment",
  errorCode: "issue_reassigned",
};
const succeeded = { ...stop, status: "succeeded", error: null, errorCode: null };

const sequences: Record<Scenario, { title: string; events: Array<{ label: string; payload: Record<string, unknown> }> }> = {
  self: {
    title: "The run hands off its own task (change committed)",
    events: [
      { label: "Stop of its own run (marked)", payload: { ...stop, selfHandoffRequested: true } },
      { label: "Run recorded succeeded", payload: succeeded },
    ],
  },
  other: {
    title: "A board user reassigns the task",
    events: [{ label: "Stop by another actor", payload: stop }],
  },
  failed: {
    title: "The run hands off its own task, but the change fails",
    events: [
      { label: "Stop of its own run (marked)", payload: { ...stop, selfHandoffRequested: true } },
      { label: "Stop announced again (change did not commit)", payload: stop },
    ],
  },
};

function RunStatusToastSequence({ scenario }: { scenario: Scenario }) {
  const { pushToast } = useToastActions();
  const { title, events } = sequences[scenario];
  const [sent, setSent] = useState<Array<{ label: string; toast: boolean }>>([]);
  const next = events[sent.length];

  function publishNext() {
    if (!next) return;
    const toast = __liveUpdatesTestUtils.buildRunStatusToast(next.payload, () => "Sr. Engineer Reviewer");
    if (toast) pushToast(toast);
    setSent([...sent, { label: next.label, toast: Boolean(toast) }]);
  }

  return (
    <div className="max-w-xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <ol className="space-y-2 text-sm">
        {events.map((event, index) => {
          const result = sent[index];
          return (
            <li key={event.label} className="rounded border border-border p-2" data-testid={`event-${index}`}>
              <div className="font-medium">{index + 1}. {event.label}</div>
              <code className="text-xs text-muted-foreground">
                status: {String(event.payload.status)}
                {event.payload.selfHandoffRequested ? ", selfHandoffRequested: true" : ""}
              </code>
              <div className="text-xs">
                {result ? (result.toast ? "Toast shown" : "No toast") : "Not published yet"}
              </div>
            </li>
          );
        })}
      </ol>
      <Button onClick={publishNext} disabled={!next}>
        {next ? `Publish event ${sent.length + 1}` : "All events published"}
      </Button>
      <ToastViewport />
    </div>
  );
}

const meta = {
  title: "Live updates/Run status toast for a self hand-off",
  component: RunStatusToastSequence,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof RunStatusToastSequence>;
export default meta;
type Story = StoryObj<typeof meta>;

async function publishAll(canvasElement: HTMLElement, count: number) {
  const canvas = within(canvasElement);
  for (let index = 0; index < count; index += 1) {
    await userEvent.click(canvas.getByRole("button", { name: `Publish event ${index + 1}` }));
  }
  await expect(canvas.getByRole("button", { name: "All events published" })).toBeDisabled();
}

export const SelfHandoffCommitted: Story = {
  args: { scenario: "self" },
  play: async ({ canvasElement }) => {
    await publishAll(canvasElement, 2);
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.queryByText("Sr. Engineer Reviewer run cancelled")).toBeNull();
  },
};

export const StoppedByAnotherActor: Story = {
  args: { scenario: "other" },
  play: async ({ canvasElement }) => {
    await publishAll(canvasElement, 1);
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getByText("Sr. Engineer Reviewer run cancelled")).toBeInTheDocument());
  },
};

export const SelfHandoffChangeFailed: Story = {
  args: { scenario: "failed" },
  play: async ({ canvasElement }) => {
    await publishAll(canvasElement, 2);
    const body = within(canvasElement.ownerDocument.body);
    await waitFor(() => expect(body.getAllByText("Sr. Engineer Reviewer run cancelled")).toHaveLength(1));
  },
};
