import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import express from "express";
import pino from "pino";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  connectionGrants,
  createDb,
  issueThreadInteractions,
  issues,
  principalPermissionGrants,
  secretAccessEvents,
  toolAccessAuditEvents,
  toolApplications,
  toolCallEvents,
  toolCatalogEntries,
  toolConnectionInstalls,
  toolConnections,
  toolInvocations,
  toolActionRequests,
  toolOauthStates,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolRuntimeSlots,
} from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { connectToolAppSchema, parseOAuthScopeList, readOAuthSignInSettings } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import { toolAccessService } from "../services/tool-access.js";
import {
  loopbackOAuthCallbackRelayTarget,
  loopbackOAuthRedirectUri,
  loopbackOAuthState,
  loopbackOAuthStateMatchesClient,
  nextOAuthSignInSettings,
  oauthScopesOutsideRequest,
  parseLoopbackOAuthState,
  recheckOAuthSignIn,
  resolveGenericOAuthScopes,
} from "../services/tool-oauth-sign-in.js";
import { toolAccessRoutes } from "../routes/tool-access.js";
import { errorHandler } from "../middleware/index.js";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";
import { createHttpLogger } from "../middleware/logger.js";
import { HTTP_LOG_REDACT_PATHS } from "../middleware/http-log-redaction.js";

