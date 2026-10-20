import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionGrants, createDb, getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase,
  toolActionRequests, toolCallEvents, toolInvocations, toolPolicies,
} from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { mcpGatewayProtocolRoutes } from "../routes/tool-gateway.js";
import { createListingFixture } from "./helpers/tool-gateway-listing-fixture.js";

// Fork-only (NX-834): old-build approval replay on disposable data. Parked
// approvals created by this build (legacy and compact calls) must execute
// exactly once both here and in an older build after a rollback; rejected,
// expired and access-revoked ones stay blocked in both.
//
// Opt-in, because it needs a second checkout:
//   git worktree add --detach <dir> <older commit> && (cd <dir> && pnpm install --offline)
//   PAPERCLIP_COMPACT_REPLAY_OLD_SERVER_DIR=<dir>/server npx vitest run <this file>
const oldServerDir = process.env.PAPERCLIP_COMPACT_REPLAY_OLD_SERVER_DIR;
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported && oldServerDir ? describe : describe.skip;
const here = path.dirname(fileURLToPath(import.meta.url));
const currentServerDir = path.resolve(here, "../..");
const executorPath = "src/__tests__/helpers/compact-approval-replay-executor.ts";
const signingSecret = `replay-${randomUUID()}`;

type ReplayResult = {
  key: string;
  attempts: Array<{ status: string | null; error: string | null }>;
  providerCalls: string[];
  requestStatus: string;
  invocationStatus: string;
  invocationToolName: string;
};

suite("compact connection tool names: old-build approval replay", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-compact-replay-");
    db = createDb(temp.connectionString);
  });
  afterAll(async () => { await temp?.cleanup(); });

  function runExecutor(serverDir: string, cases: Array<{ key: string; companyId: string; actionRequestId: string }>) {
    const dir = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), "compact-replay-"));
    const inputPath = path.join(dir, "input.json");
    const outputPath = path.join(dir, "output.json");
    writeFileSync(inputPath, JSON.stringify({ connectionString: temp.connectionString, signingSecret, cases }));
    if (serverDir !== currentServerDir) {
      copyFileSync(path.join(currentServerDir, executorPath), path.join(serverDir, executorPath));
    }
    execFileSync(path.join(serverDir, "node_modules/.bin/tsx"), [executorPath, inputPath, outputPath], {
      cwd: serverDir, stdio: "pipe", timeout: 120_000,
    });
    return JSON.parse(readFileSync(outputPath, "utf8")) as ReplayResult[];
  }

  it("executes legacy and compact approvals exactly once in this build and in the older build", async () => {
    const fixture = await createListingFixture(db, 30);
    await db.insert(connectionGrants).values({ companyId: fixture.company.id, connectionId: fixture.connection.id,
      kind: "organization", status: "active", isDefault: true });
    const gateway = createToolGatewayService(db, {
      toolActionSigningSecret: signingSecret,
      remoteHttpRequest: async () => { throw new Error("no provider call may happen before approval"); },
    });
    const app = express().use(express.json()).use(mcpGatewayProtocolRoutes(gateway));
    const post = (name: string, compact: boolean) =>
      request(app).post(`/mcp/gateways/${fixture.namedGateway.gatewayPublicId}${compact ? "?toolNames=compact-v1" : ""}`)
        .set("Authorization", `Bearer ${fixture.token.token}`)
        .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { query: `replay ${randomUUID()}` } } });
    const descriptors = await gateway.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token });
    const writeTools = fixture.entries.filter((_, index) => index % 3 === 0);
    const legacyName = (entry: typeof writeTools[number]) => descriptors.find((tool) => tool.catalogEntryId === entry.id)!.name;
    const alias = (entry: typeof writeTools[number]) => `link_${createHash("sha256").update(JSON.stringify([
      "compact-v1", fixture.company.id, entry.connectionId, entry.name, entry.toolName,
    ])).digest("hex").slice(0, 16)}_${entry.toolName}`;

    const kinds = ["before-compact", "compact", "rejected", "expired", "revoked"] as const;
    const cases: Record<"current" | "old", Array<{ key: string; companyId: string; actionRequestId: string; upstream: string }>> =
      { current: [], old: [] };
    let next = 0;
    for (const build of ["current", "old"] as const) {
      for (const kind of kinds) {
        const entry = writeTools[next++]!;
        // "before-compact" is parked through the legacy name, as before enablement.
        const parked = await post(kind === "before-compact" ? legacyName(entry) : alias(entry), kind !== "before-compact");
        expect(parked.status, JSON.stringify(parked.body)).toBe(409);
        const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.catalogEntryId, entry.id));
        const [actionRequest] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.invocationId, invocation!.id));
        expect(actionRequest!.status).toBe("pending");
        if (kind === "rejected") {
          await gateway.declineActionRequest({ companyId: fixture.company.id, actionRequestId: actionRequest!.id,
            actor: { userId: "replay-reviewer" } });
        }
        if (kind === "expired") {
          await db.update(toolActionRequests).set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(toolActionRequests.id, actionRequest!.id));
        }
        if (kind === "revoked") {
          await db.insert(toolPolicies).values({ companyId: fixture.company.id, name: `Revoke ${randomUUID()}`,
            policyType: "block", priority: 0, selectors: { catalogEntryId: entry.id } });
        }
        cases[build].push({ key: `${build}:${kind}`, companyId: fixture.company.id, actionRequestId: actionRequest!.id,
          upstream: entry.toolName });
      }
    }

    // Nothing durable carries a compact alias, so an older build reads it all.
    const stored = JSON.stringify([
      await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, fixture.company.id)),
      await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, fixture.company.id)),
      await db.select().from(toolCallEvents).where(eq(toolCallEvents.companyId, fixture.company.id)),
    ]);
    expect(stored).not.toMatch(/link_[a-f0-9]{16}_/);

    const results = [
      ...runExecutor(currentServerDir, cases.current),
      ...runExecutor(oldServerDir!, cases.old),
    ];
    for (const build of ["current", "old"] as const) {
      for (const replayCase of cases[build]) {
        const result = results.find((entry) => entry.key === replayCase.key)!;
        expect(result.invocationToolName).not.toMatch(/^link_/);
        if (replayCase.key.endsWith(":before-compact") || replayCase.key.endsWith(":compact")) {
          expect(result.providerCalls, replayCase.key).toEqual([replayCase.upstream]);
          expect(result.attempts[0]!.status, replayCase.key).toBe("executed");
          expect(result.requestStatus, replayCase.key).toBe("executed");
          expect(result.invocationStatus, replayCase.key).toBe("succeeded");
        } else {
          expect(result.providerCalls, JSON.stringify(result)).toEqual([]);
          expect(result.requestStatus, replayCase.key).not.toBe("executed");
          expect(result.invocationStatus, replayCase.key).not.toBe("succeeded");
        }
      }
    }
    const reportPath = process.env.PAPERCLIP_COMPACT_REPLAY_REPORT;
    if (reportPath) writeFileSync(reportPath, JSON.stringify(results.map(({ key, attempts, providerCalls, requestStatus,
      invocationStatus }) => ({ key, attempts, providerCalls: providerCalls.length, requestStatus, invocationStatus })), null, 1));
  }, 600_000);
});
