import { describe, expect, it } from "vitest";
import { runtimeMcpToolNameFormat, savedMcpToolNameFormat } from "./tool-name-format.js";

describe("runtime MCP tool name format", () => {
  const legacy = { name: "paperclip-assigned", url: "https://paperclip.example/mcp/gateways/gw_1", connectionId: "a" };
  const compact = { name: "p", url: "https://paperclip.example/mcp/gateways/gw_1?toolNames=compact-v1", connectionId: "a" };

  it("reads the format from server URLs", () => {
    expect(runtimeMcpToolNameFormat([])).toBe("legacy");
    expect(runtimeMcpToolNameFormat([legacy])).toBe("legacy");
    expect(runtimeMcpToolNameFormat([{ url: "not a url" }, compact])).toBe("compact-v1");
  });

  it("reads the same format back from a saved session identity", () => {
    expect(savedMcpToolNameFormat("")).toBe("legacy");
    expect(savedMcpToolNameFormat("not json")).toBe("legacy");
    expect(savedMcpToolNameFormat(JSON.stringify([legacy]))).toBe("legacy");
    expect(savedMcpToolNameFormat(JSON.stringify([legacy, compact]))).toBe("compact-v1");
  });
});
