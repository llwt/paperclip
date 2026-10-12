import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import type { RunProcessResult } from "@paperclipai/adapter-utils/server-utils";

const sessionId = "11111111-1111-4111-8111-111111111111";
const { runChildProcess } = vi.hoisted(() => ({ runChildProcess: vi.fn() }));
vi.mock("@paperclipai/adapter-utils/server-utils", async () => ({
  ...await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>("@paperclipai/adapter-utils/server-utils"),
  runChildProcess,
  ensureCommandResolvable: vi.fn(),
  resolveCommandForLogs: vi.fn(async () => "/mock/claude"),
}));
import { execute } from "./execute.js";
import { sessionCodec } from "./index.js";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

const heading = "## Paperclip instruction location for this invocation";
function success(id = sessionId): RunProcessResult {
  return {
    exitCode: 0, signal: null, timedOut: false, stderr: "", pid: 1, startedAt: new Date().toISOString(),
    stdout: JSON.stringify({ type: "result", session_id: id, subtype: "success", is_error: false, result: "Done." }),
  };
}

describe("Claude current instruction location and resume gates", () => {
  let root: string;
  let cwd: string;
  let entry: string;
  const captured: Array<{ runId: string; args: string[]; prompt: string }> = [];
  const logs: string[] = [];
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-current-location-"));
    cwd = path.join(root, "workspace");
    entry = path.join(root, "run-1", "live", "nested dir", "AGENTS.md");
    await fs.mkdir(cwd);
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "Read ./SIBLING.md. Keep authored run-1 unchanged.\n");
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
    captured.length = 0;
    logs.length = 0;
    runChildProcess.mockReset();
    runChildProcess.mockImplementation(async (runId, _command, args, options) => {
      captured.push({ runId, args, prompt: options.stdin ?? "" });
      return success();
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function input(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
    return {
      runId: "run-1",
      agent: { id: "agent-1", companyId: "company-1", name: "Test", adapterType: "claude_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: "task-1" },
      config: { engine: "cli", command: "fixture-command", cwd, instructionsFilePath: entry, paperclipRuntimeSkills: [],
        promptTemplate: "Current task.", bootstrapPromptTemplate: "Bootstrap." },
      context: { paperclipTaskMarkdown: "Full task.", paperclipTaskMarkdownCompact: "Compact task." },
      onLog: async (_stream, text) => { logs.push(text); },
      ...overrides,
    };
  }
  function runtime(result: AdapterExecutionResult) {
    return { sessionId: null, sessionParams: sessionCodec.deserialize(sessionCodec.serialize(result.sessionParams ?? null)),
      sessionDisplayId: null, taskKey: "task-1" };
  }
  function assertLocation(prompt: string, currentEntry = entry) {
    expect(prompt.startsWith(heading)).toBe(true);
    expect(prompt.split(heading)).toHaveLength(2);
    expect(prompt.split(currentEntry)).toHaveLength(2);
    expect(prompt).toContain(`Resolve any relative file references from ${path.dirname(currentEntry)}/.`);
    expect(prompt).toContain("Re-read referenced sibling instructions");
  }

  it("uses identical bundle bytes and directory across fresh and codec-resumed run copies", async () => {
    const first = await execute(input());
    const firstCall = captured[0];
    const bundleFile = firstCall.args[firstCall.args.indexOf("--append-system-prompt-file") + 1];
    const bytes = await fs.readFile(bundleFile, "utf8");
    expect(bytes).toContain("authored run-1 unchanged");
    expect(bytes).not.toContain(entry);
    assertLocation(firstCall.prompt);
    const nextEntry = entry.replace("run-1", "run-2");
    await fs.mkdir(path.dirname(nextEntry), { recursive: true });
    await fs.copyFile(entry, nextEntry);
    const nextInput = input({ runId: "run-2", runtime: runtime(first) });
    nextInput.config.instructionsFilePath = nextEntry;
    const second = await execute(nextInput);
    expect(second.sessionParams?.promptBundleKey).toBe(first.sessionParams?.promptBundleKey);
    expect(captured[1].args).toContain("--resume");
    expect(captured[1].args).toContain(sessionId);
    expect(captured[1].args).not.toContain("--append-system-prompt-file");
    expect(captured[1].args[captured[1].args.indexOf("--add-dir") + 1]).toBe(path.dirname(bundleFile));
    assertLocation(captured[1].prompt, nextEntry);
    expect(captured[1].prompt).not.toContain(entry);
    expect(await fs.readFile(bundleFile, "utf8")).toBe(bytes);
  });

  it.each([undefined, "", "old-key"])("starts fresh for missing or mismatched saved key %s", async key => {
    await execute(input({ runtime: { sessionId, sessionParams: { sessionId, cwd, promptBundleKey: key },
      sessionDisplayId: null, taskKey: "task-1" } }));
    expect(captured[0].args).not.toContain("--resume");
    expect(captured[0].args).toContain("--append-system-prompt-file");
  });

  it("rejects a saved v1 bundle that contains the previous system-level path directive", async () => {
    const legacy = await prepareClaudePromptBundle({ companyId: "company-1", skills: [],
      instructionsContents: await fs.readFile(entry, "utf8") +
        `\nThe above agent instructions were loaded from ${entry}. ` +
        `Resolve any relative file references from ${path.dirname(entry)}/. ` +
        "This base directory is authoritative for sibling instruction files such as " +
        "./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.",
      onLog: async () => {},
    });
    const result = await execute(input({ runtime: { sessionId, sessionParams: {
      sessionId, cwd, promptBundleKey: legacy.bundleKey,
    }, sessionDisplayId: null, taskKey: "task-1" } }));
    expect(result.sessionParams?.promptBundleKey).not.toBe(legacy.bundleKey);
    expect(captured[0].args).not.toContain("--resume");
    assertLocation(captured[0].prompt);
  });

  it.each(["changed", "removed"])("rejects the previous key when instructions are %s", async change => {
    const first = await execute(input());
    const next = input({ runtime: runtime(first) });
    if (change === "changed") await fs.writeFile(entry, "Published new instructions.\n");
    else delete next.config.instructionsFilePath;
    const second = await execute(next);
    expect(second.sessionParams?.promptBundleKey).not.toBe(first.sessionParams?.promptBundleKey);
    expect(captured[1].args).not.toContain("--resume");
    expect(captured[1].prompt.includes(heading)).toBe(change === "changed");
  });

  it.each(["missing", "unreadable", "empty", "unconfigured"])("handles %s instruction sources", async mode => {
    const next = input();
    if (mode === "missing") next.config.instructionsFilePath = path.join(root, "missing.md");
    if (mode === "unreadable") next.config.instructionsFilePath = path.dirname(entry);
    if (mode === "empty") await fs.writeFile(entry, "");
    if (mode === "unconfigured") delete next.config.instructionsFilePath;
    await execute(next);
    expect(captured[0].prompt.includes(heading)).toBe(mode === "empty");
    if (mode === "missing" || mode === "unreadable") expect(logs.join("")).toContain("could not read agent instructions");
  });

  it("loads a manifest without claiming an unreadable instruction source", async () => {
    const skillDir = path.join(root, "skill");
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "Skill.");
    const next = input();
    next.config.instructionsFilePath = path.join(root, "missing.md");
    next.config.paperclipRuntimeSkills = [{ key: "test", runtimeName: "test", source: skillDir }];
    next.config.paperclipSkillSync = { desiredSkills: ["test"] };
    await execute(next);
    expect(captured[0].prompt).not.toContain(heading);
    const file = captured[0].args[captured[0].args.indexOf("--append-system-prompt-file") + 1];
    expect(await fs.readFile(file, "utf8")).toContain("test");
  });

  it("refreshes location on recovery and once on each failed-resume attempt", async () => {
    const first = await execute(input());
    runChildProcess.mockImplementationOnce(async (runId, _command, args, options) => {
      captured.push({ runId, args, prompt: options.stdin });
      return { ...success(), exitCode: 1, stdout: JSON.stringify({ type: "result", is_error: true,
        result: `No conversation found with session id ${sessionId}` }) };
    });
    const next = input({ runtime: runtime(first) });
    await execute(next);
    expect(captured).toHaveLength(3);
    expect(captured[1].args).toContain("--resume");
    expect(captured[2].args).not.toContain("--resume");
    assertLocation(captured[1].prompt);
    assertLocation(captured[2].prompt);
    expect(captured[1].prompt).not.toContain("Bootstrap.");
    expect(captured[2].prompt).toContain("Bootstrap.");
    for (const saved of [runtime(first), input().runtime]) {
      const recovery = input({ runtime: saved, context: { paperclipWake: {
        reason: "source_scoped_recovery_action", recovery: { cause: "run_failed" },
      } } });
      await execute(recovery);
      assertLocation(captured.at(-1)!.prompt);
      expect(captured.at(-1)!.prompt).not.toContain("Current task.");
    }
  });

  it("preserves the MCP identity and cwd gates while allowing token rotation", async () => {
    const server = { name: "tools", url: "https://tools.example/mcp", connectionId: "connection-1", token: "first" };
    const next = input({ runtimeMcp: { getServers: () => [server] } });
    const first = await execute(next);
    server.token = "second";
    await execute({ ...next, runtime: runtime(first) });
    expect(captured[1].args).toContain("--resume");
    server.connectionId = "connection-2";
    await execute({ ...next, runtime: runtime(first) });
    expect(captured[2].args).not.toContain("--resume");
    server.connectionId = "connection-1";
    await execute({ ...next, runtime: { ...runtime(first), sessionParams: { ...first.sessionParams, cwd: path.join(root, "different") } } });
    expect(captured[3].args).not.toContain("--resume");
  });

  it("keeps concurrent task sessions and current-copy siblings independent", async () => {
    const first = await execute(input());
    const otherEntry = entry.replace("run-1", "run-2");
    await fs.mkdir(path.dirname(otherEntry), { recursive: true });
    await fs.copyFile(entry, otherEntry);
    await fs.writeFile(path.join(path.dirname(entry), "SIBLING.md"), "ALPHA");
    await fs.writeFile(path.join(path.dirname(otherEntry), "SIBLING.md"), "BETA");
    let release!: () => void;
    const bothStarted = new Promise<void>(resolve => { release = resolve; });
    let starts = 0;
    runChildProcess.mockImplementation(async (runId, _command, args, options) => {
      captured.push({ runId, args, prompt: options.stdin });
      if (++starts === 2) release();
      await bothStarted;
      return success(args[args.indexOf("--resume") + 1]);
    });
    const second = input({ runId: "run-2", runtime: { ...runtime(first), taskKey: "task-2",
      sessionParams: { ...first.sessionParams, sessionId: "22222222-2222-4222-8222-222222222222" } } });
    second.config.instructionsFilePath = otherEntry;
    const results = await Promise.all([execute(input({ runtime: runtime(first) })), execute(second)]);
    expect(results[0].sessionParams?.promptBundleKey).toBe(results[1].sessionParams?.promptBundleKey);
    expect(results[0].sessionId).not.toBe(results[1].sessionId);
    for (const call of captured.slice(1)) assertLocation(call.prompt, call.runId === "run-1" ? entry : otherEntry);
    expect(await fs.readFile(path.join(path.dirname(entry), "SIBLING.md"), "utf8")).toBe("ALPHA");
    expect(await fs.readFile(path.join(path.dirname(otherEntry), "SIBLING.md"), "utf8")).toBe("BETA");
  });
});
