import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AiManagedConnectionSummary, ConnectionGrantsResponse, ToolConnection } from "@paperclipai/shared";
import { ManagedAiConnectionDetails } from "@/components/ai-connections/ManagedAiConnectionDetails";

const companyId = "company-storybook";
const currentUserId = "repair-review-user";
const date = new Date("2026-10-21T15:00:00Z");
const account: AiManagedConnectionSummary = {
  id: "repair-review-claude", grantId: "repair-review-grant", companyId,
  provider: "anthropic", method: "subscription", name: "My Claude subscription",
  accountLabel: "alex@example.test", ownership: "personal", ownerUserId: currentUserId, ownerName: "Alex",
  isDefault: true, status: "needs_attention", usageProbeSupported: true, revalidationSupported: true,
  healthMessage: "Sign in again to restore this AI connection.",
};
const connection: ToolConnection = {
  id: account.id, companyId, applicationId: "app-anthropic", name: account.name, uid: account.id,
  connectionKind: "managed", ownership: "customer", connectionPurpose: "ai", transport: "runtime_auth",
  authKind: "oauth", credentialSource: "paperclip_vault", credentialPolicy: "per_user", status: "active", enabled: true,
  transportConfig: {}, config: { ai: { provider: "anthropic", method: "subscription" } }, credentialSecretRefs: [],
  healthStatus: "error", healthCheckedAt: date, healthMessage: account.healthMessage ?? null, lastError: null,
  createdByAgentId: null, createdByUserId: currentUserId, createdAt: date, updatedAt: date,
};
const grants: ConnectionGrantsResponse = {
  connection: { id: account.id, uid: account.id }, currentUserId,
  members: [{ userId: currentUserId, name: "Alex", email: "alex@example.test" }],
  capabilities: {
    canConfigure: true, canCreateOrganizationGrant: true, canSetCompanyInstall: true,
    canConnectAsCurrentUser: true, canManageAgentInstalls: true, canViewOtherPersonalIdentities: true, editableAgentIds: [],
  },
  grants: [{
    id: account.grantId, companyId, connectionId: account.id, kind: "user", subjectUserId: currentUserId,
    providerTenant: { name: account.accountLabel }, credentialSecretRefs: [], status: "needs_reauthorization", isDefault: false,
    createdByAgentId: null, createdByUserId: currentUserId, revokedAt: null, revokedByAgentId: null,
    revokedByUserId: null, lastUsedAt: null, createdAt: date, updatedAt: date, members: [],
    capabilities: { canRevoke: true, canEditAudience: false },
  }],
};

/** Production account details for a marked Claude account; only HTTP responses are fixtures. */
export function AiConnectionRepairReview({ checkResult }: { checkResult: "passed" | "failed" }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } } }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    let current = account;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
      const base = `/api/companies/${companyId}/ai-connections`;
      if (path === base) return Response.json({ currentUserId, canManageConnections: true, connections: [current] });
      if (path === `${base}/${account.id}/active-runs`) return Response.json([]);
      if (path === `/api/tool-connections/${account.id}/grants`) return Response.json(grants);
      if (path === `${base}/${account.id}/revalidate`) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (checkResult === "passed") {
          current = { ...account, status: "connected", healthMessage: undefined };
          return Response.json({ connectionId: account.id, grantId: account.grantId, result: "passed", limited: false, message: "Signed in. Runs can use this account again." });
        }
        current = { ...account, healthMessage: "The provider rejected this credential. Paste a new setup-token or sign in again." };
        return Response.json({ connectionId: account.id, grantId: account.grantId, result: "failed", limited: false, code: "ai_connection_credential_rejected", message: current.healthMessage });
      }
      if (path.startsWith(base)) return Response.json({ error: "This Storybook preview only simulates the repair controls." }, { status: 400 });
      return previous(input, init);
    };
    window.fetch = fixtureFetch;
    setReady(true);
    return () => { if (window.fetch === fixtureFetch) window.fetch = previous; client.clear(); };
  }, [client, checkResult]);
  if (!ready) return <p className="p-6">Loading account details…</p>;
  return <QueryClientProvider client={client}>
    <main className="mx-auto max-w-2xl space-y-4 p-6">
      <section className="space-y-4 rounded-lg border border-border p-4" aria-label={account.name}>
        <h2 className="text-lg font-semibold">{account.name}</h2>
        <ManagedAiConnectionDetails connection={connection} />
      </section>
    </main>
  </QueryClientProvider>;
}
