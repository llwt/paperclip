import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  connectionGrants, createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
  toolAccessAuditEvents, toolActionRequests, toolCallEvents, toolInvocations, toolPolicies, toolProfileEntries,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { COMPACT_CONNECTION_TOOL_NAMES_DISABLED_ENV } from "../services/compact-connection-tool-names.js";
import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";

// Fork-only (NX-834): a compact alias and the legacy name must behave the same.
// Fixture tools: index % 3 === 0 is a write (ask first), 1 is excluded by the
// gateway profile, 2 is blocked by a catalog entry ID policy.
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

type Fixture = Awaited<ReturnType<typeof createListingFixture>>;

function aliasFor(fixture: Fixture, index: number) {
  const entry = fixture.entries[index]!;
  const hash = createHash("sha256").update(JSON.stringify([
    "compact-v1", fixture.company.id, entry.connectionId, entry.name, entry.toolName,
  ])).digest("hex").slice(0, 16);
  // The fixture application key is not a gallery key, so the app segment is "link".
  return `link_${hash}_${entry.toolName}`;
}

suite("compact connection tool names over the named MCP endpoint", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-compact-names-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(() => { delete process.env[COMPACT_CONNECTION_TOOL_NAMES_DISABLED_ENV]; });

  async function setup(toolCount = 10) {
    const fixture = await createListingFixture(db, toolCount);
    await db.insert(connectionGrants).values({ companyId: fixture.company.id, connectionId: fixture.connection.id,
      kind: "organization", status: "active", isDefault: true });
    const providerCalls: string[] = [];
    const gateway = createToolGatewayService(db, { remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init.body));
      if (body.method === "tools/call") providerCalls.push(body.params.name);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
        : { content: [{ type: "text", text: "fixture result" }] } }), { headers: { "content-type": "application/json" } });
    } });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const path = `/mcp/gateways/${fixture.namedGateway.gatewayPublicId}`;
    const post = (method: string, params?: unknown, options: { compact?: boolean; token?: string; url?: string } = {}) =>
      request(app).post(`${options.url ?? path}${options.compact ? "?toolNames=compact-v1" : ""}`)
        .set("Authorization", `Bearer ${options.token ?? fixture.token.token}`)
        .send({ jsonrpc: "2.0", id: 1, method, params });
    const descriptors = await gateway.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token });
    const visibleRead = descriptors.find((tool) => tool.catalogEntryId === fixture.entries[4]!.id)!.name;
    const legacyFor = (index: number) => visibleRead.replace("tool-0004", fixture.entries[index]!.toolName.replace("_", "-"));
    const outcome = (response: request.Response) => ({
      status: response.status,
      reasonCode: response.body?.error?.data?.reasonCode ?? null,
      isError: response.body?.result?.isError ?? null,
    });
    return { fixture, gateway, app, path, post, providerCalls, legacyFor, outcome };
  }

  it("lists the same tools and schemas, each connection tool once under its alias", async () => {
    const { fixture, post, legacyFor } = await setup();
    const legacy = (await post("tools/list").expect(200)).body.result.tools as Array<Record<string, unknown>>;
    const compact = (await post("tools/list", undefined, { compact: true }).expect(200)).body.result.tools as Array<Record<string, unknown>>;
    expect(compact).toHaveLength(legacy.length);
    const legacyNames = new Set(legacy.map((tool) => tool.name));
    const compactNames = new Set(compact.map((tool) => tool.name));
    for (let index = 0; index < fixture.entries.length; index += 1) {
      const listed = legacyNames.has(legacyFor(index));
      expect(compactNames.has(aliasFor(fixture, index))).toBe(listed);
      // Never both definitions of one tool.
      expect(compactNames.has(legacyFor(index))).toBe(false);
    }
    expect(legacyNames.has(legacyFor(1))).toBe(false);
    expect(legacyNames.has(legacyFor(2))).toBe(false);
    const strip = ({ name: _name, ...rest }: Record<string, unknown>) => rest;
    expect(compact.map(strip)).toEqual(legacy.map(strip));
    for (const name of ["paperclip_list_resources", "paperclip_read_resource", "paperclip_list_prompts", "paperclip_get_prompt"]) {
      expect(compactNames.has(name)).toBe(true);
    }
    for (const tool of compact) expect(`mcp__p__${String(tool.name)}`.length).toBeLessThanOrEqual(78);
  });

  it("gives the same allow, deny, ask-first and profile outcomes, with identical stored identities", async () => {
    const { fixture, post, providerCalls, legacyFor, outcome } = await setup();
    // An exact-name profile rule written against the internal name keeps matching.
    await db.insert(toolProfileEntries).values({ companyId: fixture.company.id, profileId: fixture.namedGateway.profileId!,
      selectorType: "tool_name", toolName: legacyFor(5), effect: "exclude" });
    const cases = [
      { index: 4, expected: 200 }, // allowed read
      { index: 2, expected: 403 }, // catalog entry ID block policy
      { index: 1, expected: 403 }, // catalog entry profile exclusion
      { index: 5, expected: 403 }, // exact-name profile exclusion
      { index: 0, expected: 409 }, // ask first (risk-level policy)
    ];
    for (const { index, expected } of cases) {
      const before = providerCalls.length;
      const legacy = await post("tools/call", { name: legacyFor(index), arguments: { query: `q${index}` } });
      const compact = await post("tools/call", { name: aliasFor(fixture, index), arguments: { query: `q${index}` } }, { compact: true });
      expect(outcome(compact), `tool ${index}`).toEqual(outcome(legacy));
      expect(legacy.status, JSON.stringify(legacy.body)).toBe(expected);
      expect(providerCalls.length - before).toBe(expected === 200 ? 2 : 0);
    }
    expect(providerCalls).toEqual(["tool_0004", "tool_0004"]);

    const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, fixture.company.id));
    const identity = (row: typeof invocations[number]) => ({
      toolName: row.toolName, upstreamToolName: row.upstreamToolName, catalogEntryId: row.catalogEntryId,
      connectionId: row.connectionId, argumentsHash: row.argumentsHash, policyDecision: row.policyDecision,
      matchedPolicyIds: row.matchedPolicyIds, approvalState: row.approvalState, status: row.status,
      idempotencyKey: row.idempotencyKey,
    });
    const readRows = invocations.filter((row) => row.catalogEntryId === fixture.entries[4]!.id);
    expect(readRows).toHaveLength(2);
    expect(identity(readRows[1]!)).toEqual(identity(readRows[0]!));
    expect(readRows[0]!.toolName).toBe(legacyFor(4));
    // Same operation under either name: the compact call joins the legacy
    // call's pending approval instead of opening a second one.
    const askRows = invocations.filter((row) => row.catalogEntryId === fixture.entries[0]!.id);
    expect(askRows).toHaveLength(1);
    expect(askRows[0]).toMatchObject({ toolName: legacyFor(0), status: "awaiting_approval", approvalState: "pending" });
    const requests = await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, fixture.company.id));
    expect(requests).toHaveLength(1);
    // No alias reaches a durable row: invocations, events, audit, signed approvals.
    const events = await db.select().from(toolCallEvents).where(eq(toolCallEvents.companyId, fixture.company.id));
    const audits = await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.companyId, fixture.company.id));
    const stored = JSON.stringify([invocations, requests, events, audits]);
    for (let index = 0; index < fixture.entries.length; index += 1) expect(stored).not.toContain(aliasFor(fixture, index));
    expect(stored).not.toMatch(/link_[a-f0-9]{16}_/);
  });

  it("shares rate buckets and remembered trust, and honors revocation", async () => {
    const { fixture, post, providerCalls, legacyFor, outcome } = await setup();
    await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: `One call ${randomUUID()}`,
      policyType: "rate_limit", priority: 1, selectors: { catalogEntryId: fixture.entries[7]!.id },
      config: { limit: 1, windowSeconds: 600, keyBy: ["tool"] } });
    await post("tools/call", { name: legacyFor(7), arguments: {} }).expect(200);
    const limited = await post("tools/call", { name: aliasFor(fixture, 7), arguments: {} }, { compact: true });
    expect(outcome(limited)).toMatchObject({ status: 429, reasonCode: "rate_limited" });
    expect(providerCalls).toEqual(["tool_0007"]);

    // A remembered trust rule recorded with the internal name lets an ask-first tool run.
    const [trust] = await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: `Trust ${randomUUID()}`,
      policyType: "trust_rule", priority: 5, selectors: { agentId: fixture.agent.id, toolName: legacyFor(3) },
      config: { trustRule: { argumentFilters: { allowAny: true }, revokedAt: null, expiresAt: null } } }).returning();
    const trustedLegacy = await post("tools/call", { name: legacyFor(3), arguments: { query: "same" } });
    const trustedCompact = await post("tools/call", { name: aliasFor(fixture, 3), arguments: { query: "same" } }, { compact: true });
    expect(trustedLegacy.status, JSON.stringify(trustedLegacy.body)).toBe(200);
    expect(outcome(trustedCompact)).toEqual(outcome(trustedLegacy));

    await db.update(toolPolicies).set({ config: { trustRule: { argumentFilters: { allowAny: true },
      revokedAt: new Date().toISOString(), expiresAt: null } } }).where(eq(toolPolicies.id, trust!.id));
    const revokedLegacy = await post("tools/call", { name: legacyFor(3), arguments: { query: "after" } });
    const revokedCompact = await post("tools/call", { name: aliasFor(fixture, 3), arguments: { query: "after" } }, { compact: true });
    expect(revokedLegacy.status).toBe(409);
    expect(outcome(revokedCompact)).toEqual(outcome(revokedLegacy));

    // Revoking access after the listing applies to the alias on the next call.
    await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: `Block ${randomUUID()}`,
      policyType: "block", priority: 0, selectors: { catalogEntryId: fixture.entries[8]!.id } });
    const before = providerCalls.length;
    const blockedLegacy = await post("tools/call", { name: legacyFor(8), arguments: {} });
    const blockedCompact = await post("tools/call", { name: aliasFor(fixture, 8), arguments: {} }, { compact: true });
    expect(blockedLegacy.status).toBe(403);
    expect(outcome(blockedCompact)).toEqual(outcome(blockedLegacy));
    expect(providerCalls.length).toBe(before);
  });

  it("enforces token actions and gateway scope before resolving an alias", async () => {
    const { fixture, gateway, post, providerCalls, legacyFor, outcome } = await setup();
    const listOnly = await gateway.createNamedGatewayToken({ companyId: fixture.company.id, gatewayId: fixture.namedGateway.id,
      body: { name: "List only", subjectType: "heartbeat_run", subjectId: fixture.run.id, clientLabel: "claude", ownerNote: "",
        allowedActions: ["tools/list"] } });
    const callOnly = await gateway.createNamedGatewayToken({ companyId: fixture.company.id, gatewayId: fixture.namedGateway.id,
      body: { name: "Call only", subjectType: "heartbeat_run", subjectId: fixture.run.id, clientLabel: "claude", ownerNote: "",
        allowedActions: ["tools/call"] } });

    const listOnlyLegacy = await post("tools/call", { name: legacyFor(4), arguments: {} }, { token: listOnly.token });
    const listOnlyCompact = await post("tools/call", { name: aliasFor(fixture, 4), arguments: {} }, { token: listOnly.token, compact: true });
    expect(listOnlyLegacy.status).toBe(403);
    expect(outcome(listOnlyCompact)).toEqual(outcome(listOnlyLegacy));
    const callOnlyList = await post("tools/list", undefined, { token: callOnly.token, compact: true });
    expect(outcome(callOnlyList)).toEqual(outcome(await post("tools/list", undefined, { token: callOnly.token })));
    expect(callOnlyList.status).toBe(403);
    // A call-only token resolves an alias without a prior listing.
    await post("tools/call", { name: aliasFor(fixture, 4), arguments: {} }, { token: callOnly.token, compact: true }).expect(200);
    expect(providerCalls).toEqual(["tool_0004"]);

    // Another company's gateway: neither the token nor the alias crosses over.
    const other = await createListingFixture(db, 10);
    const otherPath = `/mcp/gateways/${other.namedGateway.gatewayPublicId}`;
    const wrongLegacy = await post("tools/call", { name: legacyFor(4), arguments: {} }, { url: otherPath });
    const wrongCompact = await post("tools/call", { name: aliasFor(fixture, 4), arguments: {} }, { url: otherPath, compact: true });
    expect(wrongLegacy.status).toBeGreaterThanOrEqual(400);
    expect(outcome(wrongCompact)).toEqual(outcome(wrongLegacy));
    // The other company's token cannot use this company's alias on its own gateway.
    const crossCompany = await post("tools/call", { name: aliasFor(fixture, 4), arguments: {} },
      { url: otherPath, token: other.token.token, compact: true });
    expect(outcome(crossCompany)).toMatchObject({ status: 404, reasonCode: "tool_not_found" });
    expect(providerCalls).toEqual(["tool_0004"]);
  });

  it("fails closed on unknown names and modes, and only resolves aliases in compact mode", async () => {
    const { fixture, post, providerCalls, legacyFor, outcome } = await setup();
    expect(outcome(await post("tools/call", { name: "link_0000000000000000_tool_0004", arguments: {} }, { compact: true })))
      .toMatchObject({ status: 404, reasonCode: "tool_not_found" });
    expect(outcome(await post("tools/call", { name: aliasFor(fixture, 4), arguments: {} })))
      .toMatchObject({ status: 404, reasonCode: "tool_not_found" });
    const unknownMode = await request((await setup()).app).post(`/mcp/gateways/${fixture.namedGateway.gatewayPublicId}?toolNames=compact-v2`)
      .set("Authorization", `Bearer ${fixture.token.token}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(outcome(unknownMode)).toMatchObject({ status: 400, reasonCode: "unsupported_tool_name_mode" });
    // Legacy names stay accepted on a compact session.
    await post("tools/call", { name: legacyFor(4), arguments: {} }, { compact: true }).expect(200);
    expect(providerCalls).toEqual(["tool_0004"]);
  });

  it("serves legacy names and stops resolving aliases when the kill switch is set", async () => {
    const { fixture, post, providerCalls, legacyFor, outcome } = await setup();
    process.env[COMPACT_CONNECTION_TOOL_NAMES_DISABLED_ENV] = "true";
    const listed = (await post("tools/list", undefined, { compact: true }).expect(200)).body.result.tools as Array<{ name: string }>;
    expect(listed.some((tool) => tool.name === legacyFor(4))).toBe(true);
    expect(listed.some((tool) => /^link_[a-f0-9]{16}_/.test(tool.name))).toBe(false);
    expect(outcome(await post("tools/call", { name: aliasFor(fixture, 4), arguments: {} }, { compact: true })))
      .toMatchObject({ status: 404, reasonCode: "tool_not_found" });
    expect(providerCalls).toEqual([]);
  });

  it("keeps durable approval rows identical for compact and legacy ask-first calls", async () => {
    const { fixture, post, legacyFor } = await setup();
    await post("tools/call", { name: legacyFor(6), arguments: { query: "approve me" } }).expect(409);
    await post("tools/call", { name: aliasFor(fixture, 6), arguments: { query: "approve me too" } }, { compact: true }).expect(409);
    const rows = await db.select({ request: toolActionRequests, invocation: toolInvocations }).from(toolActionRequests)
      .innerJoin(toolInvocations, eq(toolActionRequests.invocationId, toolInvocations.id))
      .where(and(eq(toolActionRequests.companyId, fixture.company.id), eq(toolInvocations.catalogEntryId, fixture.entries[6]!.id)));
    expect(rows).toHaveLength(2);
    for (const { request: actionRequest, invocation } of rows) {
      expect(invocation.toolName).toBe(legacyFor(6));
      expect(actionRequest.status).toBe(rows[0]!.request.status);
      expect(actionRequest.signedArguments).not.toMatch(/link_[a-f0-9]{16}_/);
    }
  });
});
