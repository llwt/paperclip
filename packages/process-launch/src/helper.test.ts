import { spawn, type SpawnOptions, type StdioOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { afterEach, describe, expect, inject, it } from "vitest";
import { spawnIsolated, type LaunchHandle, type LaunchTarget } from "./launch.js";
import type { SystemdIsolationPolicy } from "./policy.js";
import { readProcCgroup, readProcStat } from "./proc.js";
import { listScopeRecordRefs } from "./registry.js";
import { terminateOwnedProcessTree } from "./terminate.js";
import { collect, nodeTarget, tempDirs, testPolicy } from "./test-support.js";
import { scopeUnitNamespace } from "./unit-names.js";

const helper = inject("scopeHelper");
const helperSkip = inject("scopeHelperSkipReason");
const systemdSkip = inject("systemdSkipReason");
const testSlice = inject("testSlice");
const owner = { kind: "run", id: "run-helper-test", companyId: "company-a" } as const;
const temp = tempDirs();

interface Mode {
  name: "degraded" | "enrolled";
  skip: string | null;
  policy(registryDir: string): SystemdIsolationPolicy;
}

const instanceId = `pcltest-${randomBytes(4).toString("hex")}`;
const modes: Mode[] = [
  {
    name: "degraded",
    skip: helperSkip,
    policy: (registryDir) => testPolicy({ registryDir, instanceId, helperPath: helper }),
  },
  {
    name: "enrolled",
    skip: helperSkip ?? systemdSkip,
    policy: (registryDir) =>
      testPolicy({
        registryDir,
        instanceId,
        helperPath: helper,
        slice: testSlice,
        userBusAddress: `unix:path=/run/user/${process.getuid?.()}/bus`,
      }),
  },
];

let registries: string[] = [];
afterEach(async () => {
  // Leave no owned process or scope behind, whatever a test did.
  for (const registryDir of registries) {
    for (const ref of listScopeRecordRefs(registryDir, scopeUnitNamespace(instanceId))) {
      await terminateOwnedProcessTree(ref, { instanceId, graceMs: 200, killWaitMs: 2_000 });
    }
  }
  registries = [];
  temp.cleanup();
});

function readStream(stream: Readable | null | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve) => {
    if (!stream) return resolve(Buffer.alloc(0));
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Reports the target's identity on descriptor 3, so stdout stays free.
const REPORT = `
const fs = require("fs");
const stat = fs.readFileSync("/proc/self/stat", "utf8");
const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
fs.writeSync(3, JSON.stringify({
  pid: process.pid,
  pgid: Number(fields[2]),
  sid: Number(fields[3]),
  cwd: process.cwd(),
  argv: process.argv.slice(1),
  argv0: process.argv0,
  env: process.env,
  fds: fs.readdirSync("/proc/self/fd").map(Number).sort((a, b) => a - b),
  cgroup: fs.readFileSync("/proc/self/cgroup", "utf8"),
}));
try { fs.writeSync(5, "five"); } catch (error) { fs.writeSync(3, "|no-fd-5"); }
`;

interface Report {
  pid: number;
  pgid: number;
  sid: number;
  cwd: string;
  argv: string[];
  argv0: string;
  env: Record<string, string>;
  fds: number[];
  cgroup: string;
}

async function runReport(
  mode: Mode | null,
  args: string[],
  options: SpawnOptions,
): Promise<{ report: Report; pid: number; launch: LaunchHandle | null; extra: string; code: number | null }> {
  const stdio: StdioOptions = ["pipe", "pipe", "pipe", "pipe", "ignore", "pipe"];
  const target: LaunchTarget = { ...nodeTarget(REPORT, args), options: { ...options, stdio } };
  let child;
  let launch: LaunchHandle | null = null;
  if (mode) {
    const registryDir = temp.make();
    registries.push(registryDir);
    ({ child, launch } = spawnIsolated(target, { policy: mode.policy(registryDir), owner }));
  } else {
    child = spawn(target.command, target.args!, target.options!);
  }
  const [report, five, result] = await Promise.all([
    readStream(child.stdio[3] as Readable),
    // ChildProcess types only five stdio slots; descriptor 5 exists at runtime.
    readStream((child.stdio as unknown as Readable[])[5]),
    collect(child),
  ]);
  return {
    report: JSON.parse(report.toString()) as Report,
    pid: child.pid!,
    launch,
    extra: five.toString(),
    code: result.code,
  };
}

function expectOutcome(mode: Mode, launch: LaunchHandle | null) {
  const enrollment = launch?.readEnrollment();
  expect(enrollment?.outcome).toBe(mode.name);
  return enrollment!;
}

for (const mode of modes) {
  describe.skipIf(mode.skip !== null)(`helper exec (${mode.name})${mode.skip ? `: skipped, ${mode.skip}` : ""}`, () => {
    it("keeps PID, process group, cwd, argv, env and descriptor numbers", async () => {
      const cwd = path.join(temp.make(), "dir with space $x");
      mkdirSync(cwd);
      const args = ["a b", "$HOME", "$(echo no)", "", "tab\tnewline\n", `'"\\`];
      const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", ODD: "$HOME ${X} `x`\n", EMPTY: "" };
      for (const detached of [false, true]) {
        const options = { cwd, env, detached };
        const direct = await runReport(null, args, options);
        const wrapped = await runReport(mode, args, options);
        expectOutcome(mode, wrapped.launch);
        expect(wrapped.code).toBe(0);
        expect(wrapped.report.pid).toBe(wrapped.pid);
        expect(wrapped.report.cwd).toBe(cwd);
        expect(wrapped.report.argv).toEqual(args);
        expect(wrapped.report.argv0).toBe(direct.report.argv0);
        expect(wrapped.report.env).toEqual(env);
        expect(wrapped.report.fds).toEqual(direct.report.fds);
        expect(wrapped.report.fds).toContain(3);
        expect(wrapped.report.fds).toContain(5);
        expect(wrapped.extra).toBe("five");
        if (detached) {
          expect(wrapped.report.pgid).toBe(wrapped.pid);
          expect(wrapped.report.sid).toBe(wrapped.pid);
        } else {
          expect(wrapped.report.pgid).toBe(readProcStat(process.pid)!.pgrp);
          expect(wrapped.report.sid).toBe(direct.report.sid);
        }
      }
    });

    it("runs the first workload action in the expected cgroup", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const { child, launch } = spawnIsolated(
        { command: "cat", args: ["/proc/self/cgroup"] },
        { policy: mode.policy(registryDir), owner },
      );
      const result = await collect(child);
      const enrollment = expectOutcome(mode, launch);
      const seen = result.stdout.toString().trim();
      if (mode.name === "enrolled") {
        expect(seen).toBe(`0::${enrollment.cgroup}`);
        expect(enrollment.cgroup!.endsWith(`${testSlice}/${launch.isolation.state === "requested" && launch.isolation.unit}`)).toBe(
          true,
        );
      } else {
        expect(seen).toBe(`0::${readProcCgroup("self")}`);
      }
    });

    it("keeps stdin, stdout and stderr byte-exact and silent when the target is", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const payload = randomBytes(512 * 1024);
      const errBytes = Buffer.from([0, 255, 10, 13, 27, 0x80]);
      const { child } = spawnIsolated(
        nodeTarget(`process.stderr.write(Buffer.from(${JSON.stringify([...errBytes])})); process.stdin.pipe(process.stdout);`),
        { policy: mode.policy(registryDir), owner },
      );
      child.stdin!.end(payload);
      const result = await collect(child);
      expect(result.code).toBe(0);
      expect(result.stdout.equals(payload)).toBe(true);
      expect(result.stderr.equals(errBytes)).toBe(true);

      const quiet = spawnIsolated({ command: "true" }, { policy: mode.policy(registryDir), owner });
      const silent = await collect(quiet.child);
      expect(silent.stdout.length + silent.stderr.length).toBe(0);
    });

    it("keeps the IPC channel", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const { child } = spawnIsolated(
        { ...nodeTarget(`process.on("message", (m) => { process.send({ echo: m }); process.disconnect(); });`), options: { stdio: ["pipe", "pipe", "pipe", "ipc"] } },
        { policy: mode.policy(registryDir), owner },
      );
      const reply = new Promise((resolve) => child.once("message", resolve));
      child.send({ hello: "ipc" });
      expect(await reply).toEqual({ echo: { hello: "ipc" } });
      await collect(child);
    });

    it("reports target exits apart from helper setup errors", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const policy = mode.policy(registryDir);
      const exit7 = spawnIsolated({ command: "sh", args: ["-c", "exit 7"] }, { policy, owner });
      const r7 = await collect(exit7.child);
      expect(exit7.launch.classifyExit(r7.code, r7.signal)).toEqual({ kind: "target", code: 7, signal: null });

      const exit127 = spawnIsolated({ command: "sh", args: ["-c", "exit 127"] }, { policy, owner });
      const r127 = await collect(exit127.child);
      expect(exit127.launch.classifyExit(r127.code, r127.signal)).toEqual({ kind: "target", code: 127, signal: null });

      const signalled = spawnIsolated({ command: "sh", args: ["-c", "kill -TERM $$"] }, { policy, owner });
      const rs = await collect(signalled.child);
      expect(signalled.launch.classifyExit(rs.code, rs.signal)).toEqual({ kind: "target", code: null, signal: "SIGTERM" });

      const missing = spawnIsolated({ command: "paperclip-no-such-provider-binary" }, { policy, owner });
      const rm = await collect(missing.child);
      expect(rm.stdout.length + rm.stderr.length).toBe(0);
      expect(missing.launch.classifyExit(rm.code, rm.signal)).toEqual({
        kind: "target_exec_failed",
        error: "ENOENT",
        code: 127,
      });
    });

    it("runs shell targets through the same shell an unwrapped spawn uses", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const options = { shell: true, env: { PATH: process.env.PATH ?? "", V: "x y" } };
      const command = 'echo "$V" $0';
      const direct = await collect(spawn(command, [], options));
      const wrapped = spawnIsolated({ command, options }, { policy: mode.policy(registryDir), owner });
      const result = await collect(wrapped.child);
      expect(result.stdout.toString()).toBe(direct.stdout.toString());
      expect(result.stdout.toString()).toBe("x y /bin/sh\n");
    });

    it("runs an executable script without a #! line like an unwrapped spawn", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const bin = temp.make();
      const script = path.join(bin, "no-shebang-target");
      writeFileSync(script, 'printf "%s|" "$0" "$@"; echo target-ran\n', { mode: 0o700 });
      const policy = mode.policy(registryDir);
      const forms: LaunchTarget[] = [
        { command: script, args: ["a b", "$x"], options: { argv0: "custom0" } },
        { command: "no-shebang-target", args: ["a b"], options: { env: { PATH: `/nonexistent:${bin}` } } },
      ];
      for (const target of forms) {
        const direct = await collect(spawn(target.command, target.args ?? [], target.options ?? {}));
        expect(direct.code).toBe(0);
        const wrapped = spawnIsolated(target, { policy, owner });
        const result = await collect(wrapped.child);
        expect(result.stdout.toString()).toBe(direct.stdout.toString());
        expect(result.stdout.toString()).toBe(`${script}|${(target.args ?? []).join("|")}|target-ran\n`);
        expect(result.stderr.toString()).toBe(direct.stderr.toString());
        expect(wrapped.launch.classifyExit(result.code, result.signal)).toEqual({ kind: "target", code: 0, signal: null });
      }
    });

    it("writes a versioned status with identity only", async () => {
      const registryDir = temp.make();
      registries.push(registryDir);
      const { child, launch } = spawnIsolated(
        { command: "sh", args: ["-c", "true", "SECRET-ARG"], options: { env: { PATH: "/usr/bin:/bin", TOKEN: "SECRET-ENV" } } },
        { policy: mode.policy(registryDir), owner },
      );
      await collect(child);
      const enrollment = launch.readEnrollment()!;
      expect(enrollment).toMatchObject({ version: 1, kind: "paperclip-scope-exec-status", pid: child.pid });
      expect(enrollment.pidStartTime).toMatch(/^\d+$/);
      const raw = readFileSync(path.join(registryDir, `${enrollment.unit}.status.json`), "utf8");
      expect(raw).not.toContain("SECRET");
    });
  });
}
