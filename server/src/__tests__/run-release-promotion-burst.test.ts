import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentWakeupRequests, agents, companies, companyMemberships, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Every first run of an agent waits on this gate, so the test can finish all
// of them at the same moment. Later runs (the promoted wakes) return at once.
const gate = vi.hoisted(() => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open, held: new Set<string>(), seen: new Set<string>() };
});
const execute = vi.hoisted(() => vi.fn(async (input: unknown) => {
  const agentId = (input as { agent?: { id?: string } } | undefined)?.agent?.id ?? "";
  if (!gate.seen.has(agentId)) {
    gate.seen.add(agentId);
    gate.held.add(agentId);
    await gate.opened;
  }
  return { exitCode: 0, signal: null, timedOut: false };
}));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));

// SX-4422 (follow-up of the 2026-11-01 outage, SX-4385): when a run finishes,
// the wake-queue release transaction promotes the issue's next deferred wake.
// Its host ports (session-before, routine env, responsible user) read through
// the shared pool while that transaction holds a pool connection. When more
// runs finish at once than the pool has connections, every connection waits
// for a second one and nothing finishes. This finishes RUNS runs at the same
// moment on a pool of 3, each with one deferred wake to promote, and requires
// every wake to be promoted within a few seconds.
const POOL_SIZE = 3;
const RUNS = 6;
const BOUND_MS = 8_000;

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run release promotion burst test: ${support.reason ?? "unsupported environment"}`);
}

suite("run release promotion burst on a small pool", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  // Seeds and observes on its own pool, so a deadlock in the pool under test
  // cannot hide the result.
  let observer: ReturnType<typeof createDb>;
  let pool: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let root: string;
  let deadlocked = false;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-release-burst-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    database = await startEmbeddedPostgresTestDatabase("run-release-promotion-burst");
    observer = createDb(database.connectionString);
    pool = createDb(database.connectionString, { maxConnections: POOL_SIZE });
    heartbeat = heartbeatService(pool);
  });

  afterAll(async () => {
    gate.open();
    // After a deadlock the pool's connections never come back; close them
    // instead of draining runs that cannot finish.
    if (!deadlocked && pool) await drainHeartbeatRunsToQuiescence(pool, heartbeat);
    await pool?.$client.end({ timeout: deadlocked ? 0 : 5 });
    await observer?.$client.end({ timeout: 5 });
    await database?.cleanup();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function seed() {
    const companyId = randomUUID();
    const ownerUserId = `owner-${randomUUID()}`;
    await observer.insert(companies).values({
      id: companyId,
      name: "Release burst",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: ownerUserId,
    });
    await observer.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner",
    });
    const work = Array.from({ length: RUNS }, () => ({ agentId: randomUUID(), issueId: randomUUID() }));
    await observer.insert(agents).values(work.map(({ agentId }, index) => ({
      id: agentId, companyId, name: `Engineer ${index + 1}`, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: { env: { OPENAI_API_KEY: "sk-test" } },
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    })));
    await observer.insert(issues).values(work.map(({ agentId, issueId }, index) => ({
      id: issueId, companyId, title: `Release burst issue ${index + 1}`, status: "todo",
      assigneeAgentId: agentId, responsibleUserId: ownerUserId,
    })));
    return { companyId, ownerUserId, work };
  }

  it(`promotes the deferred wakes of ${RUNS} runs that finish at once within ${BOUND_MS} ms on a pool of ${POOL_SIZE}`, async () => {
    const { companyId, ownerUserId, work } = await seed();

    // One running run per issue, each held open by the adapter gate.
    for (const { agentId, issueId } of work) {
      const run = await heartbeat.wakeup(agentId, {
        payload: { issueId }, requestedByActorType: "user", requestedByActorId: ownerUserId,
      });
      expect(run, `wake of agent ${agentId}`).toBeTruthy();
    }
    await vi.waitFor(() => expect(gate.held.size).toBe(RUNS), { timeout: 5_000 });

    // While each run holds its issue, queue the wake its release must promote.
    const wakeIds = work.map(() => randomUUID());
    await observer.insert(agentWakeupRequests).values(work.map(({ agentId, issueId }, index) => ({
      id: wakeIds[index]!, companyId, agentId, source: "automation", reason: "issue_execution_deferred",
      status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: ownerUserId,
      payload: { issueId, _paperclipWakeContext: { issueId, taskId: issueId, resumeIntent: true } },
    })));

    const startedAt = Date.now();
    let promoted = 0;
    gate.open();
    const promotion = (async () => {
      for (;;) {
        const rows = await observer
          .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests)
          .where(inArray(agentWakeupRequests.id, wakeIds));
        promoted = rows.filter((row) => row.status !== "deferred_issue_execution" && row.runId).length;
        if (promoted === RUNS) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();

    if (await timedOut(promotion)) {
      expect.fail(
        `pool deadlock: ${RUNS} runs finishing at once did not promote their deferred wakes in ${BOUND_MS} ms ` +
        `on a pool of ${POOL_SIZE} (${promoted}/${RUNS} promoted, ` +
        `${await idleInTransactionCount()} connections idle in transaction)`,
      );
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
