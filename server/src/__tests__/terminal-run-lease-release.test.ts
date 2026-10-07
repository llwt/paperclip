import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

// A promoted wake starts a real run. Keep it away from a real agent CLI.
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Terminal-run lease release test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.ts";
import { readProcessStartedAt } from "../services/hot-restart.ts";
import {
  decideTerminalRunLeaseRelease,
  type TerminalRunLeaseProbes,
} from "../services/terminal-run-lease-release.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal-run lease release tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// No process or process group on Linux or macOS can have this id, so a signal
// to it fails with ESRCH.
const DEAD_ID = 2_000_000_000;

function errno(code: string) {
  return Object.assign(new Error(code), { code });
}

/** Probes for the decision tests. `alive` lists signal targets that answer;
 * a process group is the negative of its id. */
function fakeProbes(input: {
  alive?: number[];
  denied?: number[];
  startedAt?: Record<number, string | Error>;
  platform?: NodeJS.Platform;
}): TerminalRunLeaseProbes {
  return {
    platform: input.platform ?? "linux",
    signalZero(target) {
      if (input.denied?.includes(target)) throw errno("EPERM");
      if (!input.alive?.includes(target)) throw errno("ESRCH");
    },
    async readProcessStartedAt(pid) {
      const value = input.startedAt?.[pid];
      if (value === undefined || value instanceof Error) throw value ?? errno("ENOENT");
      return value;
    },
  };
}

