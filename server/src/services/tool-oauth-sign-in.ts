import { createHash } from "node:crypto";
import {
  readOAuthSignInSettings,
  type OAuthSignInSettings,
  type OAuthSignInSettingsInput,
} from "@paperclipai/shared";

/**
 * Fork-only (llwt/paperclip, NX-617): the pure logic behind the per-connection
 * "sign in through localhost" switch and requested-scope list. It lives here so
 * the upstream-owned route and service files only carry the calls into it.
 */

export const OAUTH_CALLBACK_PATH = "/api/tools/oauth/callback";

/**
 * The callback address a localhost sign-in uses. The port is the one this
 * server listens on, taken from its own startup, never from a request.
 */
export function loopbackOAuthRedirectUri(port: number | null | undefined): string | null {
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
}

/**
 * Settings for the next sign-in of a connection: what the form sent, on top of
 * what the same connection (same endpoint) already had. An omitted field keeps
 * the stored value, `false` or `null` clears it.
 */
export function nextOAuthSignInSettings(
  input: OAuthSignInSettingsInput | undefined,
  retainedOAuth: unknown,
): OAuthSignInSettings {
  const retained = readOAuthSignInSettings(retainedOAuth);
  return {
    loopbackRedirect: input?.loopbackRedirect ?? retained.loopbackRedirect,
    requestedScopes: input?.requestedScopes === undefined
      ? retained.requestedScopes
      : input.requestedScopes,
  };
}

/** The `config.oauth` keys that carry the settings. Off means the key is absent. */
export function oauthSignInSettingsConfig(settings: OAuthSignInSettings): Record<string, unknown> {
  return {
    ...(settings.loopbackRedirect ? { loopbackRedirect: true } : {}),
    ...(settings.requestedScopes ? { requestedScopes: [...settings.requestedScopes] } : {}),
  };
}

export type GenericScopeResolution =
  | { ok: true; scopes: string[] | null }
  | { ok: false; reason: "widened"; scopes: string[] }
  | { ok: false; reason: "empty" };

/**
 * Scopes a generic (no gallery definition) sign-in asks for.
 *
 * Without a configured list this is exactly upstream's behavior: the caller's
 * scopes, or `null` so the caller falls back to what discovery advertised. With
 * a list, the list is the request and a caller may only narrow it.
 */
export function resolveGenericOAuthScopes(
  configured: string[] | null,
  requested: string[] | undefined,
): GenericScopeResolution {
  if (!configured) return { ok: true, scopes: requested ?? null };
  if (!requested) return { ok: true, scopes: [...configured] };
  const narrowed = [...new Set(requested.map((scope) => scope.trim()).filter(Boolean))];
  const widened = narrowed.filter((scope) => !configured.includes(scope));
  if (widened.length > 0) return { ok: false, reason: "widened", scopes: widened };
  // No scopes would omit `scope` and let the provider pick its default set.
  if (narrowed.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, scopes: narrowed };
}

/** Scopes a token response granted beyond the ones the sign-in asked for. */
export function oauthScopesOutsideRequest(granted: unknown, requested: string[]): string[] {
  const grantedScopes = typeof granted === "string"
    ? granted.split(/\s+/).filter(Boolean)
    : Array.isArray(granted)
      ? granted.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
      : [];
  return [...new Set(grantedScopes.filter((scope) => !requested.includes(scope)))];
}

/**
 * Does a sign-in that is about to store its credentials still fit the
 * connection as it is now? `latestOauth` is read under a row lock;
 * `startedWithOauth` is what the callback read before the token exchange.
 */
export function recheckOAuthSignIn(input: {
  latestOauth: Record<string, unknown>;
  startedWithOauth: Record<string, unknown>;
  attemptScopes: string[];
  loopbackAttempt: boolean;
  grantedScope: unknown;
}): { kind: "changed" } | { kind: "overgrant"; scopes: string[] } | null {
  const latest = readOAuthSignInSettings(input.latestOauth);
  if (latest.requestedScopes) {
    // An attempt wider than the list as it is now must not complete.
    if (
      input.attemptScopes.length === 0 ||
      input.attemptScopes.some((scope) => !latest.requestedScopes!.includes(scope))
    ) {
      return { kind: "changed" };
    }
    const outside = oauthScopesOutsideRequest(input.grantedScope, input.attemptScopes);
    if (outside.length > 0) return { kind: "overgrant", scopes: outside };
  }
  if (input.loopbackAttempt) {
    // The code was exchanged for the client the callback read. If the stored
    // client moved meanwhile, these tokens belong to a replaced registration.
    const startedWith = input.startedWithOauth.clientId;
    const now = input.latestOauth.clientId;
    if (typeof startedWith === "string" ? startedWith !== now : typeof now === "string") {
      return { kind: "changed" };
    }
  }
  return null;
}

