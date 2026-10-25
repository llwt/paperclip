import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

// Fork test (SX-2509): a run that closes, cancels or hands off its own task is
// stopped as before, then recorded `succeeded` with a `selfHandoff` marker. The
// same change by another actor still cancels the run exactly as today. The
// reassignment case and the new owner's wake are covered in
// execution-reassignment-stop-hold.test.ts and execution-stage-handoff-wake.test.ts.

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentTaskRun: vi.fn() };
});

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Self hand-off test run.",
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
import { agentRunWritesRevoked } from "../agent-run-cancellation.ts";
import { isConfirmedReassignmentStop } from "../services/run-cancellation.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres self hand-off tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describe("self hand-off run shape (SX-2509)", () => {
  const selfHandoff = {
    status: "succeeded",
    errorCode: null,
    resultJson: {
      reassignmentStopConfirmed: true,
      selfHandoff: true,
      selfHandoffStop: { kind: "reassignment", errorCode: "issue_reassigned", error: null, recordedAt: "2026-10-25T00:00:00.000Z" },
    },
  };

  it("counts as a confirmed reassignment stop", () => {
    expect(isConfirmedReassignmentStop(selfHandoff)).toBe(true);
    expect(isConfirmedReassignmentStop({
      status: "cancelled", errorCode: "issue_reassigned", resultJson: { reassignmentStopConfirmed: true },
    })).toBe(true);
    // A self close is not a reassignment stop, and a plain success never is.
    expect(isConfirmedReassignmentStop({ ...selfHandoff, resultJson: {
      ...selfHandoff.resultJson, selfHandoffStop: { ...selfHandoff.resultJson.selfHandoffStop, errorCode: "cancelled" },
    } })).toBe(false);
    expect(isConfirmedReassignmentStop({ status: "succeeded", errorCode: null, resultJson: { reassignmentStopConfirmed: true } })).toBe(false);
  });

  it("keeps the run's write authority revoked", () => {
    expect(agentRunWritesRevoked(selfHandoff)).toBe(true);
    expect(agentRunWritesRevoked({ status: "succeeded", resultJson: {} })).toBe(false);
  });
});

describeEmbeddedPostgres("a run that changes its own task ends succeeded (SX-2509)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-handoff-outcome-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    mockAdapterExecute.mockClear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await db.execute(sql`truncate table companies, environments cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function insertCompanyAndAgent() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Author",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRunningRun() {
    const { companyId, agentId } = await insertCompanyAndAgent();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(Date.now() - 60_000),
      contextSnapshot: { issueId },
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Closed by its own run",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      checkoutRunId: runId,
      executionRunId: runId,
    });
    return { companyId, agentId, issueId, runId };
  }

  describe.each([
    ["sets its task to cancelled", "cancelled_status"],
    ["closes its task through the goal stop", "terminalization"],
  ] as const)("a run that %s", (_name, kind) => {
    // The exact stops the issue PATCH route makes (routes/issues.ts).
    async function stopAsRoute(runId: string, issueMutationStopId: string | null) {
      if (kind === "terminalization") {
        return heartbeat.cancelRun(runId, "Cancelled before issue terminalization", {
          errorCode: "issue_terminalized",
          resultJson: { terminalizationStopConfirmed: true, ...(issueMutationStopId ? { issueMutationStopId } : {}) },
          eventMessage: "run cancelled before issue terminalization",
        });
      }
      return issueMutationStopId
        ? heartbeat.cancelRun(runId, undefined, { resultJson: { issueMutationStopId } })
        : heartbeat.cancelRun(runId);
    }

    it("itself: is recorded succeeded after the change commits", async () => {
      const ids = await seedRunningRun();
      const issueMutationStopId = randomUUID();
      expect(await stopAsRoute(ids.runId, issueMutationStopId)).toMatchObject({ status: "cancelled" });
      await db.update(issues).set({ status: "cancelled", checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, ids.issueId));

      const recorded = await heartbeat.recordSelfHandoffOutcome({ runId: ids.runId, issueMutationStopId, kind });

      expect(recorded).toMatchObject({ status: "succeeded", errorCode: null, error: null });
      const run = await heartbeat.getRun(ids.runId);
      expect(run).toMatchObject({
        status: "succeeded",
        errorCode: null,
        resultJson: expect.objectContaining({
          selfHandoff: true,
          stopReason: "completed",
          issueMutationStopId,
          selfHandoffStop: expect.objectContaining({
            kind,
            errorCode: kind === "terminalization" ? "issue_terminalized" : "cancelled",
          }),
        }),
      });
      expect(run?.resultJson).not.toHaveProperty("selfHandoffPending");
    });

    it("by another actor: stays cancelled with today's code", async () => {
      const ids = await seedRunningRun();
      // A board user or another agent: the route passes no stop id of its own.
      expect(await stopAsRoute(ids.runId, null)).toMatchObject({ status: "cancelled" });
      await db.update(issues).set({ status: "cancelled", checkoutRunId: null, executionRunId: null })
        .where(eq(issues.id, ids.issueId));

      // Another request's stop id never relabels this stop.
      expect(await heartbeat.recordSelfHandoffOutcome({
        runId: ids.runId, issueMutationStopId: randomUUID(), kind,
      })).toBeNull();
      expect(await heartbeat.getRun(ids.runId)).toMatchObject(kind === "terminalization"
        ? { status: "cancelled", errorCode: "issue_terminalized", error: "Cancelled before issue terminalization" }
        : { status: "cancelled", errorCode: "cancelled", error: "Cancelled by control plane" });
    });
  });
});
