import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@somnex/paperclip-plugin-execution-flow",
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
