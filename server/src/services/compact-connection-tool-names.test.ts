import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assignedMcpServerPresentation,
  compactConnectionToolNames,
  compactConnectionToolNamesDisabled,
  connectionToolNameModeForAgent,
  parseConnectionToolNameMode,
  presentCompactConnectionToolNames,
  resolveCompactConnectionTool,
} from "./compact-connection-tool-names.js";

function tool(overrides: Record<string, unknown> = {}) {
  return {
    name: "mcp.app-gallery-linear-uuid-12345678:search",
    providerType: "mcp_remote_http",
    applicationKey: "app-gallery:linear:application-uuid",
    connectionId: "connection-a",
    upstreamToolName: "Search.Issues",
    providerMetadata: { catalogName: "tools/Search.Issues" },
    parametersSchema: { type: "object", properties: { query: { type: "string" } } },
    ...overrides,
  };
}

function project(tools: ReturnType<typeof tool>[], extra = {}) {
  return compactConnectionToolNames({ companyId: "company-a", tools, ...extra });
}

describe("compact connection tool presentation", () => {
  it("hashes the versioned raw tuple and resolves both names to the original descriptor", () => {
    const original = tool();
    const snapshot = structuredClone(original);
    const result = project([original]);
    const hash = createHash("sha256").update(JSON.stringify([
      "compact-v1", "company-a", "connection-a", "tools/Search.Issues", "Search.Issues",
    ])).digest("hex").slice(0, 16);
    const alias = `linear_${hash}_search_issues`;
    expect(result.presentedNames.get(original)).toBe(alias);
    expect(result.toolsByName.get(alias)).toBe(original);
    expect(result.toolsByName.get(original.name)).toBe(original);
    expect(result.toolsByName.get("unknown")).toBeUndefined();
    expect(original).toEqual(snapshot);
  });

  it("distinguishes two connections of the same app with identical methods", () => {
    const a = tool();
    const b = tool({ name: "legacy-b", connectionId: "connection-b" });
    const result = project([a, b]);
    expect(result.presentedNames.get(a)).not.toBe(result.presentedNames.get(b));
    expect(result.toolsByName.size).toBe(4);
  });

  it.each([
    ["search.issues", "search-issues"],
    ["SearchIssues", "searchissues"],
    ["a".repeat(40) + "first", "a".repeat(40) + "second"],
    ["搜索", "検索"],
  ])("keeps raw operation identities distinct when %s and %s sanitize equally", (first, second) => {
    const a = tool({ upstreamToolName: first });
    const b = tool({ name: "legacy-b", upstreamToolName: second });
    const result = project([a, b]);
    expect(result.presentedNames.get(a)).not.toBe(result.presentedNames.get(b));
    expect(result.presentedNames.get(a)?.split("_").slice(2).join("_")).toBe(
      result.presentedNames.get(b)?.split("_").slice(2).join("_"),
    );
  });

  it("includes catalog names and company scope in identity", () => {
    const a = tool();
    const b = tool({ name: "legacy-b", providerMetadata: { catalogName: "other/Search.Issues" } });
    const result = project([a, b]);
    expect(result.presentedNames.get(a)).not.toBe(result.presentedNames.get(b));
    const otherCompany = compactConnectionToolNames({ companyId: "company-b", tools: [a] });
    expect(result.presentedNames.get(a)).not.toBe(otherCompany.presentedNames.get(a));
  });

  it.each([
    ["app.with.punctuation", "app-with-punctuation"],
    ["SomeApp", "someapp"],
    ["a".repeat(12) + "first", "a".repeat(12) + "second"],
  ])("distinguishes apps whose readable segments collide (%s, %s)", (first, second) => {
    const a = tool({ applicationKey: `app-gallery:${first}:uuid` });
    const b = tool({ name: "legacy-b", applicationKey: `app-gallery:${second}:uuid`, connectionId: "connection-b" });
    const result = project([a, b]);
    expect(result.presentedNames.get(a)?.split(/_[a-f0-9]{16}_/)[0]).toEqual(
      result.presentedNames.get(b)?.split(/_[a-f0-9]{16}_/)[0],
    );
    expect(result.presentedNames.get(a)).not.toBe(result.presentedNames.get(b));
  });

  it("uses unambiguous tuple encoding", () => {
    const a = tool({ connectionId: "a:b", providerMetadata: { catalogName: "c" } });
    const b = tool({ name: "legacy-b", connectionId: "a", providerMetadata: { catalogName: "b:c" } });
    const result = project([a, b]);
    expect(result.presentedNames.get(a)).not.toBe(result.presentedNames.get(b));
  });

  it.each([null, "app-gallery:link:uuid", "custom:app", "https://private.example/mcp", "app-gallery:搜索:uuid"])(
    "uses the generic link segment for arbitrary or non-ASCII apps (%s)", applicationKey => {
      const original = tool({ applicationKey });
      expect(project([original]).presentedNames.get(original)).toMatch(/^link_[a-f0-9]{16}_search_issues$/);
    },
  );

  it("is stable across ordering, rediscovery and mutable labels or catalog entry IDs", () => {
    const a = tool();
    const b = tool({ name: "legacy-b", connectionId: "connection-b" });
    const before = project([a, b]);
    const after = project([b, a]);
    expect([...before.presentedNames]).toEqual([...after.presentedNames].reverse());
    const rediscovered = tool({ name: "legacy-renamed", applicationKey: "app-gallery:linear:another-uuid",
      catalogEntryId: "new-catalog-id", displayName: "Changed title" });
    expect(project([rediscovered]).presentedNames.get(rediscovered)).toBe(before.presentedNames.get(a));
  });

  it("bounds ASCII app and operation segments, including the Claude wrapper and a label suffix", () => {
    const original = tool({ applicationKey: `app-gallery:${"Z".repeat(30)}:uuid`, upstreamToolName: "X".repeat(100) });
    const name = project([original]).presentedNames.get(original)!;
    expect(name).toMatch(/^[a-z0-9_]+$/);
    expect(`mcp__p__${name}`).toHaveLength(78);
    // Claude config appends the first eight connection-ID characters and a counter.
    expect(`mcp__p_12345678_2__${name}`).toHaveLength(89);
    expect(`mcp__p_12345678_2__${name}`.length).toBeLessThanOrEqual(128);
  });

  it("keeps built-in, virtual and plugin definitions unchanged", () => {
    const originals = ["paperclip_self", "paperclip_virtual", "paperclip_plugin"].map(providerType =>
      tool({ providerType, name: providerType, providerMetadata: undefined }),
    );
    const result = project(originals);
    for (const original of originals) {
      expect(result.presentedNames.get(original)).toBe(original.name);
      expect(result.toolsByName.get(original.name)).toBe(original);
    }
  });

  it("rejects forced digest collisions before returning a catalog", () => {
    const a = tool({ upstreamToolName: "search.issues" });
    const b = tool({ name: "legacy-b", upstreamToolName: "search-issues" });
    expect(() => project([a, b], { digest: () => "a".repeat(64) })).toThrow("compact_tool_name_collision");
  });

  it("rejects reserved aliases, including punctuation normalized by the client", () => {
    const original = tool();
    const alias = project([original]).presentedNames.get(original)!;
    expect(() => project([original], { reservedNames: [alias] })).toThrow("compact_tool_name_collision");
    const builtin = tool({ name: alias.replace(/_/g, "."), providerType: "paperclip_self" });
    expect(() => project([original, builtin])).toThrow("compact_tool_name_collision");
  });

  it("rejects duplicate legacy names and missing raw identity", () => {
    expect(() => project([tool(), tool()])).toThrow("compact_tool_name_collision");
    expect(() => project([tool({ providerMetadata: {} })])).toThrow("compact_tool_identity_missing");
    expect(() => project([tool({ connectionId: null })])).toThrow("compact_tool_identity_missing");
    expect(() => project([tool()], { companyId: "" })).toThrow("compact_tool_identity_missing");
  });

  it("rejects an invalid injected digest", () => {
    expect(() => project([tool()], { digest: () => "invalid" })).toThrow("compact_tool_digest_invalid");
  });

  it("projects only connection tools and resolves aliases, not legacy names", () => {
    const connection = tool();
    const builtin = tool({ name: "paperclip_get_issue", providerType: "paperclip_self", providerMetadata: undefined });
    // Duplicate non-connection names do not break connection aliases.
    const duplicate = { ...builtin };
    const listed = presentCompactConnectionToolNames({ companyId: "company-a", tools: [builtin, connection, duplicate] });
    expect(listed.map(entry => entry.presentedName)).toEqual([
      "paperclip_get_issue", expect.stringMatching(/^linear_[a-f0-9]{16}_search_issues$/), "paperclip_get_issue",
    ]);
    expect(listed[1]!.name).toBe(connection.name);
    const alias = listed[1]!.presentedName;
    const resolve = (name: string) => resolveCompactConnectionTool({ companyId: "company-a", tools: [builtin, connection, duplicate], name });
    expect(resolve(alias)).toBe(connection);
    expect(resolve(connection.name)).toBeUndefined();
    expect(resolve("paperclip_get_issue")).toBeUndefined();
    expect(resolveCompactConnectionTool({ companyId: "company-b", tools: [connection], name: alias })).toBeUndefined();
    expect(() => presentCompactConnectionToolNames({ companyId: "company-a", tools: [connection], reservedNames: [alias] }))
      .toThrow("compact_tool_name_collision");
  });

  it("accepts only the known mode and honors the kill switch", () => {
    expect(parseConnectionToolNameMode(undefined)).toBe("legacy");
    expect(parseConnectionToolNameMode("compact-v1")).toBe("compact-v1");
    for (const value of ["", "legacy", "compact-v2", "COMPACT-V1", ["compact-v1"], 1]) {
      expect(() => parseConnectionToolNameMode(value)).toThrow("unsupported_tool_name_mode");
    }
    expect(compactConnectionToolNamesDisabled({})).toBe(false);
    expect(compactConnectionToolNamesDisabled({ PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED: "true" })).toBe(true);
    expect(compactConnectionToolNamesDisabled({ PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED: "1" })).toBe(true);
    expect(compactConnectionToolNamesDisabled({ PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED: "no" })).toBe(false);
  });

  it("opts in only Claude agents that ask for compact-v1", () => {
    const optedIn = { adapterType: "claude_local", runtimeConfig: { connectionToolNames: "compact-v1" } };
    expect(connectionToolNameModeForAgent(optedIn, {})).toBe("compact-v1");
    expect(connectionToolNameModeForAgent({ ...optedIn, adapterType: "codex_local" }, {})).toBe("legacy");
    expect(connectionToolNameModeForAgent({ adapterType: "claude_local", runtimeConfig: {} }, {})).toBe("legacy");
    expect(connectionToolNameModeForAgent({ adapterType: "claude_local", runtimeConfig: { connectionToolNames: "compact-v2" } }, {}))
      .toBe("legacy");
    expect(connectionToolNameModeForAgent(optedIn, { PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED: "true" })).toBe("legacy");
  });

  it("presents the assigned server with label p and the versioned URL only in compact mode", () => {
    const url = "https://paperclip.example/mcp/gateways/gw_1";
    expect(assignedMcpServerPresentation(url, "legacy")).toEqual({ name: "paperclip-assigned", url });
    expect(assignedMcpServerPresentation(url, "compact-v1")).toEqual({ name: "p", url: `${url}?toolNames=compact-v1` });
  });
});
