// Fork-only (NX-834): approves parked tool actions with whichever build runs
// this file. compact-connection-tool-names-replay.test.ts runs it from the
// current checkout and from an older checkout to prove rollback safety, so it
// must only use APIs that exist in both builds.
//
// Usage: tsx compact-approval-replay-executor.ts <input.json> <output.json>
import { readFileSync, writeFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { createDb, toolActionRequests, toolInvocations } from "@paperclipai/db";
import { createToolGatewayService } from "../../services/tool-gateway.js";

interface ReplayInput {
  connectionString: string;
  signingSecret: string;
  cases: Array<{ key: string; companyId: string; actionRequestId: string }>;
}

const [inputPath, outputPath] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputPath!, "utf8")) as ReplayInput;
const db = createDb(input.connectionString);
const providerCalls: string[] = [];
const gateway = createToolGatewayService(db, {
  toolActionSigningSecret: input.signingSecret,
  remoteHttpRequest: async (_url, init) => {
    const body = JSON.parse(String(init.body));
    if (body.method === "tools/call") providerCalls.push(body.params.name);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
      : { content: [{ type: "text", text: "replayed" }] } }), { headers: { "content-type": "application/json" } });
  },
});

const results = [];
for (const replayCase of input.cases) {
  const attempts = [];
  const callsBefore = providerCalls.length;
  // Approve twice: the second must never execute the action again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const resolved = await gateway.approveActionRequest({
        companyId: replayCase.companyId,
        actionRequestId: replayCase.actionRequestId,
        actor: { userId: "replay-reviewer" },
      });
      attempts.push({ status: (resolved as { status?: string }).status ?? null, error: null });
    } catch (error) {
      attempts.push({ status: null, error: (error as { reasonCode?: string; message?: string }).reasonCode
        ?? (error as Error).message });
    }
  }
  const [request] = await db.select().from(toolActionRequests).where(eq(toolActionRequests.id, replayCase.actionRequestId));
  const [invocation] = await db.select().from(toolInvocations).where(eq(toolInvocations.id, request!.invocationId));
  results.push({
    key: replayCase.key,
    attempts,
    providerCalls: providerCalls.slice(callsBefore),
    requestStatus: request!.status,
    invocationStatus: invocation!.status,
    invocationToolName: invocation!.toolName,
  });
}
writeFileSync(outputPath!, JSON.stringify(results, null, 2));
await db.$client.end();
