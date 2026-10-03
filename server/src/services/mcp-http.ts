// Helpers for talking to remote MCP servers over the Streamable HTTP transport.
//
// The MCP Streamable HTTP spec requires the client to advertise that it accepts
// BOTH a single JSON response and an SSE stream on every POST:
//
//   Accept: application/json, text/event-stream
//
// Spec-compliant servers reject requests missing this header with 406 Not
// Acceptable, and when the header is present they are free to answer with an
// SSE stream (`event: message\ndata: {…}`) instead of a bare JSON body. So any
// code path that POSTs JSON-RPC to a remote `/mcp` endpoint must (a) send the
// Accept header and (b) be able to read an SSE-framed response.

/** The Accept header value required by the MCP Streamable HTTP transport. */
export const MCP_HTTP_ACCEPT = "application/json, text/event-stream";
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Content-free description of the messages seen while looking for a response.
 * Carries counts, JSON-RPC method names and flags only: never params, results,
 * error bodies or message IDs.
 */
/** Shape of a response stream that had no message for the request. It must
 * stay free of server-supplied text: counts, flags and fixed labels only. */
export type McpHttpResponseSummary = {
  eventCount: number;
  /** Non-JSON SSE `data:` events that were skipped. */
  skippedEventCount: number;
  /** Message count per label. Keys come from KNOWN_MCP_METHOD_LABELS or are
   * "other"; a method name sent by the server is never copied here. */
  methods: Record<string, number>;
  sawId: boolean;
  sawResponse: boolean;
};

// Methods a server may send on a response stream (MCP 2025-06-18). Matched
// exactly: a name that only starts like one of these is counted as "other".
const KNOWN_MCP_METHOD_LABELS: ReadonlySet<string> = new Set([
  "notifications/progress",
  "notifications/message",
  "notifications/cancelled",
  "notifications/tools/list_changed",
  "notifications/resources/list_changed",
  "notifications/resources/updated",
  "notifications/prompts/list_changed",
  "notifications/roots/list_changed",
  "elicitation/create",
  "sampling/createMessage",
  "roots/list",
  "ping",
]);
const OTHER_MCP_METHOD_LABEL = "other";

export class McpHttpResponseError extends Error {
  constructor(
    readonly reason: "invalid_json" | "malformed_response" | "too_large",
    message: string,
    readonly summary?: McpHttpResponseSummary,
  ) {
    super(message);
    this.name = "McpHttpResponseError";
  }
}

/**
 * Default headers for an MCP Streamable HTTP JSON-RPC POST. Caller-supplied
 * headers (e.g. resolved credentials) are preserved, while the required
 * Streamable HTTP Accept value is kept authoritative.
 */
export function mcpHttpRequestHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    ...extra,
    accept: MCP_HTTP_ACCEPT,
  };
}

export class McpHttpInitializationError extends Error {
  constructor(
    message: string,
    readonly stage: "initialize" | "initialized_notification",
    readonly status: number | null,
  ) {
    super(message);
    this.name = "McpHttpInitializationError";
  }
}

/**
 * Establish the short-lived Streamable HTTP session needed by stateful MCP
 * servers. The returned headers belong only to the caller's next request; no
 * session id is persisted with the connection or shared across operations.
 */
export async function initializeMcpHttpSession(input: {
  send: (init: RequestInit) => Promise<Response>;
  headers?: Record<string, string>;
  requestId: string;
}): Promise<Record<string, string>> {
  const initializeResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(input.headers),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${input.requestId}-initialize`,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paperclip", version: "1" },
      },
    }),
  });
  if (!initializeResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialization returned HTTP ${initializeResponse.status}`,
      "initialize",
      initializeResponse.status,
    );
  }
  let payload: unknown;
  try {
    payload = parseMcpHttpResponseBody(
      await initializeResponse.text(),
      initializeResponse.headers.get("content-type"),
    );
  } catch {
    throw new McpHttpInitializationError("Remote MCP initialization returned an invalid response", "initialize", null);
  }
  const result = payload && typeof payload === "object" && "result" in payload
    ? (payload as { result?: unknown }).result
    : null;
  const resultRecord = result && typeof result === "object" ? result as Record<string, unknown> : null;
  const protocolVersion = typeof resultRecord?.protocolVersion === "string" && resultRecord.protocolVersion
    ? resultRecord.protocolVersion
    : MCP_PROTOCOL_VERSION;
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  const sessionHeaders: Record<string, string> = {
    ...(input.headers ?? {}),
    "MCP-Protocol-Version": protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const initializedResponse = await input.send({
    method: "POST",
    headers: mcpHttpRequestHeaders(sessionHeaders),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }),
  });
  if (!initializedResponse.ok) {
    throw new McpHttpInitializationError(
      `Remote MCP initialized notification returned HTTP ${initializedResponse.status}`,
      "initialized_notification",
      initializedResponse.status,
    );
  }
  return sessionHeaders;
}

