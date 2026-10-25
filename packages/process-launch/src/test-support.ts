// Test-only helpers shared by the package's own tests.
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSystemdIsolationPolicy, type SystemdIsolationPolicyInput } from "./policy.js";
import { readProcCgroup, userManagerCgroup } from "./proc.js";

export interface Collected {
  stdout: Buffer;
  stderr: Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function collect(child: ChildProcess): Promise<Collected> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code, signal }),
    );
  });
}

export function tempDirs() {
  const dirs: string[] = [];
  return {
    make(prefix = "pcl-test-"): string {
      const dir = mkdtempSync(path.join(tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },
    cleanup(): void {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function testPolicy(overrides: Partial<SystemdIsolationPolicyInput> & { registryDir: string }) {
  return createSystemdIsolationPolicy({
    slice: "app-agents.slice",
    instanceId: "pcltest",
    userBusAddress: "unix:path=/nonexistent/paperclip-test-bus",
    ...overrides,
  });
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Why the helper's local pre-checks (user manager cgroup and CPU
 * controller) cannot pass on this machine, or null when they can. Fake
 * busctl tests need them to pass.
 */
export function preflightSkipReason(): string | null {
  if (process.platform !== "linux") return "not Linux";
  const own = readProcCgroup("self");
  const uid = process.getuid?.();
  if (!own || uid === undefined) return "no cgroup v2 membership";
  const manager = userManagerCgroup(own, uid);
  if (!manager) return "tests do not run below this user's systemd manager";
  try {
    const controllers = readFileSync(`/sys/fs/cgroup${manager}/cgroup.subtree_control`, "utf8");
    if (!controllers.split(/\s+/).includes("cpu")) return "user manager has no CPU controller";
  } catch {
    return "user manager cgroup is unreadable";
  }
  return null;
}

/** A Node one-liner target. */
export function nodeTarget(script: string, args: string[] = []) {
  return { command: process.execPath, args: ["-e", script, ...args] };
}

export async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
