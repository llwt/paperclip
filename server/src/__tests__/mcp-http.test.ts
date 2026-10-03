import { describe, expect, it } from "vitest";
import {
  initializeMcpHttpSession,
  MCP_HTTP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  mcpHttpRequestHeaders,
  parseMcpHttpResponseBody,
  readMcpHttpResponse,
  McpHttpResponseError,
} from "../services/mcp-http.js";

describe("mcpHttpRequestHeaders", () => {
  it("advertises both JSON and SSE on every request", () => {
    expect(mcpHttpRequestHeaders()).toMatchObject({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    });
    expect(MCP_HTTP_ACCEPT).toBe("application/json, text/event-stream");
  });

  it("preserves caller-supplied headers while keeping the required Accept value", () => {
    expect(mcpHttpRequestHeaders({ Authorization: "Bearer x", accept: "application/json" })).toMatchObject({
      accept: "application/json, text/event-stream",
      Authorization: "Bearer x",
    });
  });
});

describe("initializeMcpHttpSession", () => {
  it("returns the negotiated protocol and ephemeral session headers", async () => {
    const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
    const sessionHeaders = await initializeMcpHttpSession({
      requestId: "test-request",
      headers: { Authorization: "Bearer token" },
      send: async (init) => {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ headers: new Headers(init.headers), payload });
        if (payload.method === "initialize") {
          return new Response(JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: { name: "stateful-test", version: "1" },
            },
          }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-123" },
          });
        }
        return new Response(null, { status: 202 });
      },
    });

    expect(requests.map(({ payload }) => payload.method)).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    expect(requests[1]!.headers.get("authorization")).toBe("Bearer token");
    expect(requests[1]!.headers.get("mcp-session-id")).toBe("session-123");
    expect(requests[1]!.headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(sessionHeaders).toMatchObject({
      Authorization: "Bearer token",
      "Mcp-Session-Id": "session-123",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    });
  });
});

describe("parseMcpHttpResponseBody", () => {
  it("parses a plain application/json body", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [] } };
    expect(parseMcpHttpResponseBody(JSON.stringify(payload), "application/json")).toEqual(payload);
  });

  it("parses an SSE-framed body, extracting the JSON-RPC message", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { tools: [{ name: "kv_get" }] } };
    const body = `event: message\ndata: ${JSON.stringify(payload)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream; charset=utf-8")).toEqual(payload);
  });

  it("skips non-JSON-RPC SSE events and returns the response message", () => {
    const ping = "event: ping\ndata: {\"type\":\"ping\"}";
    const message = { jsonrpc: "2.0", id: "1", result: { ok: true } };
    const body = `${ping}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(message);
  });

  it("handles multi-line SSE data fields", () => {
    const payload = { jsonrpc: "2.0", id: "1", result: { note: "line" } };
    const json = JSON.stringify(payload, null, 2);
    const body = `data: ${json.split("\n").join("\ndata: ")}\n\n`;
    expect(parseMcpHttpResponseBody(body, "text/event-stream")).toEqual(payload);
  });

  it("throws when an SSE stream carries no data events", () => {
    expect(() => parseMcpHttpResponseBody("event: ping\n\n", "text/event-stream")).toThrow();
  });
});

describe("readMcpHttpResponse", () => {
  const sse = (...messages: unknown[]) =>
    new Response(messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "t", progress: 1 } };
  const logging = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "private text" } };
  const result = { jsonrpc: "2.0", id: "req-1", result: { content: [{ type: "text", text: "ok" }] } };

  it("returns a plain application/json response for the request", async () => {
    const response = new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    await expect(readMcpHttpResponse(response, "req-1")).resolves.toEqual(result);
  });

  it("returns the response from a single-event stream", async () => {
    await expect(readMcpHttpResponse(sse(result), "req-1")).resolves.toEqual(result);
  });

  it("skips notifications and responses for other IDs before the result", async () => {
    const other = { jsonrpc: "2.0", id: "req-0", result: { content: [] } };
    await expect(readMcpHttpResponse(sse(progress, logging, other, result), "req-1")).resolves.toEqual(result);
  });

  it("returns a JSON-RPC error response for the request", async () => {
    const error = { jsonrpc: "2.0", id: "req-1", error: { code: -32602, message: "bad" } };
    await expect(readMcpHttpResponse(sse(progress, error), "req-1")).resolves.toEqual(error);
  });

  it("hands server requests to onRequest and keeps reading", async () => {
    const request = { jsonrpc: "2.0", id: "srv-1", method: "elicitation/create", params: { message: "?" } };
    const seen: unknown[] = [];
    await expect(readMcpHttpResponse(sse(progress, request, result), "req-1", {
      onRequest: async (message) => { seen.push(message); },
    })).resolves.toEqual(result);
    expect(seen).toEqual([request]);
  });

  it("fails with a content-free summary when the stream has only notifications", async () => {
    const error = await readMcpHttpResponse(sse(progress, logging, progress), "req-1").catch((caught) => caught);
    expect(error).toBeInstanceOf(McpHttpResponseError);
    expect(error.reason).toBe("malformed_response");
    expect(error.summary).toEqual({
      eventCount: 3,
      methods: ["notifications/progress", "notifications/message"],
      sawId: false,
      sawResponse: false,
    });
    expect(JSON.stringify(error.summary)).not.toContain("private text");
  });

  it("reports a response that carries a different ID", async () => {
    const error = await readMcpHttpResponse(sse({ jsonrpc: "2.0", id: 7, result: {} }), "req-1").catch((caught) => caught);
    expect(error.reason).toBe("malformed_response");
    expect(error.summary).toEqual({ eventCount: 1, methods: [], sawId: true, sawResponse: true });
  });

  it("rejects a data event that is not JSON", async () => {
    const response = new Response("data: not json\n\n", { headers: { "content-type": "text/event-stream" } });
    await expect(readMcpHttpResponse(response, "req-1")).rejects.toMatchObject({ reason: "invalid_json" });
  });
});