function looksLikeJsonRpcMessage(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return "result" in record || "error" in record || "method" in record || "id" in record;
}

/**
 * Parse the body of an MCP Streamable HTTP response into its JSON-RPC payload.
 *
 * Handles both response shapes the transport allows:
 *  - `application/json`: the body is the JSON-RPC message directly.
 *  - `text/event-stream`: one or more SSE events; we return the JSON payload of
 *    the first `data:` event that parses as a JSON-RPC message.
 *
 * Falls back to a plain JSON parse when the content type is unknown so we stay
 * compatible with non-compliant servers that ignore the Accept header.
 */
export function parseMcpHttpResponseBody(bodyText: string, contentType: string | null): unknown {
  const isEventStream = (contentType ?? "").toLowerCase().includes("text/event-stream");
  if (!isEventStream) {
    return JSON.parse(bodyText) as unknown;
  }

  // Split the SSE stream into events on blank lines, then collect each event's
  // `data:` lines (which may span multiple lines per the SSE spec).
  const events = bodyText.replace(/\r\n/g, "\n").split(/\n\n+/);
  let lastError: unknown = null;
  let firstParsed: unknown;
  let sawData = false;
  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""));
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!sawData) {
      firstParsed = parsed;
      sawData = true;
    }
    if (looksLikeJsonRpcMessage(parsed)) {
      return parsed;
    }
  }
  if (sawData) return firstParsed;
  if (lastError) throw lastError;
  throw new SyntaxError("MCP SSE response contained no data events");
}

/** Read until the response for this request arrives, without waiting for an SSE
 * connection to close. Notifications and responses for other IDs are ignored. */
export async function readMcpHttpResponse(
  response: Response,
  requestId: string | number,
  options: { maxBytes?: number; onRequest?: (message: Record<string, unknown>) => Promise<void> } = {},
): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const isStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
  const reader = response.body?.getReader();
  // Injected HTTP transports can expose a buffered text response rather than a
  // Web ReadableStream. Keep the same size and message-ID checks for both forms.
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxBytes) throw new McpHttpResponseError("too_large", "MCP response exceeded the size limit");
    return readMcpHttpResponse(new Response(body, {
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    }), requestId, options);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const summary: McpHttpResponseSummary = { eventCount: 0, skippedEventCount: 0, methods: {}, sawId: false, sawResponse: false };
  const parse = (text: string): unknown => {
    try { return JSON.parse(text); }
    catch { throw new McpHttpResponseError("invalid_json", "MCP response contained invalid JSON"); }
  };
  const inspect = async (message: unknown): Promise<unknown | undefined> => {
    summary.eventCount += 1;
    if (!message || typeof message !== "object") return undefined;
    const record = message as Record<string, unknown>;
    if (record.id === requestId && ("result" in record || "error" in record)) return record;
    if ("id" in record) summary.sawId = true;
    if ("result" in record || "error" in record) summary.sawResponse = true;
    if ("method" in record) {
      const label = typeof record.method === "string" && KNOWN_MCP_METHOD_LABELS.has(record.method)
        ? record.method
        : OTHER_MCP_METHOD_LABEL;
      summary.methods[label] = (summary.methods[label] ?? 0) + 1;
    }
    if ("method" in record && "id" in record) await options.onRequest?.(record);
    return undefined;
  };
  const event = async (value: string) => {
    const data = value.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) return undefined;
    // Differs from upstream v2026.1001.0, which fails the whole call on a
    // non-JSON event. Skip it and keep reading, as parseMcpHttpResponseBody
    // does, so a stray keep-alive or comment-like event before the result does
    // not fail the call (and, in the gateway, mark the connection errored).
    // Keep this when porting to a newer base.
    let message: unknown;
    try { message = JSON.parse(data); }
    catch {
      summary.skippedEventCount += 1;
      return undefined;
    }
    return inspect(message);
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > maxBytes) throw new McpHttpResponseError("too_large", "MCP response exceeded the size limit");
      buffer += decoder.decode(value, { stream: !done });
      if (isStream) {
        // Normalize CRLF after concatenating chunks, including split CR/LF pairs.
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const result = await event(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
          if (result !== undefined) return result;
        }
      }
      if (done) break;
    }
    const result = isStream ? await event(buffer) : await inspect(parse(buffer));
    if (result !== undefined) return result;
    throw new McpHttpResponseError("malformed_response", "MCP response did not contain the requested message ID", summary);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
