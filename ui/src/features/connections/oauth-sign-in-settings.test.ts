import { describe, expect, it } from "vitest";
import {
  EMPTY_OAUTH_SIGN_IN_DRAFT,
  oauthSignInDraftError,
  oauthSignInDraftFromConnectionConfig,
  oauthSignInPayload,
} from "./oauth-sign-in-settings";

describe("OAuth sign-in settings form state", () => {
  it("sends nothing while untouched, so a reconnect keeps the stored settings", () => {
    expect(oauthSignInPayload(EMPTY_OAUTH_SIGN_IN_DRAFT)).toEqual({});
    const prefilled = oauthSignInDraftFromConnectionConfig({
      url: "https://mcp.example/mcp",
      oauth: { loopbackRedirect: true, requestedScopes: ["read:me", "offline_access"] },
    });
    expect(prefilled).toEqual({ loopbackRedirect: true, scopesText: "read:me\noffline_access", touched: false });
    expect(oauthSignInPayload(prefilled)).toEqual({});
  });

  it("sends both values once touched", () => {
    expect(oauthSignInPayload({ loopbackRedirect: true, scopesText: "read:me, read:account\nread:me", touched: true }))
      .toEqual({ oauthSignIn: { loopbackRedirect: true, requestedScopes: ["read:me", "read:account"] } });
  });

  it("clears the settings when the switch is off and the list is empty", () => {
    expect(oauthSignInPayload({ loopbackRedirect: false, scopesText: "  \n", touched: true }))
      .toEqual({ oauthSignIn: { loopbackRedirect: false, requestedScopes: null } });
  });

  it("reads a connection without settings as off", () => {
    for (const config of [undefined, null, {}, { oauth: {} }, { oauth: { clientId: "x" } }]) {
      expect(oauthSignInDraftFromConnectionConfig(config)).toEqual(EMPTY_OAUTH_SIGN_IN_DRAFT);
    }
  });

  it("names scopes that cannot be sent", () => {
    expect(oauthSignInDraftError({ loopbackRedirect: false, scopesText: "read:me", touched: true })).toBeNull();
    expect(oauthSignInDraftError({ loopbackRedirect: false, scopesText: 'read:me bad"scope', touched: true }))
      .toBe('Not a valid scope: bad"scope');
  });
});
