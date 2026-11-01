import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueCreateIdempotencyKeys, issues,
  principalPermissionGrants,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";

// The adapter must not run anything: this test is about the database pool.
const execute = vi.hoisted(() => vi.fn(async (_input: unknown) => ({ exitCode: 0, signal: null, timedOut: false })));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

// The outage of 2026-11-01 (SX-4385): the Checker created 10 issues in about
// 4 seconds. Each create queued an assignment wake whose transaction read
// through the shared pool while it held a pool connection, so a burst larger
// than the pool held every connection and nothing could finish. This drives
// the same burst through the real create route with a pool of 3 and requires
// every create and every queued wake to finish within a few seconds.
const POOL_SIZE = 3;
const BURST = 10;
const BOUND_MS = 8_000;

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping issue create wake burst test: ${support.reason ?? "unsupported environment"}`);
}

suite("issue create wake burst on a small pool", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  // Seeds and observes on its own pool, so a deadlock in the pool under test
  // cannot hide the result.
  let observer: ReturnType<typeof createDb>;
  let pool: ReturnType<typeof createDb>;
  let root: string;
  let deadlocked = false;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-wake-burst-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    database = await startEmbeddedPostgresTestDatabase("issue-create-wake-burst");
    observer = createDb(database.connectionString);
    pool = createDb(database.connectionString, { maxConnections: POOL_SIZE });
  });

  afterAll(async () => {
    // After a deadlock the pool's connections never come back; close them
    // instead of draining runs that cannot finish.
    if (!deadlocked && pool) await drainHeartbeatRunsToQuiescence(pool, heartbeatService(pool));
    await pool?.$client.end({ timeout: deadlocked ? 0 : 5 });
    await observer?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await observer.insert(companies).values({
      id: companyId,
      name: "Burst",
      issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await observer.insert(authUsers).values({
      id: "board-user", name: "Board", email: "board@example.test", createdAt: new Date(), updatedAt: new Date(),
    }).onConflictDoNothing();
    await observer.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: "board-user", status: "active", membershipRole: "owner",
    });
    await observer.insert(agents).values({
      id: agentId, companyId, name: "Engineer", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: "sk-test" } }, runtimeConfig: {}, permissions: {},
    });
    return { companyId, agentId };
  }

  function createApp(companyId: string, actor?: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor ?? {
        type: "board",
        userId: "board-user",
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        isInstanceAdmin: false,
        source: "session",
      };
      next();
    });
    app.use("/api", issueRoutes(pool, {} as any));
    app.use(errorHandler);
    return app;
  }

  it(`creates ${BURST} assigned issues at once and queues their wakes within ${BOUND_MS} ms on a pool of ${POOL_SIZE}`, async () => {
    const { companyId, agentId } = await seed();
    const app = createApp(companyId);
    const startedAt = Date.now();

    let createdIssueIds: string[] = [];
    let runCount = 0;
    const burst = (async () => {
      const responses = await Promise.all(Array.from({ length: BURST }, (_, index) =>
        request(app)
          .post(`/api/companies/${companyId}/issues`)
          .send({ title: `Burst issue ${index + 1}`, status: "todo", assigneeAgentId: agentId })));
      for (const res of responses) expect(res.status, JSON.stringify(res.body)).toBe(201);
      createdIssueIds = responses.map((res) => res.body.id as string);
      // The route queues each wake fire-and-forget after it answers, so wait
      // for one heartbeat run per issue as well.
      for (;;) {
        const runs = await observer
          .select({ issueId: heartbeatRuns.issueId })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.issueId, createdIssueIds));
        runCount = new Set(runs.map((run) => run.issueId)).size;
        if (runCount === BURST) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    if (await timedOut(burst)) {
      expect.fail(
        `pool deadlock: ${BURST} issue creates with wakes did not finish in ${BOUND_MS} ms on a pool of ${POOL_SIZE} ` +
        `(${createdIssueIds.length}/${BURST} creates answered, ${runCount}/${BURST} wakes queued, ` +
        `${await idleInTransactionCount()} connections idle in transaction)`,
      );
    }
    expect(Date.now() - startedAt).toBeLessThan(BOUND_MS);
  });

  // An agent replay of an idempotency key reuses the existing issue inside
  // the create transaction, and the route checks the agent may assign it
  // there. That check must read through the transaction too.
  it(`answers ${BURST} agent replays of one idempotency key at once within ${BOUND_MS} ms on a pool of ${POOL_SIZE}`, async () => {
    const { companyId, agentId } = await seed();
    await observer.insert(companyMemberships).values({
      companyId, principalType: "agent", principalId: agentId, status: "active", membershipRole: "member",
    });
    await observer.insert(principalPermissionGrants).values({
      companyId, principalType: "agent", principalId: agentId, permissionKey: "tasks:assign", grantedByUserId: "board-user",
    });
    const [existing] = await observer.insert(issues).values({
      companyId, title: "Replayed issue", status: "todo", priority: "medium", assigneeAgentId: agentId,
    }).returning();
    const idempotencyKey = "run-1:replayed-issue";
    await observer.insert(issueCreateIdempotencyKeys).values({ companyId, idempotencyKey, issueId: existing.id });
    const app = createApp(companyId, { type: "agent", agentId, companyId, source: "agent_key" });
    const startedAt = Date.now();

    let answered = 0;
    const replays = Promise.all(Array.from({ length: BURST }, () =>
      request(app)
        .post(`/api/companies/${companyId}/issues`)
        .send({ title: "Replayed issue", status: "todo", assigneeAgentId: agentId, idempotencyKey })
        .then((res) => { answered += 1; return res; })));

    if (await timedOut(replays)) {
      expect.fail(
        `pool deadlock: ${BURST} agent replays did not finish in ${BOUND_MS} ms on a pool of ${POOL_SIZE} ` +
        `(${answered}/${BURST} answered, ${await idleInTransactionCount()} connections idle in transaction)`,
      );
    }
    for (const res of await replays) {
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: existing.id, deduplicated: true, deduplicationReason: "idempotency_key" });
    }
    expect(Date.now() - startedAt).toBeLessThan(BOUND_MS);
  });

  async function timedOut(work: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      work.then(() => "done" as const),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), BOUND_MS); }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === "timeout") deadlocked = true;
    return outcome === "timeout";
  }

  // Connections of the pool under test that sit in an open transaction.
  async function idleInTransactionCount() {
    const stuck = await observer.execute(sql`select count(*)::int as count from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state = 'idle in transaction'`);
    return Number((stuck as unknown as Array<{ count: number }>)[0]?.count ?? 0);
  }
});
