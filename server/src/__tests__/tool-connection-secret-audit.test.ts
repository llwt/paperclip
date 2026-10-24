import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  heartbeatRuns,
  agents,
  secretAccessEvents,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { syncConnectionCredentialBindings } from "../services/connection-credential-bindings.js";
import { secretService } from "../services/secrets.js";
import { systemAuditDedupe, TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS, toolAccessService } from "../services/tool-access.js";

const support = await getEmbeddedPostgresTestSupport();

// The health sweep reads every connection's credentials with no run id about every
// 15 minutes. The audit trail must grow once per window, not once per sweep.
(support.supported ? describe : describe.skip)("tool connection system credential audit volume", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const secretsDir = path.join(os.tmpdir(), `paperclip-tool-connection-audit-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(secretsDir, "master.key"));
    database = await startEmbeddedPostgresTestDatabase("paperclip-tool-connection-audit-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    rmSync(secretsDir, { recursive: true, force: true });
  }, 60_000);

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: `tool-token-${randomUUID()}`, provider: "local_encrypted", value: "tool-token-v1",
    });
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "mcp_http" });
    const [connection] = await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: connectionId, uid: connectionId, transport: "mcp_remote",
      authKind: "api_key", credentialPolicy: "shared", status: "active", enabled: true,
      config: { url: "https://fixture.example/mcp" },
      credentialRefs: [{
        name: "headers.Authorization", secretId: secret.id, version: "latest", placement: "header",
        key: "Authorization", prefix: "Bearer ",
      }],
      credentialSecretRefs: [{
        secretId: secret.id, versionSelector: "latest", configPath: "headers.Authorization", required: true,
        label: "Authorization",
      }],
    }).returning();
    await syncConnectionCredentialBindings(db, connection!);
    return { companyId, connectionId, secretId: secret.id, secrets };
  }

  const tools = () => ({ jsonrpc: "2.0", id: "paperclip-catalog-refresh", result: { tools: [] } });
  function mockUpstream() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(tools()), {
      status: 200, headers: { "content-type": "application/json" },
    }));
  }
  function sweepService() {
    return toolAccessService(db, {
      remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
      remoteHttpRequest: async (url, init) => fetch(url, init),
    });
  }
  const sweep = (service: ReturnType<typeof sweepService>) => service.sweepConnectionHealth({ staleAfterMs: 0, limit: 100 });

  const accessRows = (secretId: string) => db.select().from(secretAccessEvents)
    .where(eq(secretAccessEvents.secretId, secretId));
  const systemContext = (connectionId: string, configPath = "headers.Authorization") => ({
    consumerType: "tool_connection" as const, consumerId: connectionId, configPath,
    actorType: "system" as const, actorId: "tool_health_sweep",
    auditDedupeWindowMs: TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS,
  });

  it("writes one access event for 10 health-sweep reads inside the window", async () => {
    const fixture = await seed();
    mockUpstream();
    const service = sweepService();
    for (let call = 0; call < 10; call++) {
      expect(await sweep(service)).toMatchObject({ failed: 0 });
    }
    const rows = await accessRows(fixture.secretId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      consumerType: "tool_connection", consumerId: fixture.connectionId, configPath: "headers.Authorization",
      actorType: "system", heartbeatRunId: null, outcome: "success", version: 1,
    });
  });

  it("writes a second row after the window", async () => {
    const fixture = await seed();
    mockUpstream();
    const service = sweepService();
    await sweep(service);
    await sweep(service);
    expect(await accessRows(fixture.secretId)).toHaveLength(1);

    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS + 1 });
    await sweep(service);
    await sweep(service);
    expect(await accessRows(fixture.secretId)).toHaveLength(2);
  });

  it("writes at once for a new secret version inside the window", async () => {
    const fixture = await seed();
    mockUpstream();
    const service = sweepService();
    await sweep(service);
    await fixture.secrets.rotate(fixture.secretId, { value: "tool-token-v2" });
    await sweep(service);
    await sweep(service);
    expect((await accessRows(fixture.secretId)).map((row) => row.version).sort()).toEqual([1, 2]);
  });

  it("always writes a row for a failed resolution", async () => {
    const fixture = await seed();
    for (let call = 0; call < 3; call++) {
      await expect(fixture.secrets.resolveSecretValue(fixture.companyId, fixture.secretId, 99, {
        accessContext: systemContext(fixture.connectionId),
      })).rejects.toMatchObject({ status: 404 });
    }
    const rows = await accessRows(fixture.secretId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.outcome === "failure")).toBe(true);
  });

  it("gives a system read for a different config path its own row", async () => {
    const fixture = await seed();
    const read = (configPath: string) => fixture.secrets.resolveSecretValue(
      fixture.companyId, fixture.secretId, "latest", { accessContext: systemContext(fixture.connectionId, configPath) },
    );
    await read("headers.Authorization");
    await read("headers.Authorization");
    await read("oauth.access_token");
    await read("oauth.access_token");
    expect((await accessRows(fixture.secretId)).map((row) => row.configPath).sort())
      .toEqual(["headers.Authorization", "oauth.access_token"]);
  });

  it("keeps one row per read for a user actor on the header path", async () => {
    const fixture = await seed();
    mockUpstream();
    const service = sweepService();
    for (let call = 0; call < 3; call++) {
      await service.checkHealth(fixture.connectionId, { actorType: "user", actorId: "board-user" });
    }
    const rows = await accessRows(fixture.secretId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.heartbeatRunId === null)).toBe(true);
  });

  it("keeps one row per read for a caller that does not opt in", async () => {
    const fixture = await seed();
    for (let call = 0; call < 3; call++) {
      await fixture.secrets.resolveSecretValue(fixture.companyId, fixture.secretId, "latest", {
        accessContext: {
          consumerType: "tool_connection", consumerId: fixture.connectionId, configPath: "headers.Authorization",
          actorType: "user", actorId: "board-user",
        },
      });
    }
    expect(await accessRows(fixture.secretId)).toHaveLength(3);
  });

  it("keeps one row per read for a read with a run id and no opt-in", async () => {
    const fixture = await seed();
    const agentId = randomUUID(), runId = randomUUID();
    await db.insert(agents).values({
      id: agentId, companyId: fixture.companyId, name: "Robot", role: "engineer", adapterType: "codex_local",
    });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: fixture.companyId, agentId, status: "running" });
    for (let call = 0; call < 3; call++) {
      await fixture.secrets.resolveSecretValue(fixture.companyId, fixture.secretId, "latest", {
        accessContext: {
          consumerType: "tool_connection", consumerId: fixture.connectionId, configPath: "headers.Authorization",
          actorType: "system", heartbeatRunId: runId,
        },
      });
    }
    const rows = await db.select().from(secretAccessEvents).where(and(
      eq(secretAccessEvents.secretId, fixture.secretId), eq(secretAccessEvents.heartbeatRunId, runId),
    ));
    expect(rows).toHaveLength(3);
  });

  it("opts in only system or unset actors with no run id", () => {
    const optIn = { auditDedupeWindowMs: TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS };
    expect(systemAuditDedupe({ actorType: "system", actorId: "tool_health_sweep" })).toEqual(optIn);
    expect(systemAuditDedupe(undefined)).toEqual(optIn);
    expect(systemAuditDedupe({ actorType: "user", actorId: "board-user" })).toEqual({});
    expect(systemAuditDedupe({ actorType: "agent", actorId: "agent-1" })).toEqual({});
    expect(systemAuditDedupe({ actorType: "system" }, randomUUID())).toEqual({});
  });
});
