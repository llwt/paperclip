// @vitest-environment jsdom

import { act as reactAct } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthSignInSettingsFields } from "./OAuthSignInSettingsFields";
import { EMPTY_OAUTH_SIGN_IN_DRAFT, type OAuthSignInDraft } from "./oauth-sign-in-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("OAuthSignInSettingsFields", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    reactAct(() => root.unmount());
    container.remove();
  });

  function render(draft: OAuthSignInDraft, onChange = vi.fn()) {
    reactAct(() => root.render(<OAuthSignInSettingsFields draft={draft} onChange={onChange} />));
    return onChange;
  }

  it("starts off and marks the draft touched when the switch is turned on", () => {
    const onChange = render(EMPTY_OAUTH_SIGN_IN_DRAFT);
    const checkbox = container.querySelector<HTMLButtonElement>("#generic-mcp-loopback-redirect")!;
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Sign in through localhost");
    reactAct(() => checkbox.click());
    expect(onChange).toHaveBeenCalledWith({ loopbackRedirect: true, scopesText: "", touched: true });
  });

  it("shows stored settings and says how many scopes the next sign-in asks for", () => {
    render({ loopbackRedirect: true, scopesText: "read:me\noffline_access", touched: false });
    expect(container.querySelector("#generic-mcp-loopback-redirect")!.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector<HTMLTextAreaElement>("#generic-mcp-requested-scopes")!.value).toBe("read:me\noffline_access");
    expect(container.textContent).toContain("these 2 scopes only");
  });

  it("names a scope that cannot be sent", () => {
    render({ loopbackRedirect: false, scopesText: 'read:me bad"scope', touched: true });
    expect(container.textContent).toContain('Not a valid scope: bad"scope');
    expect(container.querySelector("#generic-mcp-requested-scopes")!.getAttribute("aria-invalid")).toBe("true");
  });
});