/**
 * Fork-only (llwt/paperclip, NX-617): per-connection "sign in through
 * localhost" and requested-scope list for a pasted remote MCP URL.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PUBLIC_BASE_URL = "https://paperclip.fixture.test";
const PUBLIC_REDIRECT_URI = `${PUBLIC_BASE_URL}/api/tools/oauth/callback`;
const SERVER_PORT = 3100;
const LOOPBACK_REDIRECT_URI = `http://localhost:${SERVER_PORT}/api/tools/oauth/callback`;

// A public IP literal keeps the fetch fixture deterministic (see
// generic-mcp-connection.test.ts for why a made-up hostname would not work).
const MCP_ORIGIN = "https://8.8.8.8";
const MCP_URL = `${MCP_ORIGIN}/mcp`;
const ISSUER = `${MCP_ORIGIN}/tenant/acme`;
const ADVERTISED_SCOPES = ["mcp:read", "mcp:write", "mcp:delete"];

describe("localhost sign-in helpers", () => {
  it("builds the callback address from the server's own port only", () => {
    expect(loopbackOAuthRedirectUri(3100)).toBe("http://localhost:3100/api/tools/oauth/callback");
    for (const port of [undefined, null, 0, -1, 65536, 3100.5, Number.NaN]) {
      expect(loopbackOAuthRedirectUri(port)).toBeNull();
    }
  });

  it("carries the start port and client binding of a localhost attempt in its state", () => {
    const state = loopbackOAuthState("random-token_-", "client-a", 3100)!;
    expect(state.startsWith("lb2.3100.")).toBe(true);
    expect(state.endsWith(".random-token_-")).toBe(true);
    const attempt = parseLoopbackOAuthState(state);
    expect(attempt).toMatchObject({ kind: "loopback", port: 3100 });
    if (attempt?.kind !== "loopback") throw new Error("expected a localhost attempt");
    expect(loopbackOAuthStateMatchesClient(attempt, "client-a")).toBe(true);
    expect(loopbackOAuthStateMatchesClient(attempt, "client-b")).toBe(false);
    expect(parseLoopbackOAuthState(loopbackOAuthState("r", "c", 1)!)).toMatchObject({ kind: "loopback", port: 1 });
    expect(parseLoopbackOAuthState(loopbackOAuthState("r", "c", 65535)!)).toMatchObject({ kind: "loopback", port: 65535 });
    // No state without a usable port.
    for (const port of [0, -1, 65536, 3100.5, Number.NaN]) {
      expect(loopbackOAuthState("r", "c", port)).toBeNull();
    }
    // Ordinary states are base64url: no dot, never a localhost attempt.
    expect(parseLoopbackOAuthState("b3JkaW5hcnktc3RhdGU_-")).toBeNull();
  });

  it("refuses every dotted state it cannot read instead of treating it as ordinary", () => {
    for (const state of [
      // The earlier format, which has no port.
      "lb1.binding.random",
      "lb3.3100.binding.random",
      "lb2.binding.random",
      "lb2.3100.binding",
      "lb2.3100.binding.random.extra",
      "lb2..binding.random",
      "lb2.3100..random",
      "lb2.3100.binding.",
      // Ports that are not a canonical integer from 1 to 65535.
      "lb2.0.binding.random",
      "lb2.65536.binding.random",
      "lb2.03100.binding.random",
      "lb2.+3100.binding.random",
      "lb2.3100x.binding.random",
      "lb2.31e2.binding.random",
      "lb2. 3100.binding.random",
      "lb2.evil.example.binding.random",
      "a.b",
      ".",
    ]) {
      expect(parseLoopbackOAuthState(state), state).toEqual({ kind: "unsupported" });
    }
  });

  it("leaves scope selection alone without a list and treats a list as the ceiling", () => {
    expect(resolveGenericOAuthScopes(null, undefined)).toEqual({ ok: true, scopes: null });
    expect(resolveGenericOAuthScopes(null, ["a", "b"])).toEqual({ ok: true, scopes: ["a", "b"] });
    expect(resolveGenericOAuthScopes(null, [])).toEqual({ ok: true, scopes: [] });
    expect(resolveGenericOAuthScopes(["a", "b"], undefined)).toEqual({ ok: true, scopes: ["a", "b"] });
    expect(resolveGenericOAuthScopes(["a", "b"], ["b"])).toEqual({ ok: true, scopes: ["b"] });
    expect(resolveGenericOAuthScopes(["a", "b"], ["b", "c"])).toEqual({ ok: false, reason: "widened", scopes: ["c"] });
    expect(resolveGenericOAuthScopes(["a", "b"], [])).toEqual({ ok: false, reason: "empty" });
    expect(resolveGenericOAuthScopes(["a", "b"], [" "])).toEqual({ ok: false, reason: "empty" });
  });

  it("finds granted scopes that were not requested", () => {
    expect(oauthScopesOutsideRequest("a b", ["a", "b"])).toEqual([]);
    expect(oauthScopesOutsideRequest("a  c c", ["a", "b"])).toEqual(["c"]);
    expect(oauthScopesOutsideRequest(["a", "d"], ["a"])).toEqual(["d"]);
    expect(oauthScopesOutsideRequest(undefined, ["a"])).toEqual([]);
  });

  it("rechecks an attempt against the connection as it is when credentials are stored", () => {
    const base = {
      latestOauth: {} as Record<string, unknown>,
      startedWithOauth: {} as Record<string, unknown>,
      attemptScopes: [] as string[],
      loopbackAttempt: false,
      grantedScope: "a b c" as unknown,
    };
    // No settings now: nothing to hold the attempt to, as before this change.
    expect(recheckOAuthSignIn(base)).toBeNull();
    const listed = { ...base, latestOauth: { requestedScopes: ["a", "b"] } };
    expect(recheckOAuthSignIn({ ...listed, attemptScopes: ["a"], grantedScope: "a" })).toBeNull();
    expect(recheckOAuthSignIn({ ...listed, attemptScopes: ["a"], grantedScope: undefined })).toBeNull();
    expect(recheckOAuthSignIn({ ...listed, attemptScopes: [] })).toEqual({ kind: "changed" });
    expect(recheckOAuthSignIn({ ...listed, attemptScopes: ["a", "c"] })).toEqual({ kind: "changed" });
    expect(recheckOAuthSignIn({ ...listed, attemptScopes: ["a"], grantedScope: "a b" }))
      .toEqual({ kind: "overgrant", scopes: ["b"] });
    const loopback = { ...base, loopbackAttempt: true };
    expect(recheckOAuthSignIn({ ...loopback, latestOauth: { clientId: "x" }, startedWithOauth: { clientId: "x" } })).toBeNull();
    expect(recheckOAuthSignIn({ ...loopback, latestOauth: { clientId: "y" }, startedWithOauth: { clientId: "x" } })).toEqual({ kind: "changed" });
    expect(recheckOAuthSignIn({ ...loopback, latestOauth: {}, startedWithOauth: { clientId: "x" } })).toEqual({ kind: "changed" });
    expect(recheckOAuthSignIn({ ...loopback, latestOauth: { clientId: "y" }, startedWithOauth: {} })).toEqual({ kind: "changed" });
    // A client the deployment preconfigured is in neither config.
    expect(recheckOAuthSignIn(loopback)).toBeNull();
  });

  it("keeps stored settings when the form omits them and clears them on false or null", () => {
    const stored = { loopbackRedirect: true, requestedScopes: ["a"] };
    expect(nextOAuthSignInSettings(undefined, stored)).toEqual({ loopbackRedirect: true, requestedScopes: ["a"] });
    expect(nextOAuthSignInSettings({}, stored)).toEqual({ loopbackRedirect: true, requestedScopes: ["a"] });
    expect(nextOAuthSignInSettings({ loopbackRedirect: false, requestedScopes: null }, stored))
      .toEqual({ loopbackRedirect: false, requestedScopes: null });
    expect(nextOAuthSignInSettings({ requestedScopes: ["b"] }, stored))
      .toEqual({ loopbackRedirect: true, requestedScopes: ["b"] });
    expect(nextOAuthSignInSettings(undefined, null)).toEqual({ loopbackRedirect: false, requestedScopes: null });
  });

  it("reads absent, malformed and empty stored settings as off", () => {
    for (const oauth of [undefined, null, [], "x", {}, { loopbackRedirect: "true", requestedScopes: [] }, { requestedScopes: "a b" }, { requestedScopes: [1, "has space", ""] }]) {
      expect(readOAuthSignInSettings(oauth)).toEqual({ loopbackRedirect: false, requestedScopes: null });
    }
    expect(readOAuthSignInSettings({ loopbackRedirect: true, requestedScopes: ["a", "a", "b"] }))
      .toEqual({ loopbackRedirect: true, requestedScopes: ["a", "b"] });
  });

  it("validates the settings on the connect request", () => {
    const parse = (oauthSignIn: unknown) => connectToolAppSchema.safeParse({ link: MCP_URL, oauthSignIn });
    expect(parse({ loopbackRedirect: true, requestedScopes: [" read:me ", "read:me", "offline_access"] }))
      .toMatchObject({ success: true, data: { oauthSignIn: { loopbackRedirect: true, requestedScopes: ["read:me", "offline_access"] } } });
    expect(parse({ requestedScopes: null }).success).toBe(true);
    expect(parse({}).success).toBe(true);
    expect(parse({ requestedScopes: [] }).success).toBe(false);
    expect(parse({ requestedScopes: ["two words"] }).success).toBe(false);
    expect(parse({ requestedScopes: ["line\nbreak"] }).success).toBe(false);
    expect(parse({ requestedScopes: ["quote\""] }).success).toBe(false);
    expect(parse({ requestedScopes: ["x".repeat(257)] }).success).toBe(false);
    expect(parse({ requestedScopes: Array.from({ length: 65 }, (_, index) => `s${index}`) }).success).toBe(false);
    expect(parse({ loopbackRedirect: "yes" }).success).toBe(false);
    expect(parse({ redirectUri: "https://evil.example" }).success).toBe(false);
  });

  it("splits a typed scope list", () => {
    expect(parseOAuthScopeList("read:me, read:account\noffline_access  read:me"))
      .toEqual({ scopes: ["read:me", "read:account", "offline_access"], invalid: [] });
    expect(parseOAuthScopeList("ok bad\"one")).toEqual({ scopes: ["ok"], invalid: ["bad\"one"] });
    expect(parseOAuthScopeList("  ")).toEqual({ scopes: [], invalid: [] });
  });

  describe("callback relay", () => {
    const base = {
      actorType: "none",
      path: "/api/tools/oauth/callback",
      hostHeader: "localhost:3100",
      hasForwardedHost: false,
      publicBaseUrl: PUBLIC_BASE_URL,
      query: { state: "s1", code: "c1" } as Record<string, unknown>,
    };

    it("relays localhost and 127.0.0.1 to the configured public callback", () => {
      expect(loopbackOAuthCallbackRelayTarget(base)).toBe(`${PUBLIC_REDIRECT_URI}?state=s1&code=c1`);
      for (const hostHeader of ["localhost", "127.0.0.1", "127.0.0.1:3100", "localhost:65535"]) {
        expect(loopbackOAuthCallbackRelayTarget({ ...base, hostHeader })).toBe(`${PUBLIC_REDIRECT_URI}?state=s1&code=c1`);
      }
    });

    it("copies only state, code, error and iss, and only as plain strings", () => {
      const target = loopbackOAuthCallbackRelayTarget({
        ...base,
        query: {
          state: "s 1&x=y",
          code: ["a", "b"],
          error: "access_denied",
          iss: "https://issuer.example/a?b=c",
          error_description: "provider prose",
          next: "https://evil.example",
          redirect_uri: "https://evil.example",
        },
      })!;
      const url = new URL(target);
      expect(url.origin + url.pathname).toBe(PUBLIC_REDIRECT_URI);
      expect([...url.searchParams.keys()]).toEqual(["state", "error", "iss"]);
      expect(url.searchParams.get("state")).toBe("s 1&x=y");
      expect(url.searchParams.get("iss")).toBe("https://issuer.example/a?b=c");
    });

    it("does not relay a signed-in request, whatever the actor", () => {
      for (const actorType of ["board", "agent", "user", ""]) {
        expect(loopbackOAuthCallbackRelayTarget({ ...base, actorType })).toBeNull();
      }
    });

    it("does not relay any host that is not exactly localhost or 127.0.0.1", () => {
      for (const hostHeader of [
        undefined,
        "",
        "evil.example",
        "localhost.evil.example",
        "evil.example:3100",
        "localhost@evil.example",
        "user:pw@localhost",
        "evil.example#localhost",
        "localhost:3100.evil.example",
        "localhost:",
        "localhost:0",
        "localhost:65536",
        "localhost:99999",
        "localhost:31a0",
        "localhost:3100/",
        " localhost",
        "LOCALHOST",
        "127.0.0.2",
        "127.1",
        "0.0.0.0",
        "[::1]",
        "[::1]:3100",
        "paperclip.fixture.test",
      ]) {
        expect(loopbackOAuthCallbackRelayTarget({ ...base, hostHeader }), String(hostHeader)).toBeNull();
      }
    });

    it("does not relay behind a proxy, off the exact path, or without a state", () => {
      expect(loopbackOAuthCallbackRelayTarget({ ...base, hasForwardedHost: true })).toBeNull();
      for (const path of ["/api/tools/oauth/callback/", "/api/tools/oauth/Callback", "/api/tools/oauth/callback/x", "/tools/oauth/callback", "//evil.example/api/tools/oauth/callback", ""]) {
        expect(loopbackOAuthCallbackRelayTarget({ ...base, path }), path).toBeNull();
      }
      for (const query of [{}, { code: "c1" }, { state: "" }, { state: ["a"] }, { state: { a: "b" } }]) {
        expect(loopbackOAuthCallbackRelayTarget({ ...base, query })).toBeNull();
      }
    });

    it("only ever targets an HTTPS, credential-free, non-loopback configured address", () => {
      for (const publicBaseUrl of [
        null,
        "",
        "not a url",
        "http://paperclip.fixture.test",
        "https://user:pw@paperclip.fixture.test",
        "https://user@paperclip.fixture.test",
        "https://localhost",
        "https://localhost:3100",
        "https://app.localhost",
        "https://127.0.0.1",
        "https://127.9.9.9",
        "https://0.0.0.0",
        "https://[::1]",
        "https://[::]",
        "https://[::ffff:127.0.0.1]",
        "ftp://paperclip.fixture.test",
      ]) {
        expect(loopbackOAuthCallbackRelayTarget({ ...base, publicBaseUrl }), String(publicBaseUrl)).toBeNull();
      }
      // A configured path or query never reaches the target.
      expect(loopbackOAuthCallbackRelayTarget({ ...base, publicBaseUrl: `${PUBLIC_BASE_URL}/some/path?x=1` }))
        .toBe(`${PUBLIC_REDIRECT_URI}?state=s1&code=c1`);
    });
  });
});

type FixtureOptions = {
  /** `scope` the token endpoint reports. Defaults to the scopes the authorization asked for. */
  grantedScope?: string;
};

function jsonResponse(payload: unknown, status = 200): Response {
  const body = JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
    text: async () => body,
    json: async () => payload,
  } as unknown as Response;
}

