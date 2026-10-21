import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  boundHeartbeatRunEventPayloadForStorage,
  heartbeatService,
  summarizeHeartbeatRunContextSnapshot,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat list tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat list", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-list-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("returns runs even when the linked db schema lacks processGroupId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
      livenessState: "advanced",
      livenessReason: "run produced action evidence",
      continuationAttempt: 1,
      lastUsefulActionAt: new Date("2026-04-18T12:00:00Z"),
      nextAction: "continue implementation",
      contextSnapshot: { issueId: randomUUID() },
    });

    const originalDescriptor = Object.getOwnPropertyDescriptor(heartbeatRuns, "processGroupId");
    Object.defineProperty(heartbeatRuns, "processGroupId", {
      value: undefined,
      configurable: true,
      writable: true,
    });

    try {
      const runs = await heartbeatService(db).list(companyId, agentId, 5);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.id).toBe(runId);
      expect(runs[0]?.processGroupId ?? null).toBeNull();
      expect(runs[0]).toMatchObject({
        livenessState: "advanced",
        livenessReason: "run produced action evidence",
        continuationAttempt: 1,
        nextAction: "continue implementation",
      });
      expect(runs[0]?.lastUsefulActionAt).toEqual(new Date("2026-04-18T12:00:00Z"));
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(heartbeatRuns, "processGroupId", originalDescriptor);
      } else {
        delete (heartbeatRuns as Record<string, unknown>).processGroupId;
      }
    }
  });

  it("returns small result json payloads unchanged from getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      resultJson: {
        summary: "done",
        structured: { ok: true },
      },
    });

    const run = await heartbeatService(db).getRun(runId);

    expect(run?.resultJson).toEqual({
      summary: "done",
      structured: { ok: true },
    });
  });

  it.each([false, true])("preserves run ownership in list rows (summary=%s)", async (summary) => {
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
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      responsibleUserId: "run-owner",
      error: "Failed after doing useful work",
      usageJson: {
        provider: "openai",
        model: "gpt-5",
        inputTokens: 123,
      },
      resultJson: {
        summary: "large run summary",
        stdout: "x".repeat(20_000),
      },
      sessionIdBefore: "session-before",
      sessionIdAfter: "session-after",
      logStore: "local",
      logRef: "logs/run.log",
      logSha256: "abc123",
      externalRunId: "external-run",
      processPid: 12345,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });

    const runs = await heartbeatService(db).list(companyId, undefined, 5, { summary });

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: runId,
      companyId,
      agentId,
      status: "failed",
      responsibleUserId: "run-owner",
      error: "Failed after doing useful work",
      ...(summary ? {
        usageJson: null,
        resultJson: null,
        sessionIdBefore: null,
        sessionIdAfter: null,
        logStore: null,
        logRef: null,
        logSha256: null,
        externalRunId: null,
        processPid: null,
      } : {}),
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
    });
  });

  it("bounds oversized legacy result json payloads on getRun", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const oversizedStdout = Array.from({ length: 8_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}-${randomUUID()}`,
    ).join("|");
    const oversizedNestedPayload = Array.from({ length: 6_000 }, (_, index) =>
      `${index.toString(16).padStart(4, "0")}:${randomUUID()}`,
    ).join("|");
    // Multibyte diagnostics can exceed the result byte budget while remaining
    // within the adapter's character bounds. Other result fields can do so too.
    const terminalSessionFailure = {
      category: "service",
      title: "HTTP 529: overloaded_error",
      details: `request_id=req_retained\n${"診断".repeat(12_000)}`,
      truncatedFields: ["title"],
    };

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "succeeded",
      error: terminalSessionFailure.details,
      resultJson: {
        summary: "completed",
        stdout: oversizedStdout,
        nestedHuge: { payload: oversizedNestedPayload },
        terminalSessionFailure: {
          ...terminalSessionFailure,
          privateMetadata: oversizedNestedPayload,
        },
        instructionSave: {
          state: "unavailable", contract: "agent_files", entryFile: "AGENTS.md",
          errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
          storageWarning: "Agent storage is full. Runs can continue.".repeat(50),
          privateSyncMetadata: oversizedNestedPayload,
        },
        workspaceRestoreFailure: "restore_unsafe_archive",
        cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
          reason: "Provider cancelled execution ".repeat(50), recordedAt: "2026-10-02T15:00:00.000Z",
          privateMetadata: oversizedNestedPayload },
        acpToolInventoryComplete: true,
        acpPendingToolCount: 0,
        errorFamily: "configuration",
        finalResponseRecorded: true,
        executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
      },
    });

    const run = await heartbeatService(db).getRun(runId);
    const result = run?.resultJson as Record<string, unknown> | null;

    expect(result).toMatchObject({
      summary: "completed",
      truncated: true,
      truncationReason: "oversized_result_json",
      stdoutTruncated: true,
      terminalSessionFailure: {
        ...terminalSessionFailure,
        details: expect.stringContaining("request_id=req_retained"),
        retrievalTruncated: true,
      },
      instructionSave: {
        state: "unavailable", contract: "agent_files", entryFile: "AGENTS.md",
        errorCode: "AGENT_FILES_LIMIT_EXCEEDED",
        storageWarning: "Agent storage is full. Runs can continue.".repeat(50).slice(0, 1024),
      },
      workspaceRestoreFailure: "restore_unsafe_archive",
      cancellation: { source: "provider", expected: false, initiator: { type: "provider" },
        reason: "Provider cancelled execution ".repeat(50).slice(0, 512), recordedAt: "2026-10-02T15:00:00.000Z" },
      acpToolInventoryComplete: true,
      acpPendingToolCount: 0,
      errorFamily: "configuration",
      finalResponseRecorded: true,
      executionBeforeRestore: { errorCode: "model_error", exitCode: 2, timedOut: false },
    });
    expect(typeof result?.stdout).toBe("string");
    expect((result?.stdout as string).length).toBeLessThan(oversizedStdout.length);
    expect(result).not.toHaveProperty("nestedHuge");
    expect(result?.instructionSave).not.toHaveProperty("privateSyncMetadata");
    expect(result?.cancellation).not.toHaveProperty("privateMetadata");
    expect(result?.terminalSessionFailure).not.toHaveProperty("privateMetadata");
    const diagnostic = result?.terminalSessionFailure as { details: string };
    expect(diagnostic.details).toContain("[truncated for run retrieval; full text in run error/transcript]");
    expect(Buffer.byteLength(diagnostic.details)).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(64 * 1024);
    expect(run?.error).toBe(terminalSessionFailure.details);
  });

  // Ported from paperclipai/paperclip#16286 (ebeac833a, run-state.test.ts). The fork has no
  // heartbeat_runs.issue_id column, so the context issue id is the only issue source here.
  async function listFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("bounds history at the service boundary and keeps company and agent scope", async () => {
    const { companyId, agentId } = await listFixture();
    await db.execute(sql`insert into heartbeat_runs (company_id, agent_id, created_at)
      select ${companyId}::uuid, ${agentId}::uuid, '2026-01-01'::timestamptz + n * interval '1 second'
      from generate_series(1, 1005) n`);
    const foreign = await listFixture();
    await db.insert(heartbeatRuns).values({ companyId: foreign.companyId, agentId: foreign.agentId });
    const service = heartbeatService(db);
    const rows = await service.list(companyId);
    expect(rows).toHaveLength(200);
    expect(rows.every(row => row.companyId === companyId && row.agentId === agentId)).toBe(true);
    expect(rows[0].createdAt.getTime()).toBeGreaterThan(rows[199].createdAt.getTime());
    expect(await service.list(companyId, agentId, 10000)).toHaveLength(1000);
    expect(await service.list(companyId, agentId, 1.9)).toHaveLength(1);
    expect(await service.list(companyId, agentId, -10)).toHaveLength(1);
    expect(await service.list(companyId, agentId, NaN)).toHaveLength(200);
    expect(await service.list(companyId, foreign.agentId)).toEqual([]);
  });

  it("preserves legacy context text and summary privacy", async () => {
    const { companyId, agentId } = await listFixture();
    const service = heartbeatService(db);
    const contexts: unknown[] = [null, [], "legacy", 3, true, {}, {
      issueId: "legacy-issue", taskId: 17, taskKey: { nested: true }, commentId: ["one", 2],
      wakeCommentId: null, wakeReason: false, wakeSource: "   ", wakeTriggerDetail: "héllo\nworld",
      secret: "never return this", prompt: randomBytes(96 * 1024).toString("hex"),
    }];
    for (const contextSnapshot of contexts) {
      const [run] = await db.insert(heartbeatRuns).values({
        companyId, agentId,
        contextSnapshot: contextSnapshot as Record<string, unknown>,
      }).returning();
      const expected = (await db.execute(sql`select context_snapshot->>'issueId' as "issueId",
        context_snapshot->>'taskId' as "taskId", context_snapshot->>'taskKey' as "taskKey",
        context_snapshot->>'commentId' as "commentId", context_snapshot->>'wakeCommentId' as "wakeCommentId",
        context_snapshot->>'wakeReason' as "wakeReason", context_snapshot->>'wakeSource' as "wakeSource",
        context_snapshot->>'wakeTriggerDetail' as "wakeTriggerDetail" from heartbeat_runs where id = ${run.id}::uuid`))[0];
      for (const summary of [false, true]) {
        const actual = (await service.list(companyId, agentId, 100, { summary })).find(row => row.id === run.id)!;
        expect(actual.contextSnapshot).toEqual(summarizeHeartbeatRunContextSnapshot(expected as Record<string, unknown>));
        expect(actual.contextSnapshot ?? {}).not.toHaveProperty("secret");
        expect(actual.contextSnapshot ?? {}).not.toHaveProperty("prompt");
      }
    }
  });
});

describe("heartbeat run event payload bounding", () => {
  it("truncates oversized adapter metadata before storage", () => {
    const payload = boundHeartbeatRunEventPayloadForStorage({
      adapterType: "codex_local",
      prompt: "x".repeat(40_000),
      context: {
        issueId: "issue-1",
        memory: "y".repeat(40_000),
      },
    });

    expect(payload.adapterType).toBe("codex_local");
    expect(typeof payload.prompt).toBe("string");
    expect((payload.prompt as string).length).toBeLessThan(20_000);
    expect(payload.prompt).toContain("[truncated");
    expect(payload.context).toMatchObject({
      issueId: "issue-1",
    });
    expect(JSON.stringify(payload).length).toBeLessThan(45_000);
  });
});
