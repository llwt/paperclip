import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  configureAgentProcessIsolation,
  resetAgentProcessIsolation,
} from "@paperclipai/adapter-utils/server-utils";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import { createSystemdIsolationPolicy, IsolationHealth, scopeUnitNamespace } from "@paperclipai/process-launch";

const CLAUDE_SCRIPT = `#!/usr/bin/env node
require("node:fs").readFileSync(0, "utf8");
const sid = "11111111-1111-4111-8111-111111111111";
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "claude-sonnet" }));
console.log(JSON.stringify({ type: "result", session_id: sid, result: "hello", usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 } }));
`;

const CODEX_SCRIPT = `#!/usr/bin/env node
require("node:fs").readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "codex-session-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`;

// Records how it was called, then runs the target exactly as the real helper does after enrolling.
const STUB_HELPER = (argvLog: string) => `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvLog)}
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;

type Adapter = "claude" | "codex";

const ADAPTERS: Array<{ name: Adapter; commandName: string; script: string; run: (input: RunInput) => Promise<{ exitCode: number | null }> }> = [
  {
    name: "claude",
    commandName: "cli",
    script: CLAUDE_SCRIPT,
    run: ({ runId, command, cwd, companyId }) =>
      executeClaude({
        runId,
        agent: { id: "agent-1", companyId, name: "Claude", adapterType: "claude_local", adapterConfig: {} },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command, cwd, env: {} },
        context: {},
        onLog: async () => {},
      }),
  },
  {
    name: "codex",
    commandName: "codex",
    script: CODEX_SCRIPT,
    run: ({ runId, command, cwd, companyId }) =>
      executeCodex({
        runId,
        agent: { id: "agent-1", companyId, name: "Codex", adapterType: "codex_local", adapterConfig: { engine: "cli" } },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { engine: "cli", command, cwd, env: {}, promptTemplate: "Follow the paperclip heartbeat." },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      }),
  },
];

interface RunInput {
  runId: string;
  command: string;
  cwd: string;
  companyId: string;
}

describe("local CLI adapters launch through the common runner under the isolation policy", () => {
  let root: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-adapter-isolation-"));
    for (const key of ["HOME", "PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_IN_WORKTREE", "CODEX_HOME"]) {
      saved[key] = process.env[key];
    }
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.CODEX_HOME = path.join(root, "codex-home");
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_IN_WORKTREE;
    await fs.mkdir(process.env.CODEX_HOME, { recursive: true });
    await fs.writeFile(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    await fs.writeFile(path.join(process.env.CODEX_HOME, "config.toml"), 'model = "codex-mini-latest"\n');
  });

  afterEach(async () => {
    resetAgentProcessIsolation();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  async function prepare(script: string, commandName: string, mode: "off" | "systemd") {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace, { recursive: true });
    const command = path.join(root, commandName);
    await fs.writeFile(command, script, { mode: 0o755 });
    const argvLog = path.join(root, "helper-argv");
    const stubHelper = path.join(root, "stub-helper");
    await fs.writeFile(stubHelper, STUB_HELPER(argvLog), { mode: 0o755 });
    if (mode === "systemd") {
      const policy = createSystemdIsolationPolicy({
        slice: "app-agents.slice",
        instanceId: "adaptertest",
        registryDir: path.join(root, "registry"),
        helperPath: stubHelper,
        userBusAddress: "unix:path=/run/user/0/bus",
      });
      const health = new IsolationHealth(policy, {
        logger: { warn: () => {}, info: () => {} },
        probe: async () => ({ ok: true }),
        setTimer: () => ({}),
        clearTimer: () => {},
      });
      configureAgentProcessIsolation({ policy, health });
    }
    return { workspace, command, argvLog, stubHelper };
  }

  for (const adapter of ADAPTERS) {
    it(`${adapter.name}: the launch is wrapped by the helper with the configured slice and the real command`, async () => {
      const { workspace, command, argvLog } = await prepare(adapter.script, adapter.commandName, "systemd");
      const result = await adapter.run({ runId: randomUUID(), command, cwd: workspace, companyId: randomUUID() });

      expect(result.exitCode).toBe(0);
      const argv = (await fs.readFile(argvLog, "utf8")).trim().split("\n");
      expect(argv[argv.indexOf("--slice") + 1]).toBe("app-agents.slice");
      expect(argv[argv.indexOf("--unit") + 1]).toContain(scopeUnitNamespace("adaptertest"));
      expect(argv[argv.indexOf("--user-bus") + 1]).toBe("unix:path=/run/user/0/bus");
      const target = argv.slice(argv.indexOf("--") + 1);
      expect(await fs.realpath(target[0]!)).toBe(await fs.realpath(command));
    });

    it(`${adapter.name}: with isolation off the helper is never involved`, async () => {
      const { workspace, command, argvLog } = await prepare(adapter.script, adapter.commandName, "off");
      const result = await adapter.run({ runId: randomUUID(), command, cwd: workspace, companyId: randomUUID() });

      expect(result.exitCode).toBe(0);
      await expect(fs.access(argvLog)).rejects.toThrow();
    });
  }
});
