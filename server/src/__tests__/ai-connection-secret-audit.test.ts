import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  connectionGrants,
  createDb,
  heartbeatRuns,
  secretAccessEvents,
  toolConnections,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";
import { TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS } from "../services/system-audit-dedupe.js";

// Callers that pass no `audit` argument read the credential as a system actor with
// no run id. The audit trail must grow once per window, not once per read.
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const owner = "audit-owner";
let service: ReturnType<typeof aiConnectionService>;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "ai-connection-audit-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-connection-audit");
  database = await startEmbeddedPostgresTestDatabase("ai-connection-audit-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values({ id: companyId, name: "AI audit", issuePrefix: "AIA" });
  await db.insert(companyMemberships).values({
    companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member",
  });
}, 90_000);
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await database?.cleanup();
  vi.unstubAllEnvs();
  if (home) await rm(home, { recursive: true, force: true });
});

async function seed() {
  const account = await service.save(companyId, owner, {
    provider: "anthropic", method: "api_key", ownership: "shared", name: `account-${randomUUID()}`,
    apiKey: "fixture", agentIds: [], allAgents: true,
  }, "credential-v1");
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  const secretId = grant!.credentialSecretRefs.find((ref) => ref.configPath === "ai.credential")!.secretId;
  return { row: { connection: connection!, grant: grant! }, secretId };
}

const accessRows = (secretId: string) => db.select().from(secretAccessEvents)
  .where(eq(secretAccessEvents.secretId, secretId));

describe("ai.credential system read audit volume", () => {
  it("writes one access event for 10 reads with no audit argument inside the window", async () => {
    const { row, secretId } = await seed();
    for (let call = 0; call < 10; call++) expect(await service.credential(row)).toBe("credential-v1");
    const rows = await accessRows(secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consumerType: "tool_connection", consumerId: row.connection.id, configPath: "ai.credential",
      actorType: "system", heartbeatRunId: null, outcome: "success", version: 1,
    });
  });

  it("writes a second row after the window", async () => {
    const { row, secretId } = await seed();
    await service.credential(row);
    await service.credential(row);
    expect(await accessRows(secretId)).toHaveLength(1);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS + 1 });
    await service.credential(row);
    await service.credential(row);
    expect(await accessRows(secretId)).toHaveLength(2);
  });

  it("writes at once for a new secret version inside the window and returns the new value", async () => {
    const { row, secretId } = await seed();
    expect(await service.credential(row)).toBe("credential-v1");
    await secretService(db).rotate(secretId, { value: "credential-v2" });
    expect(await service.credential(row)).toBe("credential-v2");
    expect(await service.credential(row)).toBe("credential-v2");
    expect((await accessRows(secretId)).map((event) => event.version).sort()).toEqual([1, 2]);
  });

  it("keeps one row per read for an agent actor with a run id and for a user actor", async () => {
    const { row, secretId } = await seed();
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Robot", role: "engineer", adapterType: "codex_local" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    for (let call = 0; call < 3; call++) {
      await service.credential(row, 0, {
        responsibleUserId: owner, actorType: "agent", actorId: agentId, heartbeatRunId: runId,
      });
    }
    for (let call = 0; call < 3; call++) {
      await service.credential(row, 0, { responsibleUserId: owner, actorType: "user", actorId: owner });
    }
    const agentRows = await db.select().from(secretAccessEvents).where(and(
      eq(secretAccessEvents.secretId, secretId), eq(secretAccessEvents.heartbeatRunId, runId),
    ));
    expect(agentRows).toHaveLength(3);
    expect((await accessRows(secretId)).filter((event) => event.actorType === "user")).toHaveLength(3);
  });
});
