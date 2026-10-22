import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { LiveRunForIssue } from "@/api/heartbeats";
import { useQueryClient } from "@tanstack/react-query";
import { LiveRunWidget } from "@/components/LiveRunWidget";
import { queryKeys } from "@/lib/queryKeys";

// A live run next to a finished run. Every tick the live run writes a line and
// its known log size changes, which re-runs the transcript read effect. The
// table counts `GET /heartbeat-runs/:id/log` per run: the finished run is read
// once, not again on every live update.

const issueId = "issue-run-log-reads";
const finishedRunId = "run-finished";
const liveRunId = "run-live";
const tickMs = 1500;
const liveTicks = 6;

// One persisted log row holding one Claude stream-json assistant message.
function logLine(ts: string, text: string): string {
  const message = { type: "assistant", message: { content: [{ type: "text", text }] } };
  return `${JSON.stringify({ ts, stream: "stdout", chunk: `${JSON.stringify(message)}\n` })}\n`;
}

const finishedLog = [
  logLine("2026-10-22T09:00:00.000Z", "Read the task and the linked files."),
  logLine("2026-10-22T09:00:05.000Z", "Ran the tests: 12 passed."),
  logLine("2026-10-22T09:00:09.000Z", "Posted the result on the task."),
].join("");

const store = {
  liveLog: "",
  liveStatus: "running" as "running" | "succeeded",
  reads: new Map<string, number>(),
  listeners: new Set<() => void>(),
};

function runFixture(id: string, status: string, log: string, minutesAgo: number): LiveRunForIssue {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return {
    id,
    status,
    invocationSource: "manual",
    triggerDetail: "issue_assigned",
    startedAt: at,
    finishedAt: status === "running" ? null : at,
    createdAt: at,
    agentId: "agent-codex",
    agentName: id === liveRunId ? "CodexCoder" : "QAChecker",
    adapterType: "claude_local",
    issueId,
    logBytes: log.length,
  } as LiveRunForIssue;
}

function liveRuns(): LiveRunForIssue[] {
  return [
    runFixture(liveRunId, store.liveStatus, store.liveLog, 1),
    runFixture(finishedRunId, "succeeded", finishedLog, 5),
  ];
}

function installRunLogFixtures() {
  const previousFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.origin);
    if (url.pathname === `/api/issues/${issueId}/live-runs`) return Response.json(liveRuns());
    if (url.pathname === `/api/issues/${issueId}/active-run`) return Response.json(null);
    const logMatch = url.pathname.match(/^\/api\/heartbeat-runs\/([^/]+)\/log$/);
    if (logMatch) {
      const runId = logMatch[1]!;
      store.reads.set(runId, (store.reads.get(runId) ?? 0) + 1);
      store.listeners.forEach((listener) => listener());
      const content = runId === finishedRunId ? finishedLog : store.liveLog;
      const offset = Number(url.searchParams.get("offset") ?? 0);
      // Like the run-log store: the last page carries no `nextOffset`.
      return Response.json({ runId, store: "memory", logRef: runId, content: content.slice(offset) });
    }
    return previousFetch(input, init);
  };
  return () => {
    window.fetch = previousFetch;
  };
}

function RunLogReadsDemo() {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  const [tick, setTick] = useState(0);
  const [, setReadsVersion] = useState(0);

  useEffect(() => {
    store.liveLog = logLine(new Date().toISOString(), "Started the run.");
    store.liveStatus = "running";
    store.reads.clear();
    const restoreFetch = installRunLogFixtures();
    const listener = () => setReadsVersion((value) => value + 1);
    store.listeners.add(listener);
    queryClient.removeQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
    queryClient.removeQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
    setReady(true);
    return () => {
      store.listeners.delete(listener);
      restoreFetch();
    };
  }, [queryClient]);

  useEffect(() => {
    if (!ready || tick >= liveTicks) return;
    const timer = window.setTimeout(() => {
      const next = tick + 1;
      store.liveLog += logLine(new Date().toISOString(), `Step ${next} of ${liveTicks}: wrote more output.`);
      if (next === liveTicks) store.liveStatus = "succeeded";
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      setTick(next);
    }, tickMs);
    return () => window.clearTimeout(timer);
  }, [queryClient, ready, tick]);

  return (
    <div className="paperclip-story">
      <main className="paperclip-story__inner space-y-6">
        <section className="paperclip-story__frame overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <div className="paperclip-story__label">LiveRunWidget</div>
            <h2 className="mt-1 text-xl font-semibold">Run log reads: one live run, one finished run</h2>
          </div>
          <div className="space-y-4 p-5">
            <table className="text-sm" data-testid="run-log-reads">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-6 font-medium">Run</th>
                  <th className="pr-6 font-medium">Status</th>
                  <th className="font-medium">Log reads</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="pr-6">{liveRunId}</td>
                  <td className="pr-6">{store.liveStatus} (update {tick} of {liveTicks})</td>
                  <td data-testid="reads-live">{store.reads.get(liveRunId) ?? 0}</td>
                </tr>
                <tr>
                  <td className="pr-6">{finishedRunId}</td>
                  <td className="pr-6">succeeded</td>
                  <td data-testid="reads-finished">{store.reads.get(finishedRunId) ?? 0}</td>
                </tr>
              </tbody>
            </table>
            {ready ? <LiveRunWidget issueId={issueId} companyId="company-storybook" /> : null}
          </div>
        </section>
      </main>
    </div>
  );
}

const meta = {
  title: "Product/Run log reads",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const LiveAndFinishedRun: Story = {
  name: "Live and finished run",
  render: () => <RunLogReadsDemo />,
};
