// Fork-only (NX-834): Claude resumes across MCP server changes, but a saved
// conversation holds the tool names it was given. When the connection tool
// name format changes (the `toolNames` URL parameter), those names no longer
// exist, so the session must start fresh instead.
function formatOf(servers: unknown): string {
  if (!Array.isArray(servers)) return "legacy";
  for (const server of servers) {
    const url = server && typeof server === "object" ? (server as { url?: unknown }).url : undefined;
    if (typeof url !== "string") continue;
    try {
      const format = new URL(url).searchParams.get("toolNames");
      if (format) return format;
    } catch {
      // Not a URL; it cannot carry a format.
    }
  }
  return "legacy";
}

export function runtimeMcpToolNameFormat(servers: ReadonlyArray<{ url: string }>): string {
  return formatOf(servers);
}

/** Read the format from a saved `mcpServerIdentity` (JSON of name, url, connectionId). */
export function savedMcpToolNameFormat(identity: string): string {
  if (!identity) return "legacy";
  try {
    return formatOf(JSON.parse(identity));
  } catch {
    return "legacy";
  }
}
