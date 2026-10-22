import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { activityLog, companies, companyMemberships, connectionGrants, createDb, toolConnections } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { secretService } from "../services/secrets.js";
import { checkAiCredential } from "../services/ai-credential-check.js";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { secretRoutes } from "../routes/secrets.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let service: ReturnType<typeof aiConnectionService>;
let app: express.Express;
const companyId = randomUUID();
const owner = "revalidate-owner";
const other = "revalidate-other";
const manager = "revalidate-manager";
const agentId = randomUUID();
const PASTED = `sk-ant-oat01-${"p".repeat(40)}`;

const scopeDenied = () => new Response(JSON.stringify({
  type: "error", error: { type: "permission_error", message: "OAuth token does not meet scope requirement user:profile" },
}), { status: 403 });
const unauthorized = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Invalid bearer token" } }), { status: 401 });
const usageLimit = () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "limited" } }), { status: 429 });

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-revalidate-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-revalidate-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-revalidate-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values({ id: companyId, name: "Revalidate tests", issuePrefix: "ARV" });
  await db.insert(companyMemberships).values([
    { companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" },
    { companyId, principalId: other, principalType: "user", status: "active", membershipRole: "member" },
    { companyId, principalId: manager, principalType: "user", status: "active", membershipRole: "admin" },
  ]);
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.header("x-test-user") ?? owner;
    req.actor = req.header("x-agent")
      ? { type: "agent", agentId, companyId, companyIds: [companyId], onBehalfOfUserId: owner }
      : { type: "board", source: "session", userId, companyIds: [companyId],
          memberships: [{ companyId, status: "active", membershipRole: userId === manager ? "admin" : "member" }] };
    next();
  });
  app.use("/api", aiConnectionRoutes(db));
  app.use("/api", secretRoutes(db));
  app.use((error: { status?: number; message: string; details?: { code?: string } }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message, code: error.details?.code });
  });
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

/** A Claude subscription account with both marks a false auth failure sets. */
async function markedAccount(ownership: "personal" | "shared", saved = `sk-ant-oat01-${randomUUID().replaceAll("-", "")}`) {
  const account = await service.save(companyId, owner, {
    provider: "anthropic", method: "subscription", ownership, name: `Claude ${ownership} ${randomUUID()}`,
    agentIds: [], allAgents: false,
  }, saved);
  await db.update(connectionGrants).set({ status: "needs_reauthorization", updatedAt: new Date() }).where(eq(connectionGrants.id, account.grantId));
  await db.update(toolConnections).set({ healthStatus: "error", healthMessage: "Sign in again to restore this AI connection." }).where(eq(toolConnections.id, account.connectionId));
  return account;
}
async function marks(account: { connectionId: string; grantId: string }) {
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
  return { grant: grant!.status, health: connection!.healthStatus, healthMessage: connection!.healthMessage };
}
async function savedCredential(account: { connectionId: string; grantId: string }) {
  const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
  const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, account.connectionId));
  return service.credential({ connection: connection!, grant: grant! });
}
async function activities(connectionId: string, action: string) {
  return db.select().from(activityLog).where(and(eq(activityLog.entityId, connectionId), eq(activityLog.action, action)));
}
const CLEARED = { grant: "active", health: "ok", healthMessage: null };
const MARKED = { grant: "needs_reauthorization", health: "error" };

describe("credential check", () => {
  it("counts a scope denial, a usage limit and 200 as signed in, and 401 as rejected", async () => {
    const metadata = { provider: "anthropic", method: "subscription" } as const;
    for (const [response, expected] of [
      [scopeDenied, { valid: true, limited: false }],
      [usageLimit, { valid: true, limited: true }],
      [() => new Response("{}"), { valid: true, limited: false }],
      [unauthorized, { valid: false, code: "ai_connection_credential_rejected" }],
      [() => new Response(JSON.stringify({ error: { type: "permission_error", message: "account disabled" } }), { status: 403 }), { valid: false, code: "ai_connection_credential_rejected" }],
      [() => new Response("", { status: 503 }), { valid: false, code: "ai_connection_verification_failed" }],
    ] as const) {
      const fetcher = vi.fn(async () => response());
      expect(await checkAiCredential(metadata, PASTED, fetcher as unknown as typeof fetch)).toMatchObject(expected);
      expect(fetcher).toHaveBeenCalledWith("https://api.anthropic.com/api/oauth/usage", expect.objectContaining({
        redirect: "error", headers: expect.objectContaining({ Authorization: `Bearer ${PASTED}` }),
      }));
    }
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await checkAiCredential(metadata, PASTED, offline as unknown as typeof fetch)).toMatchObject({ valid: false, code: "ai_connection_verification_failed" });
    const api = vi.fn(async () => usageLimit());
    expect(await checkAiCredential({ provider: "anthropic", method: "api_key" }, "sk-ant-api", api as unknown as typeof fetch)).toEqual({ valid: true, limited: true });
    expect(api).toHaveBeenCalledWith("https://api.anthropic.com/v1/models?limit=1", expect.anything());
    const unsupported = vi.fn();
    expect(await checkAiCredential({ provider: "openai", method: "subscription" }, "{}", unsupported as unknown as typeof fetch)).toMatchObject({ valid: false, code: "ai_connection_check_unsupported" });
    expect(unsupported).not.toHaveBeenCalled();
  });
});

