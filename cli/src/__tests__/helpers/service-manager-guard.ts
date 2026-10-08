import path from "node:path";
import { promisify } from "node:util";
import { afterEach, vi } from "vitest";

// Loaded for every CLI test file through `setupFiles`. A test must never run
// the host's service manager: with a reachable user bus, `systemctl --user`
// stops, disables and removes the developer's real Paperclip service. Tests
// inject a `detectServiceManager` stub or a command runner instead. A call
// that slips through is blocked here, and the test that made it fails, even
// when the calling code swallows the error (detection and `status()` do).
const guard = vi.hoisted(() => {
  const key = Symbol.for("paperclip.cli.test.serviceManagerGuard");
  const store = globalThis as unknown as Record<symbol, { blocked: string[] } | undefined>;
  const state = store[key] ??= { blocked: [] };
  return {
    state,
    commands: new Set(["systemctl", "loginctl", "journalctl", "launchctl"]),
  };
});

/** Returns the service manager commands blocked since the last call, and forgets them. */
export function takeBlockedServiceManagerCalls(): string[] {
  return guard.state.blocked.splice(0);
}

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");

  const assertAllowed = (command: unknown, args: unknown, shell: boolean) => {
    const text = String(command);
    const executable = shell ? text.trim().split(/\s+/)[0] ?? "" : text;
    if (!guard.commands.has(path.basename(executable))) return;
    const call = [text, ...(Array.isArray(args) ? args.map(String) : [])].join(" ");
    guard.state.blocked.push(call);
    throw new Error(
      `Blocked service manager command in a test: ${call}. Inject a detectServiceManager stub or a command runner instead.`,
    );
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guarded = <T extends (...args: any[]) => unknown>(fn: T, shell = false): T => {
    const wrapper = ((...args: Parameters<T>) => {
      assertAllowed(args[0], args[1], shell);
      return fn(...args);
    }) as T;
    const promisified = (fn as unknown as Record<symbol, ((...args: unknown[]) => unknown) | undefined>)[promisify.custom];
    if (promisified) {
      Object.defineProperty(wrapper, promisify.custom, {
        // The promisified form reports a failure as a rejection, never as a throw.
        value: async (...args: unknown[]) => {
          assertAllowed(args[0], args[1], shell);
          return promisified(...args);
        },
      });
    }
    return wrapper;
  };

  const overrides = {
    execFile: guarded(actual.execFile),
    execFileSync: guarded(actual.execFileSync),
    spawn: guarded(actual.spawn),
    spawnSync: guarded(actual.spawnSync),
    exec: guarded(actual.exec, true),
    execSync: guarded(actual.execSync, true),
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});

afterEach(() => {
  const blocked = takeBlockedServiceManagerCalls();
  if (blocked.length > 0) {
    throw new Error(
      `This test reached the host service manager (blocked): ${blocked.join("; ")}. Inject a detectServiceManager stub or a command runner instead.`,
    );
  }
});
