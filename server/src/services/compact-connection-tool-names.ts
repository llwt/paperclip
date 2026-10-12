import { createHash } from "node:crypto";

// Fork-only (NX-834): presentation names, never gateway or durable identities.
export const COMPACT_CONNECTION_TOOL_NAME_VERSION = "compact-v1";

interface ConnectionTool {
  name: string;
  providerType: string;
  applicationKey?: string | null;
  connectionId?: string | null;
  upstreamToolName?: string | null;
  providerMetadata?: unknown;
}

function segment(value: string, limit: number, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "").slice(0, limit).replace(/_+$/g, "") || fallback;
}

function clientName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, "_");
}

function isConnectionTool(tool: ConnectionTool): boolean {
  return tool.providerType === "mcp_remote_http" ||
    tool.providerType === "mcp_local_stdio" || tool.providerType === "provider_rest";
}

/** Rebuild from current company-scoped descriptors after authentication.
 * This helper performs no authorization and must not be cached as a grant.
 * Non-connection tools keep their names; legacy names remain resolvable.
 */
export function compactConnectionToolNames<T extends ConnectionTool>(input: {
  companyId: string;
  tools: readonly T[];
  reservedNames?: readonly string[];
  // Injection is for deterministic collision tests; production uses SHA-256.
  digest?: (tuple: string) => string;
}): {
  presentedNames: ReadonlyMap<T, string>;
  toolsByName: ReadonlyMap<string, T>;
} {
  const presentedNames = new Map<T, string>();
  const toolsByName = new Map<string, T>();
  const reserved = new Set([
    ...input.tools.map(tool => clientName(tool.name)),
    ...(input.reservedNames ?? []).map(clientName),
  ]);
  const aliases = new Set<string>();
  const digest = input.digest ?? ((tuple: string) => createHash("sha256").update(tuple).digest("hex"));

  for (const tool of input.tools) {
    if (toolsByName.has(tool.name)) throw new Error("compact_tool_name_collision");
    toolsByName.set(tool.name, tool);
  }
  for (const tool of input.tools) {
    if (!isConnectionTool(tool)) {
      presentedNames.set(tool, tool.name);
      continue;
    }
    const metadata = tool.providerMetadata;
    const catalogName = metadata && typeof metadata === "object" && "catalogName" in metadata
      ? metadata.catalogName : undefined;
    if (!input.companyId || !tool.connectionId || !tool.upstreamToolName ||
      typeof catalogName !== "string" || !catalogName) {
      throw new Error("compact_tool_identity_missing");
    }
    const tuple = JSON.stringify([
      COMPACT_CONNECTION_TOOL_NAME_VERSION, input.companyId, tool.connectionId,
      catalogName, tool.upstreamToolName,
    ]);
    const hash = digest(tuple);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("compact_tool_digest_invalid");
    // Pasted URLs and non-gallery apps use "link", never a URL or display label.
    const gallerySlug = /^app-gallery:([^:]+):/.exec(tool.applicationKey ?? "")?.[1] ?? "link";
    const name = `${segment(gallerySlug, 12, "link")}_${hash.slice(0, 16)}_${segment(tool.upstreamToolName, 40, "tool")}`;
    if (aliases.has(name) || reserved.has(name)) throw new Error("compact_tool_name_collision");
    aliases.add(name);
    presentedNames.set(tool, name);
    toolsByName.set(name, tool);
  }
  return { presentedNames, toolsByName };
}