describe("reconnect with a pasted setup-token", () => {
  it.each(["personal", "shared"] as const)("clears both marks on a %s grant and rotates the secret in place", async (ownership) => {
    const account = await markedAccount(ownership);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => scopeDenied());
    const response = await request(app).post(`/api/companies/${companyId}/ai-connections/${account.connectionId}/setup-token`).send({ token: ` ${PASTED} ` });
    expect(response.status).toBe(200);
    expect(response.body).toEqual(account);
    expect(JSON.stringify(response.body)).not.toContain(PASTED);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await marks(account)).toEqual(CLEARED);
    expect(await savedCredential(account)).toBe(PASTED);
    expect(await activities(account.connectionId, "ai_connection.reconnected")).toHaveLength(1);
    expect(JSON.stringify(await activities(account.connectionId, "ai_connection.reconnected"))).not.toContain(PASTED);
  });

  it("keeps both marks when the token has the wrong shape or the provider rejects it", async () => {
    const account = await markedAccount("personal");
    const before = await savedCredential(account);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => unauthorized());
    const url = `/api/companies/${companyId}/ai-connections/${account.connectionId}/setup-token`;
    const shape = await request(app).post(url).send({ token: "not-a-setup-token" });
    expect(shape.status).toBe(422);
    expect(shape.body.code).toBe("ai_connection_setup_token_invalid");
    expect(fetchSpy).not.toHaveBeenCalled();
    const rejected = await request(app).post(url).send({ token: PASTED });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe("ai_connection_credential_rejected");
    expect(JSON.stringify(rejected.body)).not.toContain(PASTED);
    expect(await marks(account)).toMatchObject(MARKED);
    expect(await savedCredential(account)).toBe(before);
  });

  it("only lets the account owner reconnect, and never an agent", async () => {
    const account = await markedAccount("personal");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => scopeDenied());
    const url = `/api/companies/${companyId}/ai-connections/${account.connectionId}/setup-token`;
    expect((await request(app).post(url).set("x-test-user", other).send({ token: PASTED })).status).toBe(403);
    expect((await request(app).post(url).set("x-agent", "yes").send({ token: PASTED })).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await marks(account)).toMatchObject(MARKED);
  });
});

describe("a secret change re-checks a marked account", () => {
  it("clears both marks after a valid personal value rotation", async () => {
    const account = await markedAccount("personal");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    const secretId = grant!.credentialSecretRefs[0]!.secretId;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => scopeDenied());
    const response = await request(app).post(`/api/companies/${companyId}/me/user-secrets/${secretId}/rotate`).send({ value: PASTED });
    expect(response.status).toBe(200);
    expect(await marks(account)).toEqual(CLEARED);
    const [logged] = await activities(account.connectionId, "ai_connection.revalidated");
    expect(logged?.details).toMatchObject({ trigger: "secret_rotated", result: "passed" });
  });

  it("clears both marks after a valid shared secret rotation", async () => {
    const account = await markedAccount("shared");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => scopeDenied());
    const response = await request(app).post(`/api/secrets/${grant!.credentialSecretRefs[0]!.secretId}/rotate`).send({ value: PASTED });
    expect(response.status).toBe(200);
    expect(await marks(account)).toEqual(CLEARED);
  });

  it("keeps both marks and shows the reason after an invalid value", async () => {
    const account = await markedAccount("personal");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => unauthorized());
    const response = await request(app).post(`/api/companies/${companyId}/me/user-secrets/${grant!.credentialSecretRefs[0]!.secretId}/rotate`).send({ value: "sk-ant-oat01-revoked-revoked-revoked-revoked" });
    expect(response.status).toBe(200);
    expect(await marks(account)).toEqual({ ...MARKED, healthMessage: expect.stringContaining("rejected") });
    const [logged] = await activities(account.connectionId, "ai_connection.revalidated");
    expect(logged?.details).toMatchObject({ trigger: "secret_rotated", result: "failed", code: "ai_connection_credential_rejected" });
    const listed = await service.list(companyId, owner);
    expect(listed.find((entry) => entry.id === account.connectionId)).toMatchObject({ status: "needs_attention", revalidationSupported: true, healthMessage: expect.stringContaining("rejected") });
  });
});