/*
 * A sign-in started with the localhost switch on carries its own snapshot in
 * its `state` value: `lb2.<port>.<client binding>.<random>`. The state is the
 * primary key Paperclip looks the attempt up by, so the callback reads back
 * exactly what the start wrote, per attempt, whatever happened to the
 * connection's settings, its client registration or the server's port in
 * between. Ordinary states are base64url and never contain a dot, so they can
 * never be read as a localhost attempt.
 *
 * The port is the one the start advertised in the authorization request. The
 * callback rebuilds the address from it, so the token request names the same
 * address even when another process, or the same one after a restart on another
 * port, handles the callback. Scheme, host and path are fixed by the format:
 * the state can never name an arbitrary address.
 *
 * This is a snapshot without a database column. A column on `tool_oauth_states`
 * would need a fork migration, and upstream already has later migrations.
 */
const LOOPBACK_STATE_VERSION = "lb2";

function oauthClientBinding(clientId: string): string {
  return createHash("sha256").update(clientId).digest("base64url").slice(0, 22);
}

function canonicalPort(value: string): number | null {
  if (!/^[1-9]\d{0,4}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

/** `null` when the port is not usable: the caller must not start the attempt. */
export function loopbackOAuthState(randomToken: string, clientId: string, port: number): string | null {
  if (!loopbackOAuthRedirectUri(port)) return null;
  return `${LOOPBACK_STATE_VERSION}.${port}.${oauthClientBinding(clientId)}.${randomToken}`;
}

export type LoopbackOAuthAttempt =
  | { kind: "loopback"; port: number; clientBinding: string }
  /**
   * A dotted state this version cannot read (an older `lb1` attempt, which has
   * no port, or a newer format). It must be refused, never treated as an
   * ordinary attempt: that would exchange with a recomputed address.
   */
  | { kind: "unsupported" };

/** `null` for an ordinary attempt. */
export function parseLoopbackOAuthState(state: string): LoopbackOAuthAttempt | null {
  if (!state.includes(".")) return null;
  const parts = state.split(".");
  if (parts.length !== 4 || parts[0] !== LOOPBACK_STATE_VERSION) return { kind: "unsupported" };
  const port = canonicalPort(parts[1]!);
  if (port === null || !parts[2] || !parts[3]) return { kind: "unsupported" };
  return { kind: "loopback", port, clientBinding: parts[2] };
}

export function loopbackOAuthStateMatchesClient(
  attempt: { clientBinding: string },
  clientId: string,
): boolean {
  return attempt.clientBinding === oauthClientBinding(clientId);
}

const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/;
const RELAYED_QUERY_KEYS = ["state", "code", "error", "iss"] as const;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "0.0.0.0"
    || /^127(?:\.\d{1,3}){3}$/.test(host)
    || host === "::1"
    || host === "::"
    || /^::ffff:/.test(host);
}

/**
 * Where to send an OAuth callback that arrived on localhost without a session,
 * or `null` to leave the request alone.
 *
 * The browser that finishes a localhost sign-in reaches this server through a
 * local port forward, where it has no Paperclip session. The session lives on
 * the configured public address, so the callback is repeated there. Nothing is
 * looked up and no code is exchanged on this hop: the public address runs every
 * existing check (session, state, company, subject, PKCE).
 *
 * The target origin comes from configuration only. The `Host` header decides
 * whether to relay, never where to. A forged loopback `Host` therefore gets a
 * redirect to Paperclip's own public callback, which anyone can link to anyway.
 */
export function loopbackOAuthCallbackRelayTarget(input: {
  actorType: string;
  /** Request path without the query, as the client sent it. */
  path: string;
  hostHeader: string | undefined;
  hasForwardedHost: boolean;
  /** Configured public address of this deployment. */
  publicBaseUrl: string | null;
  query: Record<string, unknown>;
}): string | null {
  if (input.actorType !== "none") return null;
  if (input.path !== OAUTH_CALLBACK_PATH) return null;
  if (input.hasForwardedHost) return null;
  const host = LOOPBACK_HOST.exec(input.hostHeader ?? "");
  if (!host) return null;
  if (host[1] !== undefined && (Number(host[1]) < 1 || Number(host[1]) > 65535)) return null;
  if (typeof input.query.state !== "string" || !input.query.state) return null;
  if (!input.publicBaseUrl) return null;
  let target: URL;
  try {
    target = new URL(input.publicBaseUrl);
  } catch {
    return null;
  }
  if (target.protocol !== "https:" || target.username || target.password) return null;
  // A loopback target would send the browser straight back here.
  if (isLoopbackHostname(target.hostname)) return null;
  const relay = new URL(OAUTH_CALLBACK_PATH, target.origin);
  for (const key of RELAYED_QUERY_KEYS) {
    const value = input.query[key];
    if (typeof value === "string") relay.searchParams.set(key, value);
  }
  return relay.toString();
}
