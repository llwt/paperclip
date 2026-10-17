import { createHash } from "node:crypto";

// Fork-only (NX-834): presentation names, never gateway or durable identities.
export const COMPACT_CONNECTION_TOOL_NAME_VERSION = "compact-v1";
// Query parameter on the named MCP endpoint. Its value is the format version,
// so the URL (and with it the client session identity) changes with the format.
export const CONNECTION_TOOL_NAMES_QUERY_PARAM = "toolNames";
export const COMPACT_CONNECTION_TOOL_SERVER_LABEL = "p";
// Server kill switch: compact requests get legacy names and aliases stop resolving.
export const COMPACT_CONNECTION_TOOL_NAMES_DISABLED_ENV = "PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED";

export type ConnectionToolNameMode = "legacy" | typeof COMPACT_CONNECTION_TOOL_NAME_VERSION;

export function compactConnectionToolNamesDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[COMPACT_CONNECTION_TOOL_NAMES_DISABLED_ENV]?.trim().toLowerCase();
  return value === "true" || value === "1";
}

/** Absent means legacy; anything other than the known version is rejected. */
export function parseConnectionToolNameMode(value: unknown): ConnectionToolNameMode {
  if (value === undefined) return "legacy";
  if (value === COMPACT_CONNECTION_TOOL_NAME_VERSION) return value;
  throw new Error("unsupported_tool_name_mode");
}

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

export function isCompactConnectionTool(tool: ConnectionTool): boolean {
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
    if (!isCompactConnectionTool(tool)) {
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

/** Project only connection tools; every other name is reserved, so duplicate
 * built-in or chat tool names cannot break or shadow connection aliases.
 */
function projectConnectionTools<T extends ConnectionTool>(input: {
  companyId: string;
  tools: readonly T[];
  reservedNames?: readonly string[];
}) {
  return compactConnectionToolNames({
    companyId: input.companyId,
    tools: input.tools.filter(isCompactConnectionTool),
    reservedNames: [
      ...input.tools.filter(tool => !isCompactConnectionTool(tool)).map(tool => tool.name),
      ...(input.reservedNames ?? []),
    ],
  });
}

export function presentCompactConnectionToolNames<T extends ConnectionTool>(input: {
  companyId: string;
  tools: readonly T[];
  reservedNames?: readonly string[];
}): Array<T & { presentedName: string }> {
  const { presentedNames } = projectConnectionTools(input);
  return input.tools.map(tool => ({ ...tool, presentedName: presentedNames.get(tool) ?? tool.name }));
}

/** Resolve a compact alias against the caller's current descriptors. */
export function resolveCompactConnectionTool<T extends ConnectionTool>(input: {
  companyId: string;
  tools: readonly T[];
  name: string;
  reservedNames?: readonly string[];
}): T | undefined {
  const tool = projectConnectionTools(input).toolsByName.get(input.name);
  // Legacy names resolve through the normal lookup; this only maps aliases.
  return tool && tool.name !== input.name ? tool : undefined;
}

// Per-agent opt-in: `runtimeConfig.connectionToolNames: "compact-v1"`. Only
// Claude runs (direct and ACP engine) read it; other adapters and the native
// runner keep legacy names. Any other value, or the kill switch, means legacy.
export const COMPACT_CONNECTION_TOOL_NAMES_RUNTIME_KEY = "connectionToolNames";

export function connectionToolNameModeForAgent(
  agent: { adapterType: string; runtimeConfig?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): ConnectionToolNameMode {
  if (agent.adapterType !== "claude_local" || compactConnectionToolNamesDisabled(env)) return "legacy";
  const runtimeConfig = agent.runtimeConfig;
  const value = runtimeConfig && typeof runtimeConfig === "object"
    ? (runtimeConfig as Record<string, unknown>)[COMPACT_CONNECTION_TOOL_NAMES_RUNTIME_KEY]
    : undefined;
  return value === COMPACT_CONNECTION_TOOL_NAME_VERSION ? value : "legacy";
}

/** Label `p` plus the versioned URL; both are part of the client session identity. */
export function assignedMcpServerPresentation(baseUrl: string, mode: ConnectionToolNameMode) {
  if (mode !== COMPACT_CONNECTION_TOOL_NAME_VERSION) return { name: "paperclip-assigned", url: baseUrl };
  return {
    name: COMPACT_CONNECTION_TOOL_SERVER_LABEL,
    url: `${baseUrl}?${CONNECTION_TOOL_NAMES_QUERY_PARAM}=${COMPACT_CONNECTION_TOOL_NAME_VERSION}`,
  };
}