function headerRecord(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw as Array<[string, string]>);
  return Object.fromEntries(Object.entries(raw as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
}

/** An MCP server plus its authorization server, behind `fetch`. */
function installFixture(options: FixtureOptions = {}) {
  const requests: Array<{ url: string; method: string; body: URLSearchParams | Record<string, unknown> | null }> = [];
  const issuedCodes = new Map<string, { scope: string | null; clientId: string | null; redirectUri: string | null }>();
  let accessToken: string | null = null;
  let registrations = 0;
  let refreshes = 0;
  // Lets a test hold one request open and act while it is in flight.
  const gates = new Map<string, { reached: () => void; released: Promise<void> }>();
  const passGate = async (kind: string) => {
    const gate = gates.get(kind);
    if (!gate) return;
    gates.delete(kind);
    gate.reached();
    await gate.released;
  };
  const resourceMetadataUrl = `${MCP_ORIGIN}/.well-known/oauth-protected-resource/mcp`;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const href = String(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerRecord(init);
    const bodyText = typeof init?.body === "string" ? init.body : init?.body?.toString?.() ?? null;
    const body = bodyText
      ? headers["content-type"]?.includes("json")
        ? (JSON.parse(bodyText) as Record<string, unknown>)
        : new URLSearchParams(bodyText)
      : null;
    requests.push({ url: href, method, body });

    if (href === MCP_URL && method === "POST") {
      if (headers.authorization !== `Bearer ${accessToken}`) {
        return {
          ok: false,
          status: 401,
          headers: {
            get: (name: string) => name.toLowerCase() === "www-authenticate"
              ? `Bearer resource_metadata="${resourceMetadataUrl}"`
              : null,
          },
          text: async () => "",
          json: async () => ({}),
        } as unknown as Response;
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: "paperclip-catalog-refresh",
        result: { tools: [{ name: "list_things", annotations: { readOnlyHint: true } }] },
      });
    }
    if (href === resourceMetadataUrl) {
      return jsonResponse({ resource: MCP_URL, authorization_servers: [ISSUER], scopes_supported: ADVERTISED_SCOPES });
    }
    if (href === `${MCP_ORIGIN}/.well-known/oauth-authorization-server/tenant/acme`) {
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        // Advertised on purpose: a localhost callback must still not use it.
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ADVERTISED_SCOPES,
      });
    }
    if (href === `${ISSUER}/register` && method === "POST") {
      await passGate("register");
      registrations += 1;
      const requested = body as Record<string, unknown>;
      return jsonResponse({
        client_id: `fixture-client-${registrations}`,
        redirect_uris: requested.redirect_uris,
        grant_types: requested.grant_types,
        response_types: requested.response_types,
        token_endpoint_auth_method: requested.token_endpoint_auth_method,
        application_type: requested.application_type,
      });
    }
    if (href === `${ISSUER}/token` && method === "POST") {
      const form = body as URLSearchParams;
      if (form.get("grant_type") === "refresh_token") {
        await passGate("refresh");
        refreshes += 1;
        accessToken = `fixture-access-${randomUUID()}`;
        return jsonResponse({
          access_token: accessToken,
          refresh_token: `fixture-refresh-rotated-${refreshes}`,
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      await passGate("exchange");
      const issued = issuedCodes.get(form.get("code") ?? "");
      // A real authorization server refuses a code presented with another
      // callback or client than the one it was issued for.
      if (!issued || issued.redirectUri !== form.get("redirect_uri") || issued.clientId !== form.get("client_id")) {
        return jsonResponse({ error: "invalid_grant" }, 400);
      }
      accessToken = `fixture-access-${randomUUID()}`;
      return jsonResponse({
        access_token: accessToken,
        refresh_token: "fixture-refresh-initial",
        expires_in: 3600,
        token_type: "Bearer",
        ...(options.grantedScope ?? issued.scope ? { scope: options.grantedScope ?? issued.scope } : {}),
      });
    }
    return jsonResponse({ error: "not_found" }, 404);
  });

  return {
    requests,
    /**
     * Hold the next request of this kind open. `reached` resolves when the
     * server is waiting on it; `release` lets it answer.
     */
    pauseNext(kind: "register" | "exchange" | "refresh") {
      let reached!: () => void;
      let release!: () => void;
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      gates.set(kind, { reached, released });
      return { reached: reachedPromise, release };
    },
    issueCode(authorizationUrl: string) {
      const parsed = new URL(authorizationUrl);
      const code = `fixture-code-${randomUUID()}`;
      issuedCodes.set(code, {
        scope: parsed.searchParams.get("scope"),
        clientId: parsed.searchParams.get("client_id"),
        redirectUri: parsed.searchParams.get("redirect_uri"),
      });
      return code;
    },
    requestsTo(suffix: string) {
      return requests.filter((entry) => entry.url.endsWith(suffix));
    },
    tokenRequests(grantType: string) {
      return requests
        .filter((entry) => entry.url === `${ISSUER}/token`)
        .map((entry) => entry.body as URLSearchParams)
        .filter((form) => form.get("grant_type") === grantType);
    },
  };
}

/** The address the relay page sends the browser to, or `null` when it is not a relay page. */
function relayedTo(response: { status: number; text: string; headers: Record<string, string> }): URL | null {
  if (response.status !== 200 || response.headers.location) return null;
  const match = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(response.text ?? "");
  return match ? new URL(match[1]!.replaceAll("&amp;", "&")) : null;
}

type TestActor = "board" | "none";

