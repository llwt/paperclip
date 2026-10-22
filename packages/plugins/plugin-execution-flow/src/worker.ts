import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { buildExecutionFlow, type Interaction, type ReadResult } from "./model.js";
import type { PluginIssueExecutionDecisionsPage } from "@paperclipai/plugin-sdk";

export const DATA_KEY = "execution-flow";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register(DATA_KEY, async (params) => {
      const { companyId, issueId, cursor } = params;
      if (typeof companyId !== "string" || !companyId.trim() || typeof issueId !== "string" || !issueId.trim()) {
        throw new Error("companyId and issueId are required");
      }
      if (cursor !== undefined && (typeof cursor !== "string" || !cursor)) throw new Error("cursor must be a non-empty string");
      const issue = await ctx.issues.get(issueId, companyId);
      if (!issue || issue.companyId !== companyId) throw new Error("Issue unavailable");
      // Isolate partial failures. An unsupported old host rejects the read like any other failure.
      const [historyResult, cardsResult] = await Promise.allSettled([
        Promise.resolve().then(() => ctx.issues.listExecutionDecisions(issue.id, companyId, { cursor, limit: 50 })),
        Promise.resolve().then(() => ctx.issues.listInteractions(issue.id, companyId)),
      ]);
      const history: ReadResult<PluginIssueExecutionDecisionsPage> = historyResult.status === "fulfilled"
        ? { status: "available", value: historyResult.value } : { status: "unavailable" };
      const interactions: ReadResult<Interaction[]> = cardsResult.status === "fulfilled"
        ? { status: "available", value: cardsResult.value } : { status: "unavailable" };
      return buildExecutionFlow({ issue, history, interactions, requestedCursor: cursor });
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
