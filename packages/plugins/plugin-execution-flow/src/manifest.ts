import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "somnex.execution-flow",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Execution flow",
  description: "Read-only execution stages and retained decisions",
  author: "Somnex",
  categories: ["ui"],
  capabilities: [
    "issues.read",
    "issue.execution.read",
    "issue.interactions.read",
    "ui.detailTab.register",
  ],
  entrypoints: { worker: "./dist/worker.js", ui: "./dist/ui" },
  ui: {
    slots: [{
      type: "taskDetailView",
      id: "execution-flow",
      displayName: "Execution flow",
      entityTypes: ["issue"],
      exportName: "ExecutionFlow",
    }],
  },
};

export default manifest;
