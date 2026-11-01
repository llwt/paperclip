import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, createDb, externalObjectMentions, issueComments, issues as issueRows } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { externalObjectService } from "../services/external-objects.js";
import { issueService } from "../services/issues.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

// Reproduces the pool deadlock of 2026-11-01 (SX-4385): the Checker created 10
// issues in about 4 seconds, and every transaction in `syncIssue` held one pool
// connection while the plugin detector asked the shared pool for a second.
// Once every connection was held that way, nothing could finish.

const POOL_SIZE = 2;
const CONCURRENT_OPERATIONS = 6;
// Well under the global Vitest testTimeout, so a hang fails with a clear
// message instead of the generic timeout.
const DEADLOCK_BOUND_MS = 5_000;

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pool deadlock test on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function settleWithin<T>(operations: Array<Promise<T>>, boundMs: number) {
  let finished = 0;
  const tracked = operations.map((operation) => operation.finally(() => { finished += 1; }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), boundMs);
  });
  try {
    const outcome = await Promise.race([Promise.allSettled(tracked), bound]);
    if (outcome === "timeout") {
      throw new Error(
        `pool deadlock: ${operations.length - finished} of ${operations.length} operations did not finish in ${boundMs} ms`,
      );
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

describeEmbeddedPostgres("external objects under a small database pool", () => {
  let setupDb!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-external-objects-pool-");
    setupDb = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    // Ends every client on this cluster, including a deadlocked small pool.
    await tempDb?.cleanup();
  });

  it("does not deadlock when more issues with external links are created at once than the pool has connections", async () => {
    const companyId = randomUUID();
    await setupDb.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const smallPoolDb = createDb(tempDb!.connectionString, { maxConnections: POOL_SIZE });
    // A plugin worker manager turns on the plugin detector, as on the live server.
    const pluginWorkerManager = {
      call: async () => ({ detections: [] }),
    } as unknown as PluginWorkerManager;
    const issues = issueService(smallPoolDb);
    const externalObjects = externalObjectService(smallPoolDb, { pluginWorkerManager });

    // Same order as POST /companies/:companyId/issues: create, then sync mentions.
    const operations = Array.from({ length: CONCURRENT_OPERATIONS }, async (_, index) => {
      const issue = await issues.create(companyId, {
        title: `Check report ${index}`,
        description: `See https://github.com/acme/app/pull/${index + 1} and https://example.com/report/${index}.`,
        status: "todo",
        priority: "medium",
      });
      await externalObjects.syncIssue(issue.id);
      return issue.id;
    });

    const results = await settleWithin(operations, DEADLOCK_BOUND_MS);
    const failures = results.filter((result) => result.status === "rejected");
    expect(failures).toEqual([]);

    const mentions = await setupDb
      .select({ sourceIssueId: externalObjectMentions.sourceIssueId })
      .from(externalObjectMentions)
      .where(eq(externalObjectMentions.companyId, companyId));
    expect(new Set(mentions.map((row) => row.sourceIssueId)).size).toBe(CONCURRENT_OPERATIONS);
  });

  it("does not deadlock when concurrent comment syncs check the enabled flag on the shared pool", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await setupDb.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await setupDb.insert(issueRows).values({
      id: issueId,
      companyId,
      identifier: `CMT-${companyId.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
      title: "Comment sync",
      status: "todo",
      priority: "medium",
    });
    const commentIds = Array.from({ length: CONCURRENT_OPERATIONS }, () => randomUUID());
    await setupDb.insert(issueComments).values(commentIds.map((id, index) => ({
      id,
      companyId,
      issueId,
      body: `Done in https://github.com/acme/app/pull/${index + 100}`,
    })));

    const smallPoolDb = createDb(tempDb!.connectionString, { maxConnections: POOL_SIZE });
    // Like the live callers, the enabled flag is read from instance settings
    // on the shared pool.
    const externalObjects = externalObjectService(smallPoolDb, {
      enabled: async () => {
        await smallPoolDb.execute(sql`select 1`);
        return true;
      },
    });

    const results = await settleWithin(
      commentIds.map((commentId) => externalObjects.syncComment(commentId)),
      DEADLOCK_BOUND_MS,
    );
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);

    const mentions = await setupDb
      .select({ sourceRecordId: externalObjectMentions.sourceRecordId })
      .from(externalObjectMentions)
      .where(eq(externalObjectMentions.companyId, companyId));
    expect(new Set(mentions.map((row) => row.sourceRecordId)).size).toBe(CONCURRENT_OPERATIONS);
  });
});
