import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  prepareCodexRuntimeConfig,
  readPaperclipRuntimeSkillEntries,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
  tempCodexHome,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  prepareCodexRuntimeConfig: vi.fn(async () => ({ cleanup: vi.fn(async () => undefined), notes: [] })),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "codex"),
  runAdapterExecutionTargetProcess: vi.fn(),
  tempCodexHome: "/tmp/paperclip-codex-recovery-meta-test-home",
}));

vi.mock("./acp.js", () => ({
  createCodexAcpExecutor: () => vi.fn(),
  formatCodexAcpFallbackMessage: (reason: string) => `[paperclip] Codex ACP default unavailable. ${reason}\n`,
  resolveCodexExecutionEngineForRun: async () => ({ engine: "cli", explicit: true }),
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return { ...actual, readPaperclipRuntimeSkillEntries };
});

vi.mock("./codex-home.js", async () => {
  const actual = await vi.importActual<typeof import("./codex-home.js")>("./codex-home.js");
  return {
    ...actual,
    evaluateCodexCredentialReadiness: vi.fn(async () => ({
      managed: true,
      authMode: "api",
      ready: true,
      effectiveHome: tempCodexHome,
      sharedSourceHome: tempCodexHome,
    })),
    isManagedCodexHomePath: vi.fn(() => true),
    prepareManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
    resolveManagedCodexHomeDir: vi.fn(() => tempCodexHome),
    seedManagedCodexHome: vi.fn(async () => ({ status: "seeded", home: tempCodexHome })),
  };
});

vi.mock("./runtime-config.js", async () => {
  const actual = await vi.importActual<typeof import("./runtime-config.js")>("./runtime-config.js");
  return { ...actual, prepareCodexRuntimeConfig };
});

import { execute } from "./execute.js";

describe("Codex CLI recovery metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes an allowlisted recovery block through onMeta without env or credentials", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => ({
      exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1,
      startedAt: new Date().toISOString(),
    }));
    const metas: Array<Record<string, unknown>> = [];

    await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: "thread-before", sessionParams: { sessionId: "thread-before", cwd: process.cwd() }, sessionDisplayId: null, taskKey: null },
      config: {
        outputInactivityTimeoutMs: null,
        model: "gpt-test",
        env: { OPENAI_API_KEY: "sk-openai-super-secret" },
      },
      context: {},
      onLog: vi.fn(async () => {}),
      onMeta: async (meta) => {
        metas.push(meta as unknown as Record<string, unknown>);
      },
    });

    expect(metas.length).toBeGreaterThanOrEqual(1);
    const recovery = metas[0]?.recovery as Record<string, unknown>;
    expect(recovery).toMatchObject({
      version: 1,
      engine: "cli",
      accounting: { provider: "openai", model: "gpt-test", billingType: "api" },
    });
    expect(typeof (recovery.sessionParams as Record<string, unknown>).cwd).toBe("string");
    expect(Object.keys(recovery).sort()).toEqual(["accounting", "engine", "freshSessionRetry", "sessionIdBefore", "sessionParams", "version"]);
    expect(JSON.stringify(recovery)).not.toContain("sk-openai-super-secret");
  });

  it("marks only the invocation after an unusable resume session as a fresh-session retry", async () => {
    runAdapterExecutionTargetProcess
      .mockImplementationOnce(async () => ({
        exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "Error: unknown thread thread-before", pid: 1,
        startedAt: new Date().toISOString(),
      }))
      .mockImplementationOnce(async () => ({
        exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 2,
        startedAt: new Date().toISOString(),
      }));
    const metas: Array<Record<string, unknown>> = [];

    await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: {} },
      runtime: { sessionId: "thread-before", sessionParams: { sessionId: "thread-before", cwd: process.cwd() }, sessionDisplayId: null, taskKey: null },
      config: { outputInactivityTimeoutMs: null, model: "gpt-test", env: { OPENAI_API_KEY: "sk-openai-super-secret" } },
      context: {},
      onLog: vi.fn(async () => {}),
      onMeta: async (meta) => {
        metas.push(meta as unknown as Record<string, unknown>);
      },
    });

    const recoveries = metas.map((meta) => meta.recovery as Record<string, unknown>);
    expect(recoveries).toHaveLength(2);
    expect(recoveries[0]).toMatchObject({ sessionIdBefore: "thread-before", freshSessionRetry: false });
    expect(recoveries[1]).toMatchObject({ sessionIdBefore: null, freshSessionRetry: true });
  });

  it("does not mark a first invocation that could not resume the stored session", async () => {
    runAdapterExecutionTargetProcess.mockImplementation(async () => ({
      exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 1,
      startedAt: new Date().toISOString(),
    }));
    const metas: Array<Record<string, unknown>> = [];

    await execute({
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Codex Coder", adapterType: "codex_local", adapterConfig: {} },
      runtime: {
        sessionId: "thread-before",
        sessionParams: { sessionId: "thread-before", cwd: "/somewhere/else/entirely" },
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { outputInactivityTimeoutMs: null, model: "gpt-test", env: { OPENAI_API_KEY: "sk-openai-super-secret" } },
      context: {},
      onLog: vi.fn(async () => {}),
      onMeta: async (meta) => {
        metas.push(meta as unknown as Record<string, unknown>);
      },
    });

    expect(metas).toHaveLength(1);
    expect(metas[0]?.recovery).toMatchObject({ sessionIdBefore: null, freshSessionRetry: false });
  });
});