function createRouteApp(
  db: ReturnType<typeof createDb>,
  input: { actor?: TestActor; oauthLoopbackPort?: number | null; requestLogger?: express.RequestHandler } = {},
) {
  const app = express();
  app.use(express.json());
  if (input.requestLogger) app.use(input.requestLogger);
  app.use((req, _res, next) => {
    req.actor = input.actor === "none"
      ? { type: "none", source: "none" }
      : {
          type: "board",
          userId: "board-user",
          userName: "Board User",
          userEmail: null,
          isInstanceAdmin: true,
          source: "local_implicit",
        };
    next();
  });
  app.use("/api", toolAccessRoutes(db, {
    oauthLoopbackPort: input.oauthLoopbackPort === undefined ? SERVER_PORT : input.oauthLoopbackPort,
  }));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("localhost sign-in for a pasted MCP URL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oauth-loopback-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.delete(toolCallEvents);
    await db.delete(toolInvocations);
    await db.delete(toolActionRequests);
    await db.delete(toolOauthStates);
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(activityLog);
    await db.delete(toolAccessAuditEvents);
    await db.delete(toolRuntimeSlots);
    await db.delete(toolConnectionInstalls);
    await db.delete(toolProfileBindings);
    await db.delete(toolProfileEntries);
    await db.delete(toolProfiles);
    await db.delete(toolCatalogEntries);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(principalPermissionGrants);
    await db.delete(companyMemberships);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createCompany() {
    const company = await db
      .insert(companies)
      .values({ name: `Loopback ${randomUUID()}`, issuePrefix: `LB${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: "board-user",
      status: "active",
      membershipRole: "admin",
    });
    return company;
  }

  async function connect(
    app: express.Express,
    companyId: string,
    body: Record<string, unknown> = {},
  ) {
    const response = await request(app)
      .post(`/api/companies/${companyId}/tools/apps/connect`)
      .send({ link: MCP_URL, name: "Fixture", ...body });
    return response;
  }

  async function connectionRow(connectionId: string) {
    const [row] = await db.select().from(toolConnections).where(eq(toolConnections.id, connectionId));
    return row!;
  }

  function oauthOf(row: { config: Record<string, unknown> }) {
    return (row.config.oauth ?? {}) as Record<string, unknown>;
  }

  const LOOPBACK_SETTINGS = { loopbackRedirect: true, requestedScopes: ["mcp:read"] };

  it("leaves a connection without the settings exactly as before: public callback, advertised scopes, renewal", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    // The server knows its port, but the switch is off.
    const app = createRouteApp(db);

    const connected = await connect(app, company.id);
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    const authorizationUrl = new URL(connected.body.auth.startUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(PUBLIC_REDIRECT_URI);
    expect(authorizationUrl.searchParams.get("scope")).toBe(ADVERTISED_SCOPES.join(" "));
    const state = authorizationUrl.searchParams.get("state")!;
    expect(state).not.toContain(".");
    expect(parseLoopbackOAuthState(state)).toBeNull();
    const [stateRow] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
    expect(stateRow!.requestedScopes).toBeNull();

    const afterStart = await connectionRow(connected.body.connectionId);
    expect(oauthOf(afterStart)).not.toHaveProperty("loopbackRedirect");
    expect(oauthOf(afterStart)).not.toHaveProperty("requestedScopes");
    expect(oauthOf(afterStart)).toMatchObject({ clientRedirectUri: PUBLIC_REDIRECT_URI, scopes: ADVERTISED_SCOPES });

    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({ state, code: fixture.issueCode(connected.body.auth.startUrl), iss: ISSUER })
      .expect(303);
    const [exchange] = fixture.tokenRequests("authorization_code");
    expect(exchange!.get("redirect_uri")).toBe(PUBLIC_REDIRECT_URI);

    const active = await connectionRow(connected.body.connectionId);
    expect(active).toMatchObject({ status: "active", authKind: "oauth" });
    await db
      .update(toolConnections)
      .set({ config: { ...active.config, oauth: { ...oauthOf(active), expiresAt: "2000-01-01T00:00:00.000Z" } } })
      .where(eq(toolConnections.id, active.id));
    const health = await toolAccessService(db).checkHealth(active.id);
    expect(health.connection.healthStatus).toBe("ok");
    const [renewal] = fixture.tokenRequests("refresh_token");
    expect(renewal!.get("refresh_token")).toBe("fixture-refresh-initial");
    expect(renewal!.has("redirect_uri")).toBe(false);
  });

  it("starts the sign-in with the localhost callback and the listed scopes only", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);

    const connected = await connect(app, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);

    // The very first authorization request already carries both settings.
    const authorizationUrl = new URL(connected.body.auth.startUrl);
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(authorizationUrl.searchParams.get("scope")).toBe("mcp:read");
    expect(connected.body.auth.registrationSource).toBe("dcr");

    // The client is registered for the localhost callback, and the public
    // client metadata document (which lists the public callback) is not used.
    const registration = fixture.requestsTo("/register");
    expect(registration).toHaveLength(1);
    expect(registration[0]!.body).toMatchObject({ redirect_uris: [LOOPBACK_REDIRECT_URI] });
    expect(authorizationUrl.searchParams.get("client_id")).toBe("fixture-client-1");

    const state = authorizationUrl.searchParams.get("state")!;
    expect(parseLoopbackOAuthState(state)).toMatchObject({ kind: "loopback", port: SERVER_PORT });
    const [stateRow] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
    expect(stateRow!.requestedScopes).toEqual(["mcp:read"]);

    const row = await connectionRow(connected.body.connectionId);
    expect(oauthOf(row)).toMatchObject({
      loopbackRedirect: true,
      requestedScopes: ["mcp:read"],
      clientRedirectUri: LOOPBACK_REDIRECT_URI,
      scopes: ["mcp:read"],
    });
    expect(row.transportConfig).toEqual(row.config);
  });

  it("uses the localhost callback from every sign-in start", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);
    const connected = await connect(app, company.id, { oauthSignIn: LOOPBACK_SETTINGS, grantKind: "user" });
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    const connectionId = connected.body.connectionId as string;

    const reconnect = await request(app).post(`/api/tools/oauth/${connectionId}/start`).send({ asCurrentUser: true });
    expect(reconnect.status, JSON.stringify(reconnect.body)).toBe(200);
    const board = await request(app)
      .post(`/api/companies/${company.id}/tools/connections/${connectionId}/start-authorization`)
      .send({ subjectUserId: "board-user" });
    expect(board.status, JSON.stringify(board.body)).toBe(200);

    for (const url of [reconnect.body.authorizationUrl, board.body.url]) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
      expect(parsed.searchParams.get("scope")).toBe("mcp:read");
    }
  });

  it("exchanges the code with the localhost callback on the public address", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);
    const connected = await connect(app, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    const startUrl = connected.body.auth.startUrl as string;
    const state = new URL(startUrl).searchParams.get("state")!;

    // The session-bearing request arrives on the public address; the route
    // computes the public callback for it. The exchange must not use that.
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Host", "paperclip.fixture.test")
      .set("Accept", "text/html")
      .query({ state, code: fixture.issueCode(startUrl), iss: ISSUER })
      .expect(303);

    const exchanges = fixture.tokenRequests("authorization_code");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(exchanges[0]!.get("client_id")).toBe("fixture-client-1");
    expect(exchanges[0]!.get("code_verifier")).toBeTruthy();

    const row = await connectionRow(connected.body.connectionId);
    expect(row).toMatchObject({ status: "active", enabled: true, authKind: "oauth" });
    // The settings survive the callback.
    expect(oauthOf(row)).toMatchObject({ loopbackRedirect: true, requestedScopes: ["mcp:read"] });
  });

  it("relays a session-less localhost callback to the public address and completes there", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const logChunks: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logChunks.push(chunk.toString());
        callback();
      },
    });
    const requestLogger = createHttpLogger(pino({ redact: [...HTTP_LOG_REDACT_PATHS] }, logStream));
    const publicApp = createRouteApp(db);
    // What the browser reaches through `ssh -L 3100:127.0.0.1:3100`: the same
    // server, but no Paperclip session cookie for `localhost`.
    const localhostApp = createRouteApp(db, { actor: "none", requestLogger });
    const connected = await connect(publicApp, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    const startUrl = connected.body.auth.startUrl as string;
    const state = new URL(startUrl).searchParams.get("state")!;
    const code = fixture.issueCode(startUrl);

    const relayed = await request(localhostApp)
      .get("/api/tools/oauth/callback")
      .set("Host", `localhost:${SERVER_PORT}`)
      .set("Accept", "text/html")
      .query({ state, code, iss: ISSUER, next: "https://evil.example" });
    expect(relayed.status).toBe(200);
    expect(relayed.headers["cache-control"]).toBe("no-store");
    expect(relayed.headers["referrer-policy"]).toBe("no-referrer");
    const location = relayedTo(relayed)!;
    expect(location.origin + location.pathname).toBe(PUBLIC_REDIRECT_URI);
    expect(Object.fromEntries(location.searchParams)).toEqual({ state, code, iss: ISSUER });
    // Nothing happened on the relay hop.
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(1);
    // The request log records response headers, so the address travels in the
    // page body: neither the code nor the state reaches the log.
    const httpLog = logChunks.join("");
    expect(httpLog).toContain("/api/tools/oauth/callback");
    expect(httpLog).not.toContain(state);
    expect(httpLog).not.toContain(code);

    // The browser follows the redirect as a cross-site navigation, gets the
    // existing interstitial, and the same-origin repeat completes the sign-in.
    const relayedPath = `${location.pathname}${location.search}`;
    const interstitial = await request(publicApp)
      .get(relayedPath)
      .set("Host", "paperclip.fixture.test")
      .set("Accept", "text/html")
      .set("Sec-Fetch-Site", "cross-site")
      .set("Sec-Fetch-Mode", "navigate");
    expect(interstitial.status).toBe(200);
    expect(interstitial.text).toContain("Finishing your connection");
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
    await request(publicApp)
      .get(relayedPath)
      .set("Host", "paperclip.fixture.test")
      .set("Accept", "text/html")
      .set("Sec-Fetch-Site", "same-origin")
      .set("Sec-Fetch-Mode", "navigate")
      .expect(303);
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(1);
    expect(fixture.tokenRequests("authorization_code")[0]!.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(await connectionRow(connected.body.connectionId)).toMatchObject({ status: "active" });
  });

  it("never relays to an address taken from the request", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const publicApp = createRouteApp(db);
    const localhostApp = createRouteApp(db, { actor: "none" });
    const connected = await connect(publicApp, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    const startUrl = connected.body.auth.startUrl as string;
    const state = new URL(startUrl).searchParams.get("state")!;
    const query = { state, code: fixture.issueCode(startUrl), iss: ISSUER };

    // A forged or foreign Host is not relayed at all: the request gets the same
    // refusal an unauthenticated callback got before this change.
    for (const host of ["evil.example", "localhost.evil.example", "evil.example:3100", "paperclip.fixture.test"]) {
      const response = await request(localhostApp).get("/api/tools/oauth/callback").set("Host", host).query(query);
      expect(response.status, host).toBe(403);
      expect(relayedTo(response), host).toBeNull();
    }
    // Neither is a request that came through a proxy naming another host.
    for (const forwardedHost of ["evil.example", "localhost:3100"]) {
      const response = await request(localhostApp)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .set("X-Forwarded-Host", forwardedHost)
        .query(query);
      expect(response.status, forwardedHost).toBe(403);
      expect(relayedTo(response), forwardedHost).toBeNull();
    }
    // Only the exact callback path relays.
    const trailing = await request(localhostApp)
      .get("/api/tools/oauth/callback/")
      .set("Host", `localhost:${SERVER_PORT}`)
      .query(query);
    expect(relayedTo(trailing)).toBeNull();
    expect(trailing.status).toBe(403);

    // A loopback Host that does relay still lands on the configured origin,
    // whatever else the request says.
    const relayed = await request(localhostApp)
      .get("/api/tools/oauth/callback")
      .set("Host", "127.0.0.1:9")
      .set("Origin", "https://evil.example")
      .set("Referer", "https://evil.example/x")
      .query({ ...query, redirect_uri: "https://evil.example", returnTo: "https://evil.example" });
    expect(relayedTo(relayed)!.origin).toBe(PUBLIC_BASE_URL);
    expect(relayed.text).not.toContain("evil.example");

    // With a session, the localhost request is handled in place, not relayed.
    const signedIn = await request(publicApp)
      .get("/api/tools/oauth/callback")
      .set("Host", `localhost:${SERVER_PORT}`)
      .query({ state: "not-a-real-state", code: "x" });
    expect(signedIn.status).toBe(400);
    expect(relayedTo(signedIn)).toBeNull();

    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(1);
  });

  it("does not relay when no usable public address is configured", async () => {
    installFixture();
    const localhostApp = createRouteApp(db, { actor: "none" });
    for (const publicUrl of ["", "http://paperclip.fixture.test", "https://localhost:3100", "https://127.0.0.1"]) {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", publicUrl);
      const response = await request(localhostApp)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .query({ state: "s", code: "c" });
      expect(response.status, publicUrl).toBe(403);
      expect(relayedTo(response), publicUrl).toBeNull();
    }
  });

  it("refuses a forged state on the public address before any exchange", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const publicApp = createRouteApp(db);
    const localhostApp = createRouteApp(db, { actor: "none" });
    const connected = await connect(publicApp, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    const startUrl = connected.body.auth.startUrl as string;
    const realState = new URL(startUrl).searchParams.get("state")!;
    const code = fixture.issueCode(startUrl);

    for (const forged of [
      "forged-state",
      // Shaped like a localhost attempt, but never issued.
      loopbackOAuthState("forged-random", "fixture-client-1", SERVER_PORT)!,
      `${realState}x`,
    ]) {
      // The relay itself decides nothing about the state.
      const relayed = await request(localhostApp)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .query({ state: forged, code });
      const location = relayedTo(relayed)!;
      const response = await request(publicApp)
        .get(`${location.pathname}${location.search}`)
        .set("Host", "paperclip.fixture.test");
      expect(response.status, forged).toBe(400);
      expect(response.body.error).toBe("Invalid or expired OAuth state");
    }
    // Without a session on the public address nothing is looked up either.
    const unauthenticated = await request(localhostApp)
      .get("/api/tools/oauth/callback")
      .set("Host", "paperclip.fixture.test")
      .query({ state: realState, code });
    expect(unauthenticated.status).toBe(403);

    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, realState))).resolves.toHaveLength(1);
  });

  it("exchanges with the address the attempt started with when the switch changes mid-flow", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);

    // Started on localhost, switch turned off before the callback.
    const first = await connect(app, company.id, { oauthSignIn: { loopbackRedirect: true }, name: "Started on" });
    const firstRow = await connectionRow(first.body.connectionId);
    const { loopbackRedirect: _dropped, ...withoutSwitch } = oauthOf(firstRow);
    await db
      .update(toolConnections)
      .set({ config: { ...firstRow.config, oauth: withoutSwitch } })
      .where(eq(toolConnections.id, firstRow.id));
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({
        state: new URL(first.body.auth.startUrl).searchParams.get("state")!,
        code: fixture.issueCode(first.body.auth.startUrl),
        iss: ISSUER,
      })
      .expect(303);
    expect(fixture.tokenRequests("authorization_code").at(-1)!.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(await connectionRow(firstRow.id)).toMatchObject({ status: "active" });

    // Started on the public address, switch turned on before the callback.
    const second = await connect(app, company.id, { name: "Started off" });
    const secondRow = await connectionRow(second.body.connectionId);
    await db
      .update(toolConnections)
      .set({ config: { ...secondRow.config, oauth: { ...oauthOf(secondRow), loopbackRedirect: true } } })
      .where(eq(toolConnections.id, secondRow.id));
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({
        state: new URL(second.body.auth.startUrl).searchParams.get("state")!,
        code: fixture.issueCode(second.body.auth.startUrl),
        iss: ISSUER,
      })
      .expect(303);
    expect(fixture.tokenRequests("authorization_code").at(-1)!.get("redirect_uri")).toBe(PUBLIC_REDIRECT_URI);
    expect(await connectionRow(secondRow.id)).toMatchObject({ status: "active" });
  });

  it("does not send an old code with a client registered by a later start", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const connected = await service.connectGalleryApp(
      company.id,
      { link: MCP_URL, name: "Rebound", oauthSignIn: { loopbackRedirect: true } },
      actor,
    );
    const first = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    expect(new URL(first.authorizationUrl).searchParams.get("client_id")).toBe("fixture-client-1");

    // The client binding moves (here: the stored callback no longer matches),
    // so the next start registers a second client.
    const row = await connectionRow(connected.connectionId);
    await db
      .update(toolConnections)
      .set({ config: { ...row.config, oauth: { ...oauthOf(row), clientRedirectUri: "http://localhost:1/api/tools/oauth/callback" } } })
      .where(eq(toolConnections.id, row.id));
    const second = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    expect(new URL(second.authorizationUrl).searchParams.get("client_id")).toBe("fixture-client-2");

    await expect(service.completeOAuthCallback({
      state: new URL(first.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(first.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_settings_changed" } });
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);

    // The newer attempt is unaffected.
    await service.completeOAuthCallback({
      state: new URL(second.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(second.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    });
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(1);
    expect(fixture.tokenRequests("authorization_code")[0]!.get("client_id")).toBe("fixture-client-2");
  });

  it("saves a replaced refresh token on renewal with the switch on (shared credential)", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);
    const connected = await connect(app, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    const startUrl = connected.body.auth.startUrl as string;
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({ state: new URL(startUrl).searchParams.get("state")!, code: fixture.issueCode(startUrl), iss: ISSUER })
      .expect(303);

    const active = await connectionRow(connected.body.connectionId);
    await db
      .update(toolConnections)
      .set({ config: { ...active.config, oauth: { ...oauthOf(active), expiresAt: "2000-01-01T00:00:00.000Z" } } })
      .where(eq(toolConnections.id, active.id));
    // Renewal runs without any request, so without any callback address.
    const health = await toolAccessService(db).checkHealth(active.id);
    expect(health.connection.healthStatus).toBe("ok");

    const renewals = fixture.tokenRequests("refresh_token");
    expect(renewals).toHaveLength(1);
    expect(renewals[0]!.get("refresh_token")).toBe("fixture-refresh-initial");
    expect(renewals[0]!.has("redirect_uri")).toBe(false);

    const renewed = await connectionRow(active.id);
    expect(oauthOf(renewed)).toMatchObject({ loopbackRedirect: true, requestedScopes: ["mcp:read"], scopes: ["mcp:read"] });
    expect(Date.parse(String(oauthOf(renewed).expiresAt))).toBeGreaterThan(Date.now());
    const refreshRef = renewed.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
    const versions = await db.select().from(companySecretVersions).where(eq(companySecretVersions.secretId, refreshRef.secretId));
    expect(versions.map((version) => version.status).sort()).toEqual(["current", "previous"]);

    // The stored token is the replaced one, not the one the sign-in returned.
    const stored = await secretService(db).resolveSecretValue(company.id, refreshRef.secretId, "latest", {
      consumerType: "tool_connection",
      consumerId: active.id,
      configPath: "oauth.refresh_token",
      actorType: "system",
      actorId: null,
    });
    expect(stored).toBe("fixture-refresh-rotated-1");
  });

  it("saves a replaced refresh token on renewal with the switch on (personal grant)", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);
    const connected = await connect(app, company.id, { oauthSignIn: LOOPBACK_SETTINGS, grantKind: "user" });
    expect(connected.status, JSON.stringify(connected.body)).toBe(201);
    const startUrl = connected.body.auth.startUrl as string;
    expect(new URL(startUrl).searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    await request(app)
      .get("/api/tools/oauth/callback")
      .set("Accept", "text/html")
      .query({ state: new URL(startUrl).searchParams.get("state")!, code: fixture.issueCode(startUrl), iss: ISSUER })
      .expect(303);
    expect(fixture.tokenRequests("authorization_code")[0]!.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);

    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.body.connectionId));
    expect(grant).toMatchObject({ kind: "user", subjectUserId: "board-user", status: "active" });
    const expire = async () => {
      const [current] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
      await db
        .update(connectionGrants)
        .set({
          providerTenant: {
            ...(current!.providerTenant ?? {}),
            oauth: { ...(current!.providerTenant?.oauth ?? {}), accessTokenExpiresAt: "2000-01-01T00:00:00.000Z" },
          },
        })
        .where(eq(connectionGrants.id, grant!.id));
    };
    await expire();
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const health = await toolAccessService(db).checkHealth(connected.body.connectionId, actor);
    expect(health.connection.healthStatus).toBe("ok");

    const renewals = fixture.tokenRequests("refresh_token");
    expect(renewals).toHaveLength(1);
    expect(renewals[0]!.get("refresh_token")).toBe("fixture-refresh-initial");
    expect(renewals[0]!.has("redirect_uri")).toBe(false);
    const [renewed] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grant!.id));
    expect(Date.parse(renewed!.providerTenant?.oauth?.accessTokenExpiresAt ?? "")).toBeGreaterThan(Date.now());
    const versions = await db
      .select()
      .from(companySecretVersions)
      .where(inArray(companySecretVersions.secretId, renewed!.credentialSecretRefs.map((ref) => ref.secretId)));
    expect(versions.filter((version) => version.status === "current")).toHaveLength(2);
    expect(versions.filter((version) => version.status === "previous")).toHaveLength(2);

    await expire();
    await toolAccessService(db).checkHealth(connected.body.connectionId, actor);
    expect(fixture.tokenRequests("refresh_token").at(-1)!.get("refresh_token")).toBe("fixture-refresh-rotated-1");
    expect(oauthOf(await connectionRow(connected.body.connectionId)))
      .toMatchObject({ loopbackRedirect: true, requestedScopes: ["mcp:read"] });
  });

  it("keeps the settings across a reconnect of the same address and clears them only when told to", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);
    const connected = await connect(app, company.id, { oauthSignIn: LOOPBACK_SETTINGS });
    const connectionId = connected.body.connectionId as string;

    // The form sends nothing about the settings: they stay.
    const kept = await connect(app, company.id, { reconnectConnectionId: connectionId });
    expect(kept.status, JSON.stringify(kept.body)).toBe(201);
    expect(kept.body.connectionId).toBe(connectionId);
    expect(new URL(kept.body.auth.startUrl).searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(new URL(kept.body.auth.startUrl).searchParams.get("scope")).toBe("mcp:read");
    expect(oauthOf(await connectionRow(connectionId))).toMatchObject({ loopbackRedirect: true, requestedScopes: ["mcp:read"] });

    // One setting changed, the other untouched.
    const widened = await connect(app, company.id, {
      reconnectConnectionId: connectionId,
      oauthSignIn: { requestedScopes: ["mcp:read", "mcp:write"] },
    });
    expect(new URL(widened.body.auth.startUrl).searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(new URL(widened.body.auth.startUrl).searchParams.get("scope")).toBe("mcp:read mcp:write");

    // Explicitly cleared: back to the public callback and the advertised scopes.
    const cleared = await connect(app, company.id, {
      reconnectConnectionId: connectionId,
      oauthSignIn: { loopbackRedirect: false, requestedScopes: null },
    });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(201);
    expect(new URL(cleared.body.auth.startUrl).searchParams.get("redirect_uri")).toBe(PUBLIC_REDIRECT_URI);
    expect(new URL(cleared.body.auth.startUrl).searchParams.get("scope")).toBe(ADVERTISED_SCOPES.join(" "));
    const row = await connectionRow(connectionId);
    expect(oauthOf(row)).not.toHaveProperty("loopbackRedirect");
    expect(oauthOf(row)).not.toHaveProperty("requestedScopes");
  });

  it("only lets a caller narrow the scope list", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const connected = await service.connectGalleryApp(
      company.id,
      { link: MCP_URL, name: "Scoped", oauthSignIn: { requestedScopes: ["mcp:read", "mcp:write"] } },
      actor,
    );
    const registrationsBefore = fixture.requestsTo("/register").length;
    const statesBefore = (await db.select().from(toolOauthStates)).length;

    for (const scopes of [["mcp:read", "mcp:delete"], ["mcp:delete"], []]) {
      await expect(service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor, scopes }))
        .rejects.toMatchObject({ status: 400, details: { code: "oauth_scope_widening_rejected" } });
    }
    // Refused before any registration call or state.
    expect(fixture.requestsTo("/register")).toHaveLength(registrationsBefore);
    expect(await db.select().from(toolOauthStates)).toHaveLength(statesBefore);

    const narrowed = await service.startOAuth(company.id, connected.connectionId, {
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
      scopes: ["mcp:write"],
    });
    const url = new URL(narrowed.authorizationUrl);
    expect(url.searchParams.get("scope")).toBe("mcp:write");
    // The scope list alone does not move the callback.
    expect(url.searchParams.get("redirect_uri")).toBe(PUBLIC_REDIRECT_URI);
    const [stateRow] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, url.searchParams.get("state")!));
    expect(stateRow!.requestedScopes).toEqual(["mcp:write"]);
  });

  it("does not save a sign-in that was granted more than it asked for", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture({ grantedScope: "mcp:read mcp:write" });
    const company = await createCompany();
    const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Overgranted", oauthSignIn: LOOPBACK_SETTINGS }, actor);
    const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });

    await expect(service.completeOAuthCallback({
      state: new URL(start.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(start.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({
      status: 422,
      details: { code: "oauth_granted_scope_outside_request", scopes: ["mcp:write"] },
    });
    const row = await connectionRow(connected.connectionId);
    expect(row.status).toBe("draft");
    expect(row.credentialSecretRefs).toEqual([]);
    await expect(db.select().from(companySecrets).where(eq(companySecrets.companyId, company.id))).resolves.toHaveLength(0);
  });

  it("does not complete an attempt that started before the scope list was narrowed", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const connected = await service.connectGalleryApp(company.id, { link: MCP_URL, name: "Narrowed later" }, actor);
    // Started with the full advertised set, then the list is set.
    const wide = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    expect(new URL(wide.authorizationUrl).searchParams.get("scope")).toBe(ADVERTISED_SCOPES.join(" "));
    const row = await connectionRow(connected.connectionId);
    await db
      .update(toolConnections)
      .set({ config: { ...row.config, oauth: { ...oauthOf(row), requestedScopes: ["mcp:read"] } } })
      .where(eq(toolConnections.id, row.id));

    await expect(service.completeOAuthCallback({
      state: new URL(wide.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(wide.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_settings_changed" } });
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
  });

  it("refuses the settings on a curated app and when the server does not know its port", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    installFixture();
    const company = await createCompany();
    const app = createRouteApp(db);

    for (const oauthSignIn of [{ loopbackRedirect: true }, { requestedScopes: ["read:jira-work"] }]) {
      const curated = await request(app)
        .post(`/api/companies/${company.id}/tools/apps/connect`)
        .send({ galleryKey: "jira", oauthSignIn });
      expect(curated.status, JSON.stringify(curated.body)).toBe(400);
      expect(curated.body.details).toMatchObject({ code: "oauth_sign_in_settings_unsupported" });
    }
    // Settings that are off are not an error on a curated app.
    const cleared = connectToolAppSchema.safeParse({ galleryKey: "jira", oauthSignIn: { loopbackRedirect: false, requestedScopes: null } });
    expect(cleared.success).toBe(true);
    await expect(db.select().from(toolConnections).where(eq(toolConnections.companyId, company.id))).resolves.toHaveLength(0);

    const portless = createRouteApp(db, { oauthLoopbackPort: null });
    const response = await connect(portless, company.id, { oauthSignIn: { loopbackRedirect: true } });
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.details).toMatchObject({ code: "oauth_loopback_redirect_unavailable" });
    await expect(db.select().from(toolOauthStates)).resolves.toHaveLength(0);
  });

  it("exchanges with the port the attempt started on when another process handles the callback", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const startedOn = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const connected = await startedOn.connectGalleryApp(
      company.id,
      { link: MCP_URL, name: "Two ports", oauthSignIn: { loopbackRedirect: true } },
      actor,
    );
    const first = await startedOn.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    const second = await startedOn.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    expect(new URL(first.authorizationUrl).searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);

    // The same database, a process on another port (a restart or a second
    // instance), and one that does not know its port at all.
    for (const [start, otherPort] of [[first, 4200], [second, null]] as const) {
      const other = toolAccessService(db, { oauthLoopbackPort: otherPort });
      await other.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      });
      const exchange = fixture.tokenRequests("authorization_code").at(-1)!;
      expect(exchange.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
      expect(exchange.get("client_id")).toBe("fixture-client-1");
    }
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(2);
    expect(await connectionRow(connected.connectionId)).toMatchObject({ status: "active" });
  });

  it("refuses a localhost attempt in a format it cannot read and spends it", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    const fixture = installFixture();
    const company = await createCompany();
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const connected = await service.connectGalleryApp(
      company.id,
      { link: MCP_URL, name: "Old format", oauthSignIn: { loopbackRedirect: true } },
      actor,
    );
    const start = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    const state = new URL(start.authorizationUrl).searchParams.get("state")!;
    // The row of an attempt started before the port was part of the state.
    const oldState = `lb1.${state.split(".")[2]}.${state.split(".")[3]}`;
    await db.update(toolOauthStates).set({ state: oldState }).where(eq(toolOauthStates.state, state));

    // Another user cannot spend it: the actor check still comes first.
    await expect(service.completeOAuthCallback({
      state: oldState,
      code: "x",
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor: { actorType: "user", actorId: "someone-else" },
    })).rejects.toMatchObject({ status: 403 });
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, oldState))).resolves.toHaveLength(1);

    await expect(service.completeOAuthCallback({
      state: oldState,
      code: fixture.issueCode(start.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_restart_required" } });
    // Not exchanged with a recomputed address, and not left to be retried.
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
    await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, oldState))).resolves.toHaveLength(0);

    // A fresh sign-in works.
    const fresh = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    await service.completeOAuthCallback({
      state: new URL(fresh.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(fresh.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    });
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(1);
  });

  it("binds a localhost attempt to a client the deployment preconfigured", async () => {
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "preconfigured-client");
    const fixture = installFixture();
    const company = await createCompany();
    const actor = { actorType: "user" as const, actorId: "board-user" };
    const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
    const connected = await service.connectGalleryApp(
      company.id,
      { link: MCP_URL, name: "Preconfigured", oauthSignIn: { loopbackRedirect: true } },
      actor,
    );
    const first = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    const second = await service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
    expect(first.registrationSource).toBe("preconfigured");
    expect(fixture.requestsTo("/register")).toHaveLength(0);
    expect(new URL(first.authorizationUrl).searchParams.get("client_id")).toBe("preconfigured-client");
    expect(new URL(first.authorizationUrl).searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    // Such a client has no callback recorded on the connection; the attempt
    // carries its own.
    expect(oauthOf(await connectionRow(connected.connectionId))).not.toHaveProperty("clientRedirectUri");

    // Completed by a process on another port: same address, same client.
    await toolAccessService(db, { oauthLoopbackPort: 4200 }).completeOAuthCallback({
      state: new URL(first.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(first.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    });
    const exchanges = fixture.tokenRequests("authorization_code");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(exchanges[0]!.get("client_id")).toBe("preconfigured-client");

    // The deployment's client changes while the second attempt is out.
    vi.stubEnv("PAPERCLIP_TOOL_OAUTH_CLIENT_ID", "another-preconfigured-client");
    await expect(service.completeOAuthCallback({
      state: new URL(second.authorizationUrl).searchParams.get("state")!,
      code: fixture.issueCode(second.authorizationUrl),
      iss: ISSUER,
      redirectUri: PUBLIC_REDIRECT_URI,
      actor,
    })).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_settings_changed" } });
    expect(fixture.tokenRequests("authorization_code")).toHaveLength(1);
  });

  describe("settings changed while an OAuth operation is in flight", () => {
    const actor = { actorType: "user" as const, actorId: "board-user" };

    async function setOAuth(connectionId: string, patch: Record<string, unknown>) {
      const row = await connectionRow(connectionId);
      const config = { ...row.config, oauth: { ...oauthOf(row), ...patch } };
      await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, connectionId));
    }

    async function startAttempt(input: { personal: boolean; oauthSignIn: Record<string, unknown> }) {
      const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
      const connected = await service.connectGalleryApp(
        company.id,
        { link: MCP_URL, name: "In flight", oauthSignIn: input.oauthSignIn, ...(input.personal ? { grantKind: "user" as const } : {}) },
        actor,
      );
      const start = await service.startOAuth(company.id, connected.connectionId, {
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
        ...(input.personal ? { subjectUserId: actor.actorId } : {}),
      });
      return { service, connectionId: connected.connectionId, start };
    }

    let company!: Awaited<ReturnType<typeof createCompany>>;

    async function storedCredentialCount(connectionId: string) {
      const row = await connectionRow(connectionId);
      const grants = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connectionId));
      return row.credentialSecretRefs.length + grants.reduce((sum, grant) => sum + grant.credentialSecretRefs.length, 0);
    }

    it.each([
      { path: "shared credential", personal: false },
      { path: "personal grant", personal: true },
    ])("does not let a callback paused at the token exchange accept a grant wider than a list narrowed meanwhile ($path)", async ({ personal }) => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      company = await createCompany();
      const { service, connectionId, start } = await startAttempt({
        personal,
        oauthSignIn: { requestedScopes: ["mcp:read", "mcp:write"] },
      });
      const paused = fixture.pauseNext("exchange");
      const callback = service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      });
      // The callback has read the settings and is waiting on the provider.
      await paused.reached;
      await setOAuth(connectionId, { requestedScopes: ["mcp:read"] });
      paused.release();

      await expect(callback).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_settings_changed" } });
      // The exchange happened, and its wider grant was not stored.
      expect(fixture.tokenRequests("authorization_code")).toHaveLength(1);
      expect(await storedCredentialCount(connectionId)).toBe(0);
      const row = await connectionRow(connectionId);
      expect(row.status).toBe("draft");
      expect(oauthOf(row).requestedScopes).toEqual(["mcp:read"]);
    });

    it.each([
      { path: "shared credential", personal: false },
      { path: "personal grant", personal: true },
    ])("keeps settings saved during the token exchange when the attempt still fits them ($path)", async ({ personal }) => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      company = await createCompany();
      const { service, connectionId, start } = await startAttempt({ personal, oauthSignIn: { requestedScopes: ["mcp:read"] } });
      const paused = fixture.pauseNext("exchange");
      const callback = service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      });
      await paused.reached;
      await setOAuth(connectionId, { requestedScopes: ["mcp:read", "mcp:write"], loopbackRedirect: true });
      paused.release();
      await callback;

      // The callback wrote the config it read before the exchange, except for
      // the settings, which are the ones saved meanwhile.
      const row = await connectionRow(connectionId);
      expect(row.status).toBe("active");
      expect(oauthOf(row)).toMatchObject({ requestedScopes: ["mcp:read", "mcp:write"], loopbackRedirect: true });
      expect(oauthOf(row).connectedAt).toBeTruthy();
      expect(row.transportConfig).toEqual(row.config);
      expect(await storedCredentialCount(connectionId)).toBeGreaterThan(0);
    });

    it("drops settings cleared during the token exchange instead of writing its older copy back", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      company = await createCompany();
      const { service, connectionId, start } = await startAttempt({ personal: false, oauthSignIn: { requestedScopes: ["mcp:read"] } });
      const paused = fixture.pauseNext("exchange");
      const callback = service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      });
      await paused.reached;
      const row = await connectionRow(connectionId);
      const { requestedScopes: _cleared, ...withoutList } = oauthOf(row);
      const config = { ...row.config, oauth: withoutList };
      await db.update(toolConnections).set({ config, transportConfig: config }).where(eq(toolConnections.id, connectionId));
      paused.release();
      await callback;

      const after = await connectionRow(connectionId);
      expect(after.status).toBe("active");
      expect(oauthOf(after)).not.toHaveProperty("requestedScopes");
    });

    it("does not store tokens of a localhost attempt whose client was replaced during the token exchange", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      company = await createCompany();
      const { service, connectionId, start } = await startAttempt({ personal: false, oauthSignIn: { loopbackRedirect: true } });
      const paused = fixture.pauseNext("exchange");
      const callback = service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      });
      await paused.reached;
      await setOAuth(connectionId, { clientId: "client-of-a-later-start" });
      paused.release();

      await expect(callback).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_settings_changed" } });
      expect(await storedCredentialCount(connectionId)).toBe(0);
      expect(oauthOf(await connectionRow(connectionId)).clientId).toBe("client-of-a-later-start");
    });

    it("keeps settings saved while a sign-in start is registering its client", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      company = await createCompany();
      const service = toolAccessService(db, { oauthLoopbackPort: SERVER_PORT });
      // A localhost callback registers its client (the public callback would
      // use the client metadata document and make no registration call).
      const connected = await service.connectGalleryApp(
        company.id,
        { link: MCP_URL, name: "Start in flight", oauthSignIn: { loopbackRedirect: true } },
        actor,
      );
      const paused = fixture.pauseNext("register");
      const starting = service.startOAuth(company.id, connected.connectionId, { redirectUri: PUBLIC_REDIRECT_URI, actor });
      await paused.reached;
      await setOAuth(connected.connectionId, { requestedScopes: ["mcp:read"] });
      paused.release();
      const start = await starting;

      // This start began without a scope list and finishes that way; both of
      // its config writes (registration, then start) leave the new list be.
      expect(new URL(start.authorizationUrl).searchParams.get("scope")).toBe(ADVERTISED_SCOPES.join(" "));
      const row = await connectionRow(connected.connectionId);
      expect(oauthOf(row)).toMatchObject({
        requestedScopes: ["mcp:read"],
        loopbackRedirect: true,
        clientId: "fixture-client-1",
        clientRedirectUri: LOOPBACK_REDIRECT_URI,
      });
      // And its attempt, wider than the list saved meanwhile, cannot complete.
      await expect(service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      })).rejects.toMatchObject({ status: 409, details: { code: "oauth_sign_in_settings_changed" } });
      expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
    });

    it("keeps settings saved while a renewal is in flight and still stores the replaced refresh token", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      company = await createCompany();
      const { service, connectionId, start } = await startAttempt({ personal: false, oauthSignIn: { requestedScopes: ["mcp:read"] } });
      await service.completeOAuthCallback({
        state: new URL(start.authorizationUrl).searchParams.get("state")!,
        code: fixture.issueCode(start.authorizationUrl),
        iss: ISSUER,
        redirectUri: PUBLIC_REDIRECT_URI,
        actor,
      });
      await setOAuth(connectionId, { expiresAt: "2000-01-01T00:00:00.000Z" });

      const paused = fixture.pauseNext("refresh");
      const renewing = service.checkHealth(connectionId);
      await paused.reached;
      await setOAuth(connectionId, { requestedScopes: ["mcp:read", "mcp:write"], loopbackRedirect: true });
      paused.release();
      const health = await renewing;

      expect(health.connection.healthStatus).toBe("ok");
      const row = await connectionRow(connectionId);
      expect(oauthOf(row)).toMatchObject({ requestedScopes: ["mcp:read", "mcp:write"], loopbackRedirect: true });
      expect(oauthOf(row)).not.toHaveProperty("refreshLease");
      expect(Date.parse(String(oauthOf(row).expiresAt))).toBeGreaterThan(Date.now());
      const refreshRef = row.credentialSecretRefs.find((ref) => ref.configPath === "oauth.refresh_token")!;
      const stored = await secretService(db).resolveSecretValue(company.id, refreshRef.secretId, "latest", {
        consumerType: "tool_connection",
        consumerId: connectionId,
        configPath: "oauth.refresh_token",
        actorType: "system",
        actorId: null,
      });
      expect(stored).toBe("fixture-refresh-rotated-1");
    });
  });

  describe("through the real hostname guard, session middleware and board mutation guard", () => {
    const PUBLIC_HOST = "paperclip.fixture.test";
    const SESSION_COOKIE = "paperclip-session=signed-in";

    /**
     * The middleware chain `createApp` mounts in front of the tool routes, in
     * the same order, for an authenticated private deployment. The session
     * resolver stands in for the auth library the way a browser would see it:
     * the session cookie exists for the public host only.
     */
    function createDeployedApp(requestLogger?: express.RequestHandler) {
      const app = express();
      app.use(express.json());
      if (requestLogger) app.use(requestLogger);
      app.use(privateHostnameGuard({ enabled: true, allowedHostnames: [PUBLIC_HOST], bindHost: "127.0.0.1" }));
      app.use(actorMiddleware(db, {
        deploymentMode: "authenticated",
        resolveSession: async (req) => {
          const host = (req.headers.host ?? "").split(":")[0];
          if (host !== PUBLIC_HOST || req.headers.cookie !== SESSION_COOKIE) return null;
          return {
            session: { id: "session-1", userId: "board-user" },
            user: { id: "board-user", name: "Board User", email: "board@fixture.test" },
          };
        },
      }));
      const api = express.Router();
      api.use(boardMutationGuard());
      api.use(toolAccessRoutes(db, {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        oauthLoopbackPort: SERVER_PORT,
        remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
        remoteHttpRequest: async (url, init) => fetch(url, init),
      }));
      app.use("/api", api);
      app.use(errorHandler);
      return app;
    }

    const onPublic = (app: express.Express, method: "get" | "post", path: string) =>
      request(app)[method](path).set("Host", PUBLIC_HOST).set("Cookie", SESSION_COOKIE).set("Origin", PUBLIC_BASE_URL);

    it("relays the session-less localhost callback, then completes on the public address with the session", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      const company = await createCompany();
      const app = createDeployedApp();

      // Start: a real session on the public address, through the mutation guard.
      const connected = await onPublic(app, "post", `/api/companies/${company.id}/tools/apps/connect`)
        .send({ link: MCP_URL, name: "Deployed", grantKind: "user", oauthSignIn: LOOPBACK_SETTINGS });
      expect(connected.status, JSON.stringify(connected.body)).toBe(201);
      const startUrl = connected.body.auth.startUrl as string;
      expect(new URL(startUrl).searchParams.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
      const state = new URL(startUrl).searchParams.get("state")!;
      const code = fixture.issueCode(startUrl);
      const [stateRow] = await db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state));
      expect(stateRow).toMatchObject({ createdByActorId: "board-user", createdBySessionId: "session-1" });

      // The provider sends the browser to localhost. The hostname guard lets
      // localhost through, there is no session for it, and the relay answers.
      const relayed = await request(app)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .set("Accept", "text/html")
        .set("Sec-Fetch-Site", "cross-site")
        .set("Sec-Fetch-Mode", "navigate")
        .query({ state, code, iss: ISSUER });
      const location = relayedTo(relayed)!;
      expect(location.origin + location.pathname).toBe(PUBLIC_REDIRECT_URI);
      expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
      await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(1);
      const relayedPath = `${location.pathname}${location.search}`;

      // The public hop needs the session: without the cookie nothing happens.
      const withoutSession = await request(app).get(relayedPath).set("Host", PUBLIC_HOST).set("Accept", "text/html");
      expect(withoutSession.status).toBe(403);
      expect(relayedTo(withoutSession)).toBeNull();
      expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);

      // With the session: the cross-site interstitial, then the exchange.
      const interstitial = await onPublic(app, "get", relayedPath)
        .set("Accept", "text/html")
        .set("Sec-Fetch-Site", "cross-site")
        .set("Sec-Fetch-Mode", "navigate");
      expect(interstitial.status).toBe(200);
      expect(interstitial.text).toContain("Finishing your connection");
      expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
      const completed = await onPublic(app, "get", relayedPath)
        .set("Accept", "text/html")
        .set("Sec-Fetch-Site", "same-origin")
        .set("Sec-Fetch-Mode", "navigate");
      expect(completed.status, completed.text).toBe(303);
      const exchanges = fixture.tokenRequests("authorization_code");
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]!.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
      expect(await connectionRow(connected.body.connectionId)).toMatchObject({ status: "active" });
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.connectionId, connected.body.connectionId));
      expect(grant).toMatchObject({ kind: "user", subjectUserId: "board-user", status: "active" });
    });

    it("refuses forged hosts and forged states through the same chain", async () => {
      vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE_URL);
      const fixture = installFixture();
      const company = await createCompany();
      const app = createDeployedApp();
      const connected = await onPublic(app, "post", `/api/companies/${company.id}/tools/apps/connect`)
        .send({ link: MCP_URL, name: "Deployed forged", grantKind: "user", oauthSignIn: LOOPBACK_SETTINGS });
      expect(connected.status, JSON.stringify(connected.body)).toBe(201);
      const startUrl = connected.body.auth.startUrl as string;
      const state = new URL(startUrl).searchParams.get("state")!;
      const query = { state, code: fixture.issueCode(startUrl), iss: ISSUER };

      // A host the deployment does not serve never reaches the handler.
      for (const host of ["evil.example", "localhost.evil.example", "evil.example:3100"]) {
        const response = await request(app).get("/api/tools/oauth/callback").set("Host", host).query(query);
        expect(response.status, host).toBe(403);
        expect(relayedTo(response), host).toBeNull();
      }
      // A session cookie sent to localhost is not a session there: still only a relay.
      const cookieOnLocalhost = await request(app)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .set("Cookie", SESSION_COOKIE)
        .query(query);
      expect(relayedTo(cookieOnLocalhost)!.origin).toBe(PUBLIC_BASE_URL);
      // A proxy-forwarded localhost request is not relayed.
      const forwarded = await request(app)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .set("X-Forwarded-Host", "evil.example")
        .query(query);
      expect(relayedTo(forwarded)).toBeNull();
      expect(forwarded.status).toBe(403);

      // A forged state is relayed like any other and refused on the public
      // address, with the session, before any exchange.
      const forgedRelay = await request(app)
        .get("/api/tools/oauth/callback")
        .set("Host", `localhost:${SERVER_PORT}`)
        .query({ ...query, state: loopbackOAuthState("forged", "fixture-client-1", SERVER_PORT)! });
      const forgedLocation = relayedTo(forgedRelay)!;
      const forged = await onPublic(app, "get", `${forgedLocation.pathname}${forgedLocation.search}`);
      expect(forged.status).toBe(400);
      expect(forged.body.error).toBe("Invalid or expired OAuth state");

      expect(fixture.tokenRequests("authorization_code")).toHaveLength(0);
      await expect(db.select().from(toolOauthStates).where(eq(toolOauthStates.state, state))).resolves.toHaveLength(1);
    });
  });
});
