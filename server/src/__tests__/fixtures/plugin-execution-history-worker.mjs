import { definePlugin } from "../../../../packages/plugins/sdk/dist/define-plugin.js";
import { runWorker } from "../../../../packages/plugins/sdk/dist/worker-rpc-host.js";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("history", params => ctx.issues.listExecutionDecisions(
      params.issueId, params.companyId, params.options,
    ));
    ctx.data.register("issue", params => ctx.issues.get(params.issueId, params.companyId));
  },
});

runWorker(plugin, import.meta.url);