describeEmbeddedPostgres("environment lease release for ended terminal runs", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-run-lease-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    for (const child of children.splice(0)) await stopProcess(child);
    mockAdapterExecute.mockClear();
    // A promoted wake runs in the background and writes rows in many tables.
    // Wait for it, then clear every table that hangs off a company.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(sql`truncate table companies, environments cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** A real process in its own process group, like an agent kept across a
   * server restart: alive, but with no handle in the heartbeat service. */
  async function startKeptProcess() {
    const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
    children.push(child);
    const pid = child.pid!;
    const startedAt = new Date(await readProcessStartedAt(pid));
    return { child, pid, startedAt };
  }

  async function stopProcess(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }

  async function seed(input: {
    runStatus: string;
    issueStatus?: string;
    lockIssue?: boolean;
    run?: Partial<typeof heartbeatRuns.$inferInsert>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    // The instance has one local environment, shared by every company.
    const environmentId = await db
      .select({ id: environments.id })
      .from(environments)
      .where(eq(environments.driver, "local"))
      .then(async (rows) => {
        if (rows[0]) return rows[0].id;
        const id = randomUUID();
        await db.insert(environments).values({
          id,
          name: "Local",
          driver: "local",
          status: "active",
          config: {},
        });
        return id;
      });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: input.runStatus,
      invocationSource: "manual",
      startedAt: new Date(),
      finishedAt: input.runStatus === "running" ? null : new Date(),
      contextSnapshot: { issueId },
      // The ownership blocker reads the adapter from immutable run evidence.
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
      processPid: DEAD_ID,
      processGroupId: DEAD_ID,
      ...input.run,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Lease release",
      status: input.issueStatus ?? "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      checkoutRunId: input.lockIssue ? runId : null,
      executionRunId: input.lockIssue ? runId : null,
      executionLockedAt: input.lockIssue ? new Date() : null,
    });
    const leaseId = await insertLease({ companyId, runId, issueId, environmentId });
    return { companyId, agentId, issueId, runId, environmentId, leaseId };
  }

  async function insertLease(input: {
    companyId: string;
    runId: string;
    issueId: string;
    environmentId: string | null;
    provider?: string;
  }) {
    const id = randomUUID();
    await db.insert(environmentLeases).values({
      id,
      companyId: input.companyId,
      environmentId: input.environmentId,
      issueId: input.issueId,
      heartbeatRunId: input.runId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: input.provider ?? "local",
      metadata: { driver: input.provider && input.provider !== "local" ? "sandbox" : "local" },
    });
    return id;
  }

  async function readLease(id: string) {
    return db
      .select({
        status: environmentLeases.status,
        releasedAt: environmentLeases.releasedAt,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, id))
      .then((rows) => rows[0]!);
  }

  async function readRunStatus(id: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, id))
      .then((rows) => rows[0]!);
  }

  function decide(
    ids: { runId: string; companyId: string },
    probes: TerminalRunLeaseProbes = fakeProbes({}),
    hasLocalExecution = false,
  ) {
    return decideTerminalRunLeaseRelease(db, ids, {
      hasLocalExecution: () => hasLocalExecution,
      probes,
    });
  }

  describe("release decision", () => {
    it("releases when the recorded process and process group are gone", async () => {
      const ids = await seed({ runStatus: "interrupted" });
      const decision = await decide(ids);
      expect(decision).toMatchObject({ release: true, leaseIds: [ids.leaseId] });
    });

    it.each([
      ["a live process", { alive: [4242] }, "process_may_be_alive"],
      ["a dead process with a live process group", { alive: [-4242] }, "process_group_may_be_alive"],
      ["a probe that is denied", { denied: [4242] }, "process_may_be_alive"],
      ["a process group probe that is denied", { denied: [-4242] }, "process_group_may_be_alive"],
    ] as const)("keeps the lease for %s", async (_name, probeInput, reason) => {
      const ids = await seed({
        runStatus: "cancelled",
        run: { processPid: 4242, processGroupId: 4242 },
      });
      expect(await decide(ids, fakeProbes(probeInput))).toEqual({ release: false, reason });
    });

    it("treats a pid with a different start time as gone, but never over a live process group", async () => {
      const recordedStart = new Date("2026-10-07T13:00:00.000Z");
      const ids = await seed({
        runStatus: "cancelled",
        run: { processPid: 4242, processGroupId: 4242, processStartedAt: recordedStart },
      });
      const recycled = { startedAt: { 4242: "2026-10-07T15:00:00.000Z" } };

      expect(await decide(ids, fakeProbes({ alive: [4242], ...recycled }))).toMatchObject({
        release: true,
      });
      expect(await decide(ids, fakeProbes({ alive: [4242, -4242], ...recycled }))).toEqual({
        release: false,
        reason: "process_group_may_be_alive",
      });
      // Same start time: it is the recorded process.
      expect(
        await decide(
          ids,
          fakeProbes({ alive: [4242], startedAt: { 4242: recordedStart.toISOString() } }),
        ),
      ).toEqual({ release: false, reason: "process_may_be_alive" });
    });

    it("keeps the lease when a possibly live pid has an unreadable identity", async () => {
      const ids = await seed({
        runStatus: "cancelled",
        run: {
          processPid: 4242,
          processGroupId: null,
          processStartedAt: new Date("2026-10-07T13:00:00.000Z"),
        },
      });
      expect(
        await decide(ids, fakeProbes({ alive: [4242], startedAt: { 4242: errno("EACCES") } })),
      ).toEqual({ release: false, reason: "process_identity_unreadable" });
    });

    it("keeps the lease when the run recorded no process", async () => {
      const ids = await seed({
        runStatus: "interrupted",
        run: { processPid: null, processGroupId: null },
      });
      expect(await decide(ids)).toEqual({ release: false, reason: "missing_process_metadata" });
    });

    it("keeps the lease while this server still executes or controls the run", async () => {
      const ids = await seed({ runStatus: "cancelled" });
      expect(await decide(ids, fakeProbes({}), true)).toEqual({
        release: false,
        reason: "local_execution_active",
      });
    });

    it("keeps the lease of a terminal run whose controller lease has not expired", async () => {
      const ids = await seed({
        runStatus: "cancelled",
        run: {
          controllerBootId: randomUUID(),
          controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      expect(await decide(ids)).toEqual({ release: false, reason: "controller_lease_live" });

      await db
        .update(heartbeatRuns)
        .set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(heartbeatRuns.id, ids.runId));
      expect(await decide(ids)).toMatchObject({ release: true });
    });

    it("keeps the lease when the controller expiry is unknown", async () => {
      const ids = await seed({
        runStatus: "cancelled",
        run: { controllerBootId: randomUUID(), controllerLeaseExpiresAt: null },
      });
      expect(await decide(ids)).toEqual({ release: false, reason: "controller_lease_live" });
    });

    it("leaves native runs, running runs and non-local leases to their owners", async () => {
      const native = await seed({ runStatus: "failed", run: { runtimeMode: "native" } });
      expect(await decide(native)).toEqual({ release: false, reason: "run_not_legacy" });

      const running = await seed({ runStatus: "running" });
      expect(await decide(running)).toEqual({ release: false, reason: "run_not_terminal" });

      const mixed = await seed({ runStatus: "interrupted" });
      await insertLease({ ...mixed, provider: "fake" });
      expect(await decide(mixed)).toEqual({ release: false, reason: "non_local_lease" });

      const otherCompany = await seed({ runStatus: "interrupted" });
      expect(await decide({ runId: otherCompany.runId, companyId: native.companyId })).toEqual({
        release: false,
        reason: "run_not_found",
      });
    });
  });

  describe("stale-lock sweep", () => {
    it("releases the lease of a run it ends because the process is gone", async () => {
      const ids = await seed({ runStatus: "running", lockIssue: true });

      const swept = await heartbeat.sweepStaleIssueLocks();

      expect(swept.terminalizedRunIds).toEqual([ids.runId]);
      expect(await readRunStatus(ids.runId)).toEqual({
        status: "interrupted",
        errorCode: "orphaned_running_run",
      });
      const lease = await readLease(ids.leaseId);
      expect(lease.status).toBe("released");
      expect(lease.releasedAt).not.toBeNull();
      expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    });

    it("keeps the lease of a run it ends because the task is closed while the process lives", async () => {
      const kept = await startKeptProcess();
      const ids = await seed({
        runStatus: "running",
        issueStatus: "cancelled",
        lockIssue: true,
        run: { processPid: kept.pid, processGroupId: kept.pid, processStartedAt: kept.startedAt },
      });

      const swept = await heartbeat.sweepStaleIssueLocks();

      expect(swept.terminalizedRunIds).toEqual([ids.runId]);
      expect((await readRunStatus(ids.runId)).status).toBe("cancelled");
      expect(await readLease(ids.leaseId)).toEqual({ status: "active", releasedAt: null });

      await stopProcess(kept.child);
      const healed = await heartbeat.sweepEndedTerminalRunLeases();

      expect(healed).toMatchObject({ released: 1, runIds: [ids.runId] });
      const lease = await readLease(ids.leaseId);
      // A cancelled run releases its lease as "expired".
      expect(lease.status).toBe("expired");
      expect(lease.releasedAt).not.toBeNull();
    });
  });

  describe("cancel without a process handle", () => {
    it("keeps the lease while the kept process lives and releases it after the process exits", async () => {
      const kept = await startKeptProcess();
      const ids = await seed({
        runStatus: "running",
        lockIssue: true,
        run: { processPid: kept.pid, processGroupId: kept.pid, processStartedAt: kept.startedAt },
      });

      await heartbeat.cancelRun(ids.runId, "Cancelled by test");

      expect((await readRunStatus(ids.runId)).status).toBe("cancelled");
      expect(await readLease(ids.leaseId)).toEqual({ status: "active", releasedAt: null });
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ checked: 1, released: 0 });
      expect(await readLease(ids.leaseId)).toEqual({ status: "active", releasedAt: null });
      expect(
        await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId),
      ).toMatchObject({ runId: ids.runId, cause: "execution_owner_active" });
      // The cancel never signals the kept process.
      expect(kept.child.exitCode).toBeNull();
      expect(kept.child.signalCode).toBeNull();

      await stopProcess(kept.child);
      const healed = await heartbeat.sweepEndedTerminalRunLeases();

      expect(healed).toMatchObject({ released: 1, runIds: [ids.runId] });
      const lease = await readLease(ids.leaseId);
      expect(lease.status).toBe("expired");
      expect(lease.releasedAt).not.toBeNull();
      expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    });

    it("releases the lease at once when the process is already gone", async () => {
      const ids = await seed({ runStatus: "running", lockIssue: true });

      await heartbeat.cancelRun(ids.runId, "Cancelled by test");

      expect((await readRunStatus(ids.runId)).status).toBe("cancelled");
      const lease = await readLease(ids.leaseId);
      expect(lease.status).toBe("expired");
      expect(lease.releasedAt).not.toBeNull();
      expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toBeNull();
    });
  });

  describe("healing sweep", () => {
    it.each([
      ["interrupted", "released"],
      ["cancelled", "expired"],
      ["succeeded", "released"],
      ["failed", "failed"],
    ] as const)(
      "heals an existing lease of a %s run with a dead process as %s",
      async (runStatus, leaseStatus) => {
        const ids = await seed({ runStatus });
  
        const first = await heartbeat.sweepEndedTerminalRunLeases();
        const second = await heartbeat.sweepEndedTerminalRunLeases();

        expect(first).toEqual({ checked: 1, released: 1, runIds: [ids.runId] });
        expect(second).toEqual({ checked: 0, released: 0, runIds: [] });
        const lease = await readLease(ids.leaseId);
        expect(lease.status).toBe(leaseStatus);
        expect(lease.releasedAt).not.toBeNull();
      },
    );

    it("keeps protected leases and still heals the others in the same sweep", async () => {
      const kept = await startKeptProcess();
      const live = await seed({
        runStatus: "cancelled",
        run: { processPid: kept.pid, processGroupId: kept.pid, processStartedAt: kept.startedAt },
      });
      const controlled = await seed({
        runStatus: "interrupted",
        run: {
          controllerBootId: randomUUID(),
          controllerLeaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const noMetadata = await seed({
        runStatus: "interrupted",
        run: { processPid: null, processGroupId: null },
      });
      const mixed = await seed({ runStatus: "interrupted" });
      const remoteLeaseId = await insertLease({ ...mixed, provider: "fake" });
      const dead = await seed({ runStatus: "interrupted" });

      const healed = await heartbeat.sweepEndedTerminalRunLeases();

      expect(healed.runIds).toEqual([dead.runId]);
      expect((await readLease(dead.leaseId)).status).toBe("released");
      for (const leaseId of [
        live.leaseId,
        controlled.leaseId,
        noMetadata.leaseId,
        mixed.leaseId,
        remoteLeaseId,
      ]) {
        expect(await readLease(leaseId)).toEqual({ status: "active", releasedAt: null });
      }
    });

    it("retries on a later sweep when a release did not complete", async () => {
      const ids = await seed({ runStatus: "interrupted" });
      // The release path skips a lease without an environment, so the row
      // stays active after the release call.
      await db
        .update(environmentLeases)
        .set({ environmentId: null })
        .where(eq(environmentLeases.id, ids.leaseId));

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ checked: 1, released: 0 });
      expect(await readLease(ids.leaseId)).toEqual({ status: "active", releasedAt: null });

      await db
        .update(environmentLeases)
        .set({ environmentId: ids.environmentId })
        .where(eq(environmentLeases.id, ids.leaseId));
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });
      expect((await readLease(ids.leaseId)).status).toBe("released");
    });
  });

  describe("deferred wakes", () => {
    async function deferredWakes(agentId: string) {
      return db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            eq(agentWakeupRequests.status, "deferred_issue_execution"),
          ),
        );
    }

    async function deferCommentWake(ids: { companyId: string; agentId: string; issueId: string }) {
      // A comment wake is saved as a deferred wake while execution is held.
      const commentId = randomUUID();
      await db.insert(issueComments).values({
        id: commentId,
        companyId: ids.companyId,
        issueId: ids.issueId,
        authorAgentId: ids.agentId,
        body: "Please continue.",
      });
      return heartbeat.wakeup(ids.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId: ids.issueId, commentId },
        contextSnapshot: {
          issueId: ids.issueId,
          taskId: ids.issueId,
          commentId,
          wakeCommentId: commentId,
          wakeReason: "issue_commented",
        },
      });
    }

    async function otherRuns(ids: { agentId: string; runId: string }) {
      return db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, ids.agentId), sql`${heartbeatRuns.id} <> ${ids.runId}`));
    }

    it("starts a wake that was deferred behind the lease, without a new comment", async () => {
      const ids = await seed({
        runStatus: "interrupted",
        // The mark a stopped conversation run carries when a new turn may follow.
        run: {
          resultJson: { conversationContinuation: "continue_conversation_v1" },
          responsibleUserId: "local-board",
        },
      });

      expect(await deferCommentWake(ids)).toBeNull();
      expect(await deferredWakes(ids.agentId)).toHaveLength(1);
      expect(await otherRuns(ids)).toHaveLength(0);

      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });

      expect(await deferredWakes(ids.agentId)).toHaveLength(0);
      expect(await otherRuns(ids)).toHaveLength(1);

      // A repeated sweep finds nothing to release and creates no second run.
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 0 });
      expect(await otherRuns(ids)).toHaveLength(1);
    });

    it("keeps the existing hold on a run that needs reconciliation", async () => {
      // The stale-lock sweep writes no continuation mark, so release admission
      // keeps saved wakes held. Releasing the lease must not change that.
      const ids = await seed({ runStatus: "interrupted" });

      expect(await deferCommentWake(ids)).toBeNull();
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });

      expect(await getConversationOwnershipBlocker(db, ids.companyId, ids.issueId)).toBeNull();
      expect(await deferredWakes(ids.agentId)).toHaveLength(1);
      expect(await otherRuns(ids)).toHaveLength(0);
    });

    it("does not start saved wakes after an acknowledged operator stop", async () => {
      const ids = await seed({
        runStatus: "cancelled",
        run: {
          resultJson: {
            conversationContinuation: "continue_conversation_v1",
            executionCancellation: { state: "acknowledged" },
          },
        },
      });

      expect(await deferCommentWake(ids)).toBeNull();
      expect(await heartbeat.sweepEndedTerminalRunLeases()).toMatchObject({ released: 1 });

      expect((await readLease(ids.leaseId)).status).toBe("expired");
      expect(await deferredWakes(ids.agentId)).toHaveLength(1);
      expect(await otherRuns(ids)).toHaveLength(0);
    });
  });
});
