// Fork (SX-1747): end-to-end proof that a legacy local CLI run adopted after
// one or two hot restarts ends with the provider's real result.
//
// Everything between the child and the run row is real: the adoption, the
// output tail that copies the relay into the run log, the reaper, the adapter's
// recovery hook and the shared finalizer. Only the child's output is synthetic
// (a fake relay directory written by the test), and the database is an
// isolated one. No provider is started and no live run or service is touched.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, inArray, or } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { writeHotRestartIntent } from "../services/hot-restart.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { heartbeatService } from "../services/heartbeat.js";

// A process-loss retry (the fallback case) is queued as a real run; it must
// never reach a real provider.
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "synthetic retry",
        provider: "test",
        model: "test-model",
      })),
    })),
  };
});

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping adopted run restart proof on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const jsonLine = (value: unknown) => `${JSON.stringify(value)}\n`;

const CODEX_THREAD_ID = "019a0000-0000-7000-8000-000000000001";
const CLAUDE_SESSION_ID = "11111111-1111-4111-8111-111111111111";

type Provider = "claude_local" | "codex_local";

interface Scenario {
  name: string;
  provider: Provider;
  /** Complete lines, then optionally a final line that is cut by the restart. */
  lines: string[];
  /** An unterminated last line that never completes, so the final event is damaged. */
  truncatedTail?: string;
  expect:
    | { kind: "succeeded"; summary: string; sessionId: string; costCents?: number }
    | { kind: "failed"; message: string }
    | { kind: "process_lost"; reason: string };
}

const claudeInit = jsonLine({ type: "system", subtype: "init", session_id: CLAUDE_SESSION_ID, model: "claude-opus" });
const claudeAssistant = jsonLine({
  type: "assistant",
  message: { content: [{ type: "text", text: "Working on it" }] },
});
const codexStart = [
  jsonLine({ type: "thread.started", thread_id: CODEX_THREAD_ID }),
  jsonLine({ type: "turn.started" }),
];

const scenarios: Scenario[] = [
  {
    name: "Claude success",
    provider: "claude_local",
    lines: [
      claudeInit,
      claudeAssistant,
      jsonLine({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "All done",
        session_id: CLAUDE_SESSION_ID,
        total_cost_usd: 0.42,
        usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 },
      }),
    ],
    expect: { kind: "succeeded", summary: "All done", sessionId: CLAUDE_SESSION_ID, costCents: 42 },
  },
  {
    name: "Claude failure",
    provider: "claude_local",
    lines: [
      claudeInit,
      claudeAssistant,
      jsonLine({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: CLAUDE_SESSION_ID,
        errors: ["provider rejected the request"],
      }),
    ],
    expect: { kind: "failed", message: "provider rejected the request" },
  },
  {
    name: "Codex success",
    provider: "codex_local",
    lines: [
      ...codexStart,
      jsonLine({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
      jsonLine({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 9 } }),
    ],
    expect: { kind: "succeeded", summary: "final answer", sessionId: CODEX_THREAD_ID },
  },
  {
    name: "Codex failure",
    provider: "codex_local",
    lines: [...codexStart, jsonLine({ type: "turn.failed", error: { message: "provider rejected the request" } })],
    expect: { kind: "failed", message: "provider rejected the request" },
  },
  {
    name: "Claude with no final event",
    provider: "claude_local",
    lines: [claudeInit, claudeAssistant],
    expect: { kind: "process_lost", reason: "hook_inconclusive" },
  },
  {
    name: "Codex with no final event",
    provider: "codex_local",
    lines: [...codexStart, jsonLine({ type: "item.completed", item: { type: "agent_message", text: "almost" } })],
    expect: { kind: "process_lost", reason: "hook_inconclusive" },
  },
  {
    name: "Codex with a damaged final event",
    provider: "codex_local",
    lines: [...codexStart, jsonLine({ type: "item.completed", item: { type: "agent_message", text: "almost" } })],
    truncatedTail: '{"type":"turn.completed","usage":{"input_tok',
    expect: { kind: "process_lost", reason: "log_inconclusive" },
  },
];

