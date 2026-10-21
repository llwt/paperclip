import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adapterAuthSessions, companies, createDb, environments } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { LOCAL_LOGIN_METHOD } from "../services/local-ai-login-method.js";
import {
  createDbSetupTokenCleanupStore,
  reapSetupTokenLeases,
  SETUP_TOKEN_ADAPTER_TYPE,
  transitionSetupTokenSessionToStored,
  type SetupTokenCleanupRecord,
} from "../services/setup-token-session.js";

function cleanupRecord(): SetupTokenCleanupRecord {
  return {
    sessionId: randomUUID(),
    companyId: randomUUID(),
    ownerUserId: "synthetic-owner",
    adapterType: SETUP_TOKEN_ADAPTER_TYPE,
    environmentId: randomUUID(),
    leaseId: randomUUID(),
    deadline: Date.now() - 60_000,
    state: "timed_out",
    boundAt: null,
  };
}

describe("setup-token lease cleanup guards", () => {
  it("removes a record with no lease without calling the provider", async () => {
    const record = { ...cleanupRecord(), leaseId: "" };
    const store = { listReapable: vi.fn().mockResolvedValue([record]), remove: vi.fn().mockResolvedValue(undefined) };
    const leases = { releaseById: vi.fn() };

    expect(await reapSetupTokenLeases({ store, leases }, Date.now())).toEqual({ released: 1, failed: 0 });
    expect(leases.releaseById).not.toHaveBeenCalled();
    expect(store.remove).toHaveBeenCalledExactlyOnceWith({
      sessionId: record.sessionId,
      companyId: record.companyId,
      ownerUserId: record.ownerUserId,
      adapterType: record.adapterType,
    });
  });

  it.each([false, true])("logs the error class and SQLSTATE without messages (wrapped: %s)", async (wrapped) => {
    class PostgresError extends Error { code = "22P02"; }
    const databaseError = new PostgresError("synthetic-secret https://example.invalid/private");
    const error = wrapped ? new Error("query contains synthetic-secret", { cause: databaseError }) : databaseError;
    const store = { listReapable: vi.fn().mockResolvedValue([cleanupRecord()]), remove: vi.fn() };
    const leases = { releaseById: vi.fn().mockRejectedValue(error) };
    const log = vi.fn();

    expect(await reapSetupTokenLeases({ store, leases, log }, Date.now())).toEqual({ released: 0, failed: 1 });
    expect(store.remove).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      `[paperclip] Setup-token reaper: a lease release failed (${wrapped ? "Error" : "PostgresError"} 22P02); it stays retryable.`,
    );
    expect(log.mock.calls.flat().join()).not.toContain("synthetic-secret");
    expect(log.mock.calls.flat().join()).not.toContain("https://");
  });

  it("does not log arbitrary error names or codes", async () => {
    const error = Object.assign(new Error("synthetic-secret"), {
      name: "https://example.invalid/private", code: "synthetic-secret",
    });
    const store = { listReapable: vi.fn().mockResolvedValue([cleanupRecord()]), remove: vi.fn() };
    const leases = { releaseById: vi.fn().mockRejectedValue(error) };
    const log = vi.fn();

    await reapSetupTokenLeases({ store, leases, log }, Date.now());

    expect(log).toHaveBeenCalledExactlyOnceWith(
      "[paperclip] Setup-token reaper: a lease release failed (Error); it stays retryable.",
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping setup-token database tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

describeEmbeddedPostgres("setup-token store isolation (embedded postgres)", () => {
  let stopDb: (() => Promise<void>) | undefined;
  let db!: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("setup-token-reaper");
    stopDb = started.stop;
    db = createDb(started.connectionString);
  });
  afterEach(async () => {
    await db.delete(adapterAuthSessions);
    await db.delete(environments);
    await db.delete(companies);
  });
  afterAll(async () => { await stopDb?.(); });

  async function seedLocalLogin(status: typeof adapterAuthSessions.$inferInsert.status = "timed_out") {
    const record = cleanupRecord();
    await db.insert(companies).values({ id: record.companyId, name: "Synthetic company" });
    await db.insert(environments).values({ id: record.environmentId, name: "Synthetic environment", driver: "sandbox" });
    const [row] = await db.insert(adapterAuthSessions).values({
      companyId: record.companyId,
      environmentId: record.environmentId,
      adapterType: SETUP_TOKEN_ADAPTER_TYPE,
      startedByUserId: record.ownerUserId,
      publicSessionId: record.sessionId,
      connectionMethod: LOCAL_LOGIN_METHOD,
      status,
      providerLeaseId: null,
      expiresAt: new Date(Date.now() + 60_000),
    }).returning();
    return { record, row };
  }

  it("reaps only the setup-token row and leaves the local login unchanged across sweeps", async () => {
    const { record, row } = await seedLocalLogin();
    const store = createDbSetupTokenCleanupStore(db);
    const setupToken = { ...record, sessionId: randomUUID() };
    await store.record(setupToken);
    const leases = { releaseById: vi.fn().mockResolvedValue(undefined) };

    expect(await reapSetupTokenLeases({ store, leases }, Date.now())).toEqual({ released: 1, failed: 0 });
    expect(leases.releaseById).toHaveBeenCalledExactlyOnceWith(setupToken.leaseId);
    expect(await db.select().from(adapterAuthSessions)).toEqual([row]);
    expect(await reapSetupTokenLeases({ store, leases }, Date.now())).toEqual({ released: 0, failed: 0 });
    expect(await db.select().from(adapterAuthSessions)).toEqual([row]);
  });

  it("does not discover an active local login but still discovers a setup-token row", async () => {
    const { record } = await seedLocalLogin("waiting_for_user");
    const store = createDbSetupTokenCleanupStore(db);
    expect(await store.findActiveDurable(record, Date.now())).toBeNull();
    await db.delete(adapterAuthSessions);
    const active = { ...record, state: "awaiting_code" as const, deadline: Date.now() + 60_000 };
    await store.record(active);
    expect(await store.findActiveDurable(record, Date.now())).toEqual(active);
  });

  it.each(["markState", "remove", "consumeStoredClaim", "cancelDurable", "transitionToStored"] as const)(
    "%s cannot change a local-login row even with its exact identity",
    async (operation) => {
      const status = operation === "consumeStoredClaim" ? "stored" : "starting";
      const { record, row } = await seedLocalLogin(status);
      const store = createDbSetupTokenCleanupStore(db);
      if (operation === "markState") await store.markState(record, "cancelled");
      if (operation === "remove") await store.remove(record);
      if (operation === "consumeStoredClaim") expect(await store.consumeStoredClaim(record)).toBeNull();
      if (operation === "cancelDurable") expect(await store.cancelDurable(record, ["starting"])).toBeNull();
      if (operation === "transitionToStored") expect(await transitionSetupTokenSessionToStored(db, record)).toBe(false);
      expect(await db.select().from(adapterAuthSessions).where(eq(adapterAuthSessions.id, row.id))).toEqual([row]);
    },
  );
});
