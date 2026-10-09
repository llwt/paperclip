import {
  parseOAuthScopeList,
  readOAuthSignInSettings,
  type OAuthSignInSettingsInput,
} from "@paperclipai/shared";

/**
 * Fork-only (llwt/paperclip, NX-617): form state for the per-connection
 * "sign in through localhost" switch and scope list of a pasted MCP URL.
 */
export type OAuthSignInDraft = {
  loopbackRedirect: boolean;
  scopesText: string;
  /** False until the person changes a field: an untouched form sends nothing. */
  touched: boolean;
};

export const EMPTY_OAUTH_SIGN_IN_DRAFT: OAuthSignInDraft = {
  loopbackRedirect: false,
  scopesText: "",
  touched: false,
};

/** Show what a connection already has when it is opened for reconnect. */
export function oauthSignInDraftFromConnectionConfig(config: unknown): OAuthSignInDraft {
  const oauth = config && typeof config === "object" ? (config as Record<string, unknown>).oauth : null;
  const settings = readOAuthSignInSettings(oauth);
  return {
    loopbackRedirect: settings.loopbackRedirect,
    scopesText: (settings.requestedScopes ?? []).join("\n"),
    touched: false,
  };
}

export function oauthSignInDraftError(draft: OAuthSignInDraft): string | null {
  const { invalid } = parseOAuthScopeList(draft.scopesText);
  if (invalid.length === 0) return null;
  return `Not a valid scope: ${invalid.join(", ")}`;
}

/**
 * What the connect request carries. Nothing while untouched, so the server
 * keeps what the connection has. Once touched, both values are sent as they
 * stand: an unchecked switch and an empty list clear the settings.
 */
export function oauthSignInPayload(draft: OAuthSignInDraft): { oauthSignIn?: OAuthSignInSettingsInput } {
  if (!draft.touched) return {};
  const { scopes } = parseOAuthScopeList(draft.scopesText);
  return {
    oauthSignIn: {
      loopbackRedirect: draft.loopbackRedirect,
      requestedScopes: scopes.length > 0 ? scopes : null,
    },
  };
}