// The last line of a scenario is cut in the middle at the restart, so the
// provider's final event is the one that spans two server lifetimes. The tail
// records the partial line as it reads it; the reader joins the pieces.
function splitAcrossRestart(scenario: Scenario) {
  const body = scenario.lines.slice(0, -1).join("");
  const last = scenario.lines[scenario.lines.length - 1]!;
  if (scenario.truncatedTail !== undefined) {
    return { first: scenario.lines.join("") + scenario.truncatedTail, rest: "" };
  }
  const cut = Math.floor(last.length / 2);
  return { first: body + last.slice(0, cut), rest: last.slice(cut) };
}

function snapshotFor(provider: Provider) {
  const anthropic = provider === "claude_local";
  return {
    version: 1,
    adapterType: provider,
    taskKey: null,
    configuredModel: null,
    session: {
      previousParams: null,
      dispatched: { sessionId: null, sessionDisplayId: null, params: null },
      taskSessionReused: false,
      rotated: false,
      rotationReason: null,
      config: { version: 1, fingerprint: "fp", categories: [], categoryFingerprints: {}, aiCredentialIdentity: null },
    },
    configFreshness: {},
    invocation: {
      number: 1,
      firstSeq: 1,
      startedAt: "2026-03-19T00:00:00.000Z",
      engine: "cli",
      sessionIdBefore: null,
      freshSessionRetry: false,
      sessionParams: null,
      accounting: {
        provider: anthropic ? "anthropic" : "openai",
        biller: anthropic ? "anthropic" : "openai",
        model: null,
        billingType: "api",
      },
    },
  };
}

function isPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isPidAlive(pid);
}

