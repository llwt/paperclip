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

describe("Claude CLI recovery metadata", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-recovery-meta-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    runChildProcess.mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("passes an allowlisted recovery block through onMeta without env or credentials", async () => {
    runChildProcess.mockResolvedValue({
      exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1,
      startedAt: new Date().toISOString(),
    });
    const metas: Array<Record<string, unknown>> = [];

    await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-1" },
      config: {
        engine: "cli",
        command: "fixture-command",
        cwd: root,
        model: "claude-sonnet-test",
        env: { ANTHROPIC_API_KEY: "sk-ant-super-secret" },
        paperclipRuntimeSkills: [],
        promptTemplate: "Current task.",
      },
      context: {},
      onLog: async () => {},
      onMeta: async (meta) => {
        metas.push(meta as unknown as Record<string, unknown>);
      },
    });

    expect(metas).toHaveLength(1);
    const recovery = metas[0]?.recovery as Record<string, unknown>;
    expect(recovery).toMatchObject({
      version: 1,
      engine: "cli",
      sessionIdBefore: null,
      accounting: { provider: "anthropic", biller: "anthropic", model: "claude-sonnet-test", billingType: "api" },
    });
    const sessionParams = recovery.sessionParams as Record<string, unknown>;
    expect(sessionParams.cwd).toBe(root);
    expect(typeof sessionParams.promptBundleKey).toBe("string");
    expect(Object.keys(recovery).sort()).toEqual(["accounting", "engine", "sessionIdBefore", "sessionParams", "version"]);
    expect(JSON.stringify(recovery)).not.toContain("sk-ant-super-secret");
  });
});
