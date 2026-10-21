// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiManagedConnectionSummary, ConnectionGrant } from "@paperclipai/shared";
import { AiConnectionCheckAgain, AiConnectionSetupTokenPaste } from "./AiConnectionRepair";
import { AiConnectionAccountControls } from "./AiConnectionAccountControls";

const mocks = vi.hoisted(() => ({ reconnectWithSetupToken: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: mocks }));
vi.mock("@/pages/apps/app-detail/IdentitiesSection", () => ({ RevokeGrantDialog: () => null }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const TOKEN = `sk-ant-oat01-${"t".repeat(40)}`;
const account = (overrides: Partial<AiManagedConnectionSummary> = {}): AiManagedConnectionSummary => ({
  id: "connection", grantId: "grant", companyId: "company",
  provider: "anthropic", method: "subscription", name: "My Claude",
  ownership: "personal", ownerUserId: "owner", isDefault: true,
  status: "needs_attention", revalidationSupported: true, ...overrides,
});
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    flushSync(() => {});
  }
}
function render(node: ReactNode) {
  flushSync(() => root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>));
}
function button(label: string) {
  return Array.from(document.querySelectorAll("button")).find(item => item.textContent === label);
}
function click(label: string) {
  const found = button(label);
  expect(found, `Missing button: ${label}`).toBeDefined();
  flushSync(() => found!.click());
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  flushSync(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
});
afterEach(() => { flushSync(() => root.unmount()); container.remove(); });

it("saves a pasted setup-token from a password field and clears it", async () => {
  const onComplete = vi.fn();
  mocks.reconnectWithSetupToken.mockResolvedValue({ connectionId: "connection", grantId: "grant" });
  render(<AiConnectionSetupTokenPaste companyId="company" connectionId="connection" onComplete={onComplete} />);
  expect(document.querySelector("input")).toBeNull();
  click("Paste a setup-token");
  const input = document.querySelector("input")!;
  expect(input.type).toBe("password");
  expect(input.autocomplete).toBe("off");
  expect(button("Save token")!.disabled).toBe(true);
  type(input, ` ${TOKEN} `);
  click("Save token");
  await settle();
  expect(mocks.reconnectWithSetupToken).toHaveBeenCalledWith("company", "connection", TOKEN);
  expect(onComplete).toHaveBeenCalledWith({ connectionId: "connection", grantId: "grant" });
  expect(document.querySelector("input")?.value ?? "").toBe("");
});

it("shows why a pasted token was refused and keeps the field open", async () => {
  mocks.reconnectWithSetupToken.mockRejectedValue(new Error("The provider rejected this credential."));
  render(<AiConnectionSetupTokenPaste companyId="company" connectionId="connection" onComplete={vi.fn()} />);
  click("Paste a setup-token");
  type(document.querySelector("input")!, TOKEN);
  click("Save token");
  await settle();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("rejected");
  expect(document.querySelector("input")!.value).toBe("");
});

it("checks the saved credential again in one click and shows the result", async () => {
  mocks.revalidate.mockResolvedValueOnce({ connectionId: "connection", grantId: "grant", result: "failed", limited: false, code: "ai_connection_credential_rejected", message: "The provider rejected this credential." });
  mocks.revalidate.mockResolvedValueOnce({ connectionId: "connection", grantId: "grant", result: "passed", limited: true, message: "Signed in. The account is at its usage limit for now." });
  render(<AiConnectionCheckAgain account={account()} />);
  click("Check again");
  await settle();
  expect(mocks.revalidate).toHaveBeenCalledWith("company", "connection", "grant");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("rejected");
  click("Check again");
  await settle();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("usage limit");
});

it("offers Check again next to Reconnect only for an account that needs reconnect and has a check", () => {
  const grant = { id: "grant", capabilities: { canRevoke: true } } as unknown as ConnectionGrant;
  const controls = (summary: AiManagedConnectionSummary) => <AiConnectionAccountControls account={summary} grant={grant} currentUserId="owner"
    onMakeDefault={vi.fn()} onReconnect={vi.fn()} onRevoke={vi.fn()} />;
  render(controls(account({ healthMessage: "The provider rejected this credential." })));
  expect(button("Check again")).toBeDefined();
  expect(button("Reconnect")).toBeDefined();
  expect(container.textContent).toContain("The provider rejected this credential.");
  render(controls(account({ status: "connected" })));
  expect(button("Check again")).toBeUndefined();
  render(controls(account({ provider: "openai", revalidationSupported: false })));
  expect(button("Check again")).toBeUndefined();
});