async function withTempPaperclipHome<T>(fn: () => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adopted-proof-"));
  const previousHome = process.env.PAPERCLIP_HOME;
  process.env.PAPERCLIP_HOME = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function writeFakeRelay(runId: string, stdout: string, status: "running" | "ended") {
  const relayDir = path.join(resolvePaperclipInstanceRoot(), "data", "run-output-relay", runId);
  await fs.mkdir(relayDir, { recursive: true });
  await fs.appendFile(path.join(relayDir, "stdout.log"), Buffer.from(stdout));
  // Replaced by rename: a tail polling meanwhile must never read a half-written state.
  const statePath = path.join(relayDir, "state.json");
  await fs.writeFile(
    `${statePath}.tmp`,
    JSON.stringify({
      version: 1,
      status,
      // This test process stands in for a live relay.
      relayPid: process.pid,
      startedAt: "2026-03-19T00:06:00.000Z",
    }),
  );
  await fs.rename(`${statePath}.tmp`, statePath);
}

describeEmbeddedPostgres("adopted run result after hot restarts", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const childProcesses = new Set<ChildProcess>();
  const servers = new Set<ReturnType<typeof heartbeatService>>();

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adopted-run-proof-");
      db = createDb(tempDb.connectionString);
    }
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 20_000);

  afterEach(async () => {
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
    // The fallback case queues a retry; stop whatever is still active so the
    // next test only sees its own runs.
    const active = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    if (active.length > 0) {
      const now = new Date();
      await db
        .update(heartbeatRuns)
        .set({
          status: "cancelled",
          finishedAt: now,
          updatedAt: now,
          errorCode: "test_cleanup",
          error: "Cancelled by adopted run restart proof cleanup",
          processPid: null,
          processGroupId: null,
        })
        .where(inArray(heartbeatRuns.id, active.map((run) => run.id)));
    }
    for (const server of servers) await server.drainActiveRunExecutions();
    servers.clear();
  });

  afterAll(async () => {
    for (const child of childProcesses) child.kill("SIGKILL");
    childProcesses.clear();
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
    await tempDb?.cleanup();
  });

  // A server lifetime. The leftover sweep is stubbed so no host process is scanned.
  function newServer() {
    const server = heartbeatService(db, {
      adoptedRunLeftoverSweep: { sweep: vi.fn(async () => null) },
    });
    servers.add(server);
    return server;
  }

  async function seedAdoptableRun(provider: Provider, childPid: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const startedAt = new Date("2026-03-19T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "running",
      adapterType: provider,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "claimed",
      runId,
      claimedAt: startedAt,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Adopted run result proof",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      wakeupRequestId,
      contextSnapshot: {
        issueId,
        executionEngine: "cli",
        processTopology: "detached",
        localResultRecovery: snapshotFor(provider),
      },
      processPid: childPid,
      processGroupId: null,
      nextEventSeq: 2,
      logStore: "local_file",
      logRef: path.join(companyId, agentId, `${runId}.ndjson`),
      startedAt,
      updatedAt: startedAt,
    });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      agentId,
      runId,
      seq: 1,
      eventType: "adapter.invoke",
      payload: { adapterType: provider },
    });
    await db.update(issues).set({ checkoutRunId: runId, executionRunId: runId }).where(eq(issues.id, issueId));
    return { companyId, agentId, runId, issueId };
  }

  async function readStdout(companyId: string, agentId: string, runId: string) {
    const log = await getRunLogStore()
      .read(
        { store: "local_file", logRef: path.join(companyId, agentId, `${runId}.ndjson`) },
        { limitBytes: 8 * 1024 * 1024 },
      )
      .catch(() => ({ content: "" }));
    return log.content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { stream: string; chunk: string })
      .filter((record) => record.stream === "stdout")
      .map((record) => record.chunk)
      .join("");
  }

  async function waitForStdout(companyId: string, agentId: string, runId: string, expected: string) {
    const deadline = Date.now() + 5_000;
    let seen = "";
    while (Date.now() < deadline) {
      seen = await readStdout(companyId, agentId, runId);
      if (seen === expected) return seen;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return seen;
  }

  async function hotRestart(from: ReturnType<typeof heartbeatService>, at: string) {
    await writeHotRestartIntent({
      previousServerPid: process.pid,
      previousServerVersion: "old-version",
      requestedAt: new Date(at),
    });
    await from.prepareHotRestartShutdown("SIGTERM", new Date(new Date(at).getTime() + 30_000));
  }

  async function loadRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
  }

  function resultRecoveryOf(run: { resultJson: unknown }) {
    const hotRestart = (run.resultJson as Record<string, unknown> | null)?.hotRestart as
      | Record<string, unknown>
      | undefined;
    return (hotRestart?.resultRecovery ?? null) as Record<string, unknown> | null;
  }

  // Drives one run through `restarts` hot restarts and the end of its child,
  // and returns the server that reaps it.
  async function driveRun(scenario: Scenario, restarts: 1 | 2) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    childProcesses.add(child);
    const ids = await seedAdoptableRun(scenario.provider, child.pid!);
    const { companyId, agentId, runId } = ids;
    const { first, rest } = splitAcrossRestart(scenario);

    // Restart 1: the first new server adopts the live child and starts tailing its relay.
    await writeFakeRelay(runId, first, "running");
    const serverA = newServer();
    await hotRestart(serverA, "2026-03-19T00:05:00.000Z");
    const adoptionA = await serverA.reconcileHotRestartAdoption(new Date("2026-03-19T00:06:00.000Z"));
    expect(adoptionA).toMatchObject({ adoptedRunIds: [runId] });

    let reaper = serverA;
    if (restarts === 2) {
      // Restart 2: the first new server stops with only part of the final
      // event recorded; the next server picks up from its saved offsets.
      expect(await waitForStdout(companyId, agentId, runId, first)).toBe(first);
      await hotRestart(serverA, "2026-03-19T00:09:00.000Z");
      expect(await serverA.waitForAdoptedRunOutputTails(0)).toBe(true);
      await writeFakeRelay(runId, rest, "ended");
      const serverB = newServer();
      const adoptionB = await serverB.reconcileHotRestartAdoption(new Date("2026-03-19T00:10:00.000Z"));
      expect(adoptionB).toMatchObject({ adoptedRunIds: [runId] });
      reaper = serverB;
    } else {
      await writeFakeRelay(runId, rest, "ended");
    }

    expect(await reaper.waitForAdoptedRunOutputTails()).toBe(true);
    // Whatever the relay held is now in the run log, and the run is still running.
    expect(await readStdout(companyId, agentId, runId)).toBe(first + rest);
    expect((await loadRun(runId)).status).toBe("running");

    child.kill("SIGKILL");
    expect(await waitForPidExit(child.pid!)).toBe(true);
    return { ...ids, reaper };
  }

  const matrix = scenarios.flatMap((scenario) =>
    ([1, 2] as const).map((restarts) => ({ scenario, restarts, name: `${scenario.name} after ${restarts} restart${restarts === 1 ? "" : "s"}` })),
  );

  it.each(matrix)("$name", async ({ scenario, restarts }) => {
    await withTempPaperclipHome(async () => {
      const { runId, agentId, issueId, reaper } = await driveRun(scenario, restarts);

      const reap = await reaper.reapOrphanedRuns();
      expect(reap).toEqual({ reaped: 1, runIds: [runId] });

      const run = await loadRun(runId);
      const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
      const costs = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId));
      const recovery = resultRecoveryOf(run);
      const expected = scenario.expect;

      // The OS exit status is never known for an adopted child.
      expect(run.exitCode).toBeNull();
      expect(run.finishedAt).toBeInstanceOf(Date);
      expect(recovery).toMatchObject({ version: 1, source: "run_log", exitCodeKnown: false });

      if (expected.kind === "succeeded") {
        expect(run).toMatchObject({ status: "succeeded", errorCode: null, sessionIdAfter: expected.sessionId });
        expect(run.resultJson).toMatchObject({ summary: expected.summary });
        expect(recovery).toMatchObject({ decision: "recovered", outcome: "succeeded", receipt: "drained" });
        expect(retries).toHaveLength(0);
        expect(costs).toHaveLength(1);
        const runtime = await db
          .select()
          .from(agentRuntimeState)
          .where(eq(agentRuntimeState.agentId, agentId))
          .then((rows) => rows[0] ?? null);
        expect(runtime).toMatchObject({ lastRunId: runId, lastRunStatus: "succeeded" });
        if (expected.costCents !== undefined) expect(runtime?.totalCostCents).toBe(expected.costCents);
        const issue = await db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
        expect(issue.checkoutRunId).not.toBe(runId);
      } else if (expected.kind === "failed") {
        // The provider's own failure, not a lost process: no process-loss retry.
        expect(run.status).toBe("failed");
        expect(run.errorCode).not.toBe("process_lost");
        expect(run.error).toContain(expected.message);
        expect(recovery).toMatchObject({ decision: "recovered", outcome: "failed", receipt: "drained" });
        expect(run).toMatchObject({ errorCode: "adapter_failed" });
        expect(run.error).not.toMatch(/process lost|retrying once/i);
        // The ordinary bounded retry of a provider failure applies once; process loss adds no second one.
        expect(retries).toHaveLength(1);
        expect(retries[0]).toMatchObject({
          retryOfRunId: runId,
          contextSnapshot: { retryReason: "transient_failure", executionRetryAccounting: { failureRetries: 1 } },
        });
      } else {
        // Missing or damaged final event: the unchanged process-loss path.
        expect(run).toMatchObject({ status: "failed", errorCode: "process_lost" });
        expect(recovery).toMatchObject({ reason: expected.reason });
        expect(recovery?.decision).not.toBe("recovered");
        expect(run.resultJson).toMatchObject({ hotRestart: { adopted: true, outputCapture: { mode: "relay" } } });
        expect(run.error).toContain("retrying once");
        expect(retries).toHaveLength(1);
        expect(retries[0]).toMatchObject({
          retryOfRunId: runId,
          contextSnapshot: { retryReason: "transient_failure", scheduledRetryAttempt: 1 },
        });
      }

      // A later sweep, or another server, leaves the settled run alone.
      expect(await reaper.reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
      expect(await newServer().reapOrphanedRuns()).toEqual({ reaped: 0, runIds: [] });
      expect(await loadRun(runId)).toMatchObject({ status: run.status, errorCode: run.errorCode });
      expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, runId))).toHaveLength(
        costs.length,
      );
    });
  });
});
