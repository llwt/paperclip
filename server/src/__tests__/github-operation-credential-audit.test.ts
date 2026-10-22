import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  issues,
  runIdentityContexts,
  secretAccessEvents,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { secretService } from "../services/secrets.js";
import {
  GITHUB_OPERATION_AUDIT_WINDOW_MS,
  resolveGitHubOperationCredentials,
} from "../services/github-operation-credentials.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();

// The launcher asks the broker on every networked git and gh command. Each
// answer must stay the same while the audit trail grows once per run and token.
(support.supported ? describe : describe.skip)("GitHub operation credential audit volume", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const secretsDir = path.join(os.tmpdir(), `paperclip-github-audit-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsDir, { recursive: true });
    vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY_FILE", path.join(secretsDir, "master.key"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-audit-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-audit-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
    rmSync(secretsDir, { recursive: true, force: true });
  }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Robot", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Audit volume" });
    const secret = await secretService(db).create(companyId, {
      name: `github-token-${randomUUID()}`, provider: "local_encrypted", value: "dedicated-token-v1",
    });
    const applicationId = randomUUID(), connectionId = randomUUID();
    await db.insert(toolApplications).values({ id: applicationId, companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: connectionId, uid: connectionId, transport: "mcp_remote",
      status: "active", enabled: true, credentialPolicy: "per_agent", config: { sourceTemplateKey: "github" },
    });
    await db.insert(toolConnectionInstalls).values({ companyId, connectionId, targetType: "agent", targetId: agentId });
    await db.insert(connectionGrants).values({
      companyId, connectionId, kind: "agent", subjectAgentId: agentId, status: "active",
      credentialSecretRefs: [{ secretId: secret.id, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: { github: {
        userId: "robot", login: "robot", installationCount: 1, repositoryCount: 1,
        repositorySelection: "selected", installationIds: ["1"], installationOwnerLogins: ["robot"],
      } },
    });
    const run = async () => {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
      await initializeRunIdentity(db, { companyId, runId, responsibleUserId: null, cause: "company_default" });
      return { companyId, agentId, runId };
    };
    return { companyId, agentId, secretId: secret.id, run };
  }

  const accessRows = (secretId: string, runId: string) => db.select().from(secretAccessEvents)
    .where(and(eq(secretAccessEvents.secretId, secretId), eq(secretAccessEvents.heartbeatRunId, runId)));
  const rowVersion = async (table: "company_secrets" | "run_identity_contexts", column: "id" | "run_id", id: string) =>
    (await db.execute(sql`select xmin::text as xmin from ${sql.identifier(table)} where ${sql.identifier(column)} = ${id}`))
      .map((row) => (row as { xmin: string }).xmin).join(",");

  it("writes one access event, one last_resolved_at and one identity update for N calls in one run", async () => {
    const fixture = await seed();
    const input = await fixture.run();
    const first = await resolveGitHubOperationCredentials(db, input);
    expect(first).toMatchObject({ status: "available", source: "dedicated", env: { GH_TOKEN: "dedicated-token-v1" } });
    const [secretAfterFirst] = await db.select().from(companySecrets).where(eq(companySecrets.id, fixture.secretId));
    expect(secretAfterFirst.lastResolvedAt).not.toBeNull();
    const secretVersion = await rowVersion("company_secrets", "id", fixture.secretId);
    const contextVersion = await rowVersion("run_identity_contexts", "run_id", input.runId);

    for (let call = 0; call < 9; call++) {
      expect(await resolveGitHubOperationCredentials(db, input)).toEqual(first);
    }
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(1);
    expect(await rowVersion("company_secrets", "id", fixture.secretId)).toBe(secretVersion);
    expect(await rowVersion("run_identity_contexts", "run_id", input.runId)).toBe(contextVersion);

    // Another run is audited on its own.
    const other = await fixture.run();
    expect(await resolveGitHubOperationCredentials(db, other)).toMatchObject({ status: "available" });
    expect(await accessRows(fixture.secretId, other.runId)).toHaveLength(1);
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(1);
  });

  it("writes again for a new token version and after the window", async () => {
    const fixture = await seed();
    const input = await fixture.run();
    await resolveGitHubOperationCredentials(db, input);
    await resolveGitHubOperationCredentials(db, input);
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(1);

    await secretService(db).rotate(fixture.secretId, { value: "dedicated-token-v2" });
    const rotated = await resolveGitHubOperationCredentials(db, input);
    expect(rotated.env.GH_TOKEN).toBe("dedicated-token-v2");
    await resolveGitHubOperationCredentials(db, input);
    expect((await accessRows(fixture.secretId, input.runId)).map((row) => row.version).sort()).toEqual([1, 2]);

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + GITHUB_OPERATION_AUDIT_WINDOW_MS + 1);
    await resolveGitHubOperationCredentials(db, input);
    await resolveGitHubOperationCredentials(db, input);
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(3);
  });

  it("retries the access event on the next call when the first write fails", async () => {
    const fixture = await seed();
    const input = await fixture.run();
    let failNextAccessEvent = true;
    const flakyDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "insert") return Reflect.get(target, property, receiver);
        return (table: unknown) => {
          if (table === secretAccessEvents && failNextAccessEvent) {
            failNextAccessEvent = false;
            return { values: () => Promise.reject(new Error("transient insert failure")) };
          }
          return target.insert(table as never);
        };
      },
    });
    expect(await resolveGitHubOperationCredentials(flakyDb, input)).toMatchObject({ status: "available" });
    expect(failNextAccessEvent).toBe(false);
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(0);

    await resolveGitHubOperationCredentials(flakyDb, input);
    await resolveGitHubOperationCredentials(flakyDb, input);
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(1);
  });

  it("returns the same broker response body for every call in a run", async () => {
    const fixture = await seed();
    const input = await fixture.run();
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use(errorHandler);
    const token = createRuntimeToolsToken({ ...input, responsibleUserId: "", scope: "github_credentials" })!.token;
    const bodies: string[] = [];
    for (let call = 0; call < 5; call++) {
      const response = await request(app).post("/runtime-tools/github/credentials")
        .set("authorization", `Bearer ${token}`).send({}).expect(200);
      bodies.push(JSON.stringify(response.body));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toMatchObject({ status: "available", env: { GH_TOKEN: "dedicated-token-v1" } });
    expect(await accessRows(fixture.secretId, input.runId)).toHaveLength(1);
    const [context] = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, input.runId));
    expect(context.github).toMatchObject({ status: "available", source: "dedicated" });
  });
});
