import { defineConfig } from "vitest/config";
import { agentMaxWorkers } from "./scripts/agent-test-limits.mjs";

export default defineConfig({
  test: {
    maxWorkers: agentMaxWorkers(process.env),
    projects: [
      {
        test: {
          name: "agent-test-limits",
          include: ["scripts/agent-test-limits.test.mjs"],
        },
      },
      "packages/shared",
      "packages/skills-catalog",
      "packages/db",
      "packages/adapter-utils",
      "packages/adapters/claude-local",
      "packages/adapters/codex-local",
      "packages/adapters/cursor-cloud",
      "packages/adapters/cursor-local",
      "packages/adapters/gemini-local",
      "packages/adapters/grok-local",
      "packages/adapters/kimi-local",
      "packages/adapters/openclaw-gateway",
      "packages/adapters/opencode-local",
      "packages/adapters/pi-local",
      "packages/plugins/sdk",
      "packages/plugins/create-paperclip-plugin",
      "packages/plugins/sandbox-providers/daytona",
      "server",
      "ui",
      "cli",
    ],
  },
});
