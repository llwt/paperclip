import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runChildProcess } = vi.hoisted(() => ({ runChildProcess: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess,
  ensureCommandResolvable: vi.fn(),
  resolveCommandForLogs: vi.fn(async () => "/mock/claude"),
}));
import { execute } from "./execute.js";

describe("Claude CLI quota classification", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-quota-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    runChildProcess.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns provider_quota for a session limit after unauthorized tool output", async () => {
    const stdout = await fs.readFile(new URL("./__fixtures__/session-limit-with-tool-output.jsonl", import.meta.url), "utf8");
    runChildProcess.mockResolvedValue({
      exitCode: 1, signal: null, timedOut: false, stdout, stderr: "", pid: 1,
      startedAt: new Date().toISOString(),
    });

    const result = await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-1" },
      config: { engine: "cli", command: "fixture-command", cwd: root, paperclipRuntimeSkills: [], promptTemplate: "Current task." },
      context: {},
      onLog: async () => {},
    });

    expect(result.errorCode).toBe("provider_quota");
    expect(result.errorCode).not.toBe("claude_auth_required");
    expect(result.errorFamily).toBe("provider_quota");
    expect(runChildProcess).toHaveBeenCalledTimes(1);
  });
});