describe("Check again", () => {
  const url = (connectionId: string) => `/api/companies/${companyId}/ai-connections/${connectionId}/revalidate`;

  it.each(["personal", "shared"] as const)("clears both marks on a pass for a %s grant", async (ownership) => {
    const account = await markedAccount(ownership);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => scopeDenied());
    const response = await request(app).post(url(account.connectionId)).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...account, result: "passed", limited: false });
    expect(await marks(account)).toEqual(CLEARED);
    const [logged] = await activities(account.connectionId, "ai_connection.revalidated");
    expect(logged?.details).toMatchObject({ trigger: "check_again", result: "passed", grantId: account.grantId });
  });

  it("counts a usage-limit answer as signed in", async () => {
    const account = await markedAccount("personal");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => usageLimit());
    // No request body at all.
    const response = await request(app).post(url(account.connectionId));
    expect(response.body).toMatchObject({ result: "passed", limited: true });
    expect(await marks(account)).toEqual(CLEARED);
  });

  it("keeps both marks on a fail and logs the result", async () => {
    const account = await markedAccount("personal");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => unauthorized());
    const response = await request(app).post(url(account.connectionId)).send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ result: "failed", code: "ai_connection_credential_rejected" });
    expect(await marks(account)).toMatchObject(MARKED);
    const [logged] = await activities(account.connectionId, "ai_connection.revalidated");
    expect(logged?.details).toMatchObject({ trigger: "check_again", result: "failed" });
  });

  it("rejects agents and other users, and lets a connection manager check a shared grant", async () => {
    const personal = await markedAccount("personal");
    const shared = await markedAccount("shared");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => scopeDenied());
    expect((await request(app).post(url(personal.connectionId)).set("x-agent", "yes").send({})).status).toBe(403);
    expect((await request(app).post(url(personal.connectionId)).set("x-test-user", other).send({})).status).toBe(403);
    expect((await request(app).post(url(personal.connectionId)).set("x-test-user", manager).send({})).status).toBe(403);
    expect((await request(app).post(url(shared.connectionId)).set("x-test-user", other).send({})).status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await marks(personal)).toMatchObject(MARKED);
    expect((await request(app).post(url(shared.connectionId)).set("x-test-user", manager).send({})).status).toBe(200);
    expect(await marks(shared)).toEqual(CLEARED);
  });

  it("does not clear the marks for a value rotated while the check ran", async () => {
    const account = await markedAccount("shared");
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, account.grantId));
    const secretId = grant!.credentialSecretRefs[0]!.secretId;
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => { answer = resolve; });
    const provider = vi.fn()
      .mockImplementationOnce(async () => { await answered; return scopeDenied(); })
      .mockImplementation(async () => unauthorized());
    const checking = service.revalidate({
      companyId, connectionId: account.connectionId, grantId: account.grantId, userId: owner,
      trigger: "check_again", request: provider as unknown as typeof fetch,
    }).then(() => "passed", (error: Error) => error.message);
    await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));
    // A rotation to a rejected value holds the secret row until it commits.
    let commit!: () => void;
    const committed = new Promise<void>((resolve) => { commit = resolve; });
    let rotated!: () => void;
    const rotating = new Promise<void>((resolve) => { rotated = resolve; });
    const rotation = db.transaction(async (tx) => {
      await secretService(tx).rotate(secretId, { value: "sk-ant-oat01-rotated-rotated-rotated-rotated" }, { userId: owner, agentId: null });
      rotated();
      await committed;
    });
    await rotating;
    answer();
    await vi.waitFor(async () => {
      const waiting = await db.execute(sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`);
      expect((waiting as unknown as { rows?: Array<{ n: number }> }).rows?.[0]?.n ?? (waiting as unknown as Array<{ n: number }>)[0]?.n).toBeGreaterThan(0);
    }, { timeout: 10000 });
    commit();
    await rotation;
    expect(await checking).toContain("changed while it was checked");
    expect(await marks(account)).toMatchObject(MARKED);
    const [after] = await service.revalidateAfterSecretChange({ companyId, secretId, userId: owner, request: provider as unknown as typeof fetch });
    expect(after).toMatchObject({ result: "failed" });
    expect(await marks(account)).toMatchObject(MARKED);
  });

  it("refuses providers without a check and leaves them unchanged", async () => {
    const account = await service.save(companyId, owner, { provider: "openai", method: "subscription", ownership: "personal", name: "Codex", agentIds: [], allAgents: false }, "{}");
    await db.update(connectionGrants).set({ status: "needs_reauthorization" }).where(eq(connectionGrants.id, account.grantId));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await request(app).post(url(account.connectionId)).send({});
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("ai_connection_check_unsupported");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
