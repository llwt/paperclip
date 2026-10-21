import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

/**
 * Refreshes every query that shows an AI account's status: the AI account
 * list, the tool connection the account page header reads (with its grants),
 * the connection lists and the attention counts. Call after a change that can
 * set or clear the "needs reconnect" marks.
 */
export function invalidateAiConnectionStatus(client: Pick<QueryClient, "invalidateQueries">, companyId: string, connectionId?: string | null) {
  return Promise.all([
    client.invalidateQueries({ queryKey: ["ai-connections", companyId] }),
    ...(connectionId ? [client.invalidateQueries({ queryKey: queryKeys.tools.connection(connectionId) })] : []),
    client.invalidateQueries({ queryKey: queryKeys.tools.connections(companyId) }),
    client.invalidateQueries({ queryKey: queryKeys.tools.applications(companyId) }),
    client.invalidateQueries({ queryKey: queryKeys.apps.attention(companyId) }),
    client.invalidateQueries({ queryKey: queryKeys.attention(companyId) }),
  ]);
}
