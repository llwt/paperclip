import { z } from "zod";

/**
 * Fork-only (llwt/paperclip, NX-617): per-connection OAuth sign-in settings for
 * a pasted remote MCP URL. Kept in its own file so an upstream merge only meets
 * the few lines that wire it in.
 *
 * - `loopbackRedirect`: sign in through `http://localhost:<server port>` instead
 *   of the configured public address. For authorization servers that refuse the
 *   public address as a callback but accept loopback.
 * - `requestedScopes`: the exact scopes the sign-in asks for. Without it a
 *   generic connection requests every scope the server advertises.
 */

export const OAUTH_SIGN_IN_MAX_SCOPES = 64;
export const OAUTH_SIGN_IN_MAX_SCOPE_LENGTH = 256;

/** RFC 6749 `scope-token`: printable ASCII without space, `"` or `\`. */
const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function isOAuthScopeToken(value: string): boolean {
  return value.length <= OAUTH_SIGN_IN_MAX_SCOPE_LENGTH && OAUTH_SCOPE_TOKEN.test(value);
}

const requestedScopesSchema = z
  .array(z.string().trim().min(1).max(OAUTH_SIGN_IN_MAX_SCOPE_LENGTH).refine(isOAuthScopeToken, {
    message: "A scope cannot contain spaces, quotes, backslashes or control characters",
  }))
  // An empty list would send no `scope` at all and hand the choice back to the
  // provider's default, which is the opposite of what the setting promises.
  .min(1, "List at least one scope, or clear the setting")
  .max(OAUTH_SIGN_IN_MAX_SCOPES)
  .transform((scopes) => [...new Set(scopes)]);

/**
 * Omitted field: keep what the connection has. `false` or `null`: clear it.
 */
export const oauthSignInSettingsInputSchema = z.object({
  loopbackRedirect: z.boolean().optional(),
  requestedScopes: requestedScopesSchema.nullable().optional(),
}).strict();

export type OAuthSignInSettingsInput = z.infer<typeof oauthSignInSettingsInputSchema>;

export type OAuthSignInSettings = {
  loopbackRedirect: boolean;
  requestedScopes: string[] | null;
};

/** Read the settings stored under a connection's `config.oauth`. Absent means off. */
export function readOAuthSignInSettings(oauth: unknown): OAuthSignInSettings {
  const record = oauth && typeof oauth === "object" && !Array.isArray(oauth)
    ? oauth as Record<string, unknown>
    : {};
  const stored = Array.isArray(record.requestedScopes)
    ? [...new Set(record.requestedScopes.filter(
        (scope): scope is string => typeof scope === "string" && isOAuthScopeToken(scope),
      ))]
    : [];
  return {
    loopbackRedirect: record.loopbackRedirect === true,
    requestedScopes: stored.length > 0 ? stored : null,
  };
}

export function oauthSignInSettingsActive(settings: OAuthSignInSettings): boolean {
  return settings.loopbackRedirect || settings.requestedScopes !== null;
}

/** Split what a person typed (spaces, commas or new lines) into scope tokens. */
export function parseOAuthScopeList(text: string): { scopes: string[]; invalid: string[] } {
  const tokens = [...new Set(text.split(/[\s,]+/).map((token) => token.trim()).filter(Boolean))];
  return {
    scopes: tokens.filter(isOAuthScopeToken),
    invalid: tokens.filter((token) => !isOAuthScopeToken(token)),
  };
}
