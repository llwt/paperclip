import { describe, expect, it, vi } from "vitest";
import type { CapabilityResult } from "./capability.js";
import { IsolationHealth, type IsolationLogger } from "./health.js";
import { testPolicy } from "./test-support.js";

function setup(results: CapabilityResult[]) {
  const warn = vi.fn();
  const info = vi.fn();
  const logger: IsolationLogger = { warn, info };
  const timers: { callback: () => void; ms: number; cleared: boolean }[] = [];
  const queue = [...results];
  const probe = vi.fn(async () => queue.shift() ?? queue.at(-1) ?? ({ ok: true } as CapabilityResult));
  const health = new IsolationHealth(testPolicy({ registryDir: "/tmp/pcl-health" }), {
    logger,
    probe,
    backoff: { initialMs: 1_000, maxMs: 4_000 },
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const fire = async () => {
    const timer = timers.filter((t) => !t.cleared).at(-1);
    if (!timer) throw new Error("no timer");
    timer.cleared = true;
    timer.callback();
    await vi.waitFor(() => expect(probe).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { health, warn, info, timers, probe, fire };
}

const FAIL: CapabilityResult = { ok: false, reason: "user_bus_unavailable" };

describe("IsolationHealth", () => {
  it("stays quiet when the startup check passes", async () => {
    const { health, warn, info, timers } = setup([{ ok: true }]);
    await health.start();
    expect(health.shouldAttempt()).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(timers).toHaveLength(0);
  });

  it("warns once with reason, slice and the fallback when the startup check fails", async () => {
    const { health, warn } = setup([FAIL]);
    await health.start();
    expect(health.shouldAttempt()).toBe(false);
    expect(health.currentFailure()).toBe("user_bus_unavailable");
    expect(warn).toHaveBeenCalledTimes(1);
    const [fields, message] = warn.mock.calls[0]!;
    expect(fields).toEqual({ reason: "user_bus_unavailable", slice: "app-agents.slice" });
    expect(message).toContain("user_bus_unavailable");
    expect(message).toContain("app-agents.slice");
    expect(message).toContain("normal execution used");
  });

  it("does not warn again for repeated failures of one episode and backs off to the maximum", async () => {
    const { health, warn, timers, fire } = setup([FAIL, FAIL, FAIL, FAIL, FAIL]);
    await health.start();
    for (let i = 0; i < 4; i += 1) await fire();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(timers.map((t) => t.ms)).toEqual([1_000, 2_000, 4_000, 4_000, 4_000]);
  });

  it("logs recovery once and resumes isolation when the check passes again", async () => {
    const { health, warn, info, fire } = setup([FAIL, { ok: true }]);
    await health.start();
    await fire();
    expect(health.shouldAttempt()).toBe(true);
    expect(health.currentFailure()).toBeNull();
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![1]).toContain("recovered");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("warns again for a new failure episode after recovery", async () => {
    const { health, warn, fire } = setup([FAIL, { ok: true }]);
    await health.start();
    await fire();
    health.observeLaunch({ enrolled: false, reason: "unit_start_failed" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1]![0]).toEqual({ reason: "unit_start_failed", slice: "app-agents.slice" });
  });

  it("opens an episode from a launch failure, retries detection, and recovers on an enrolled launch", async () => {
    const { health, warn, info, timers, fire } = setup([{ ok: true }, { ok: true }]);
    await health.start();
    health.observeLaunch({ enrolled: false, reason: "helper_spawn_failed" });
    health.observeLaunch({ enrolled: false, reason: "helper_spawn_failed" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(health.shouldAttempt()).toBe(false);
    expect(timers).toHaveLength(1);

    // The check cannot see this fault; launches may try again but the episode stays open quietly.
    await fire();
    expect(health.shouldAttempt()).toBe(true);
    expect(info).not.toHaveBeenCalled();
    health.observeLaunch({ enrolled: false, reason: "helper_spawn_failed" });
    expect(warn).toHaveBeenCalledTimes(1);

    health.observeLaunch({ enrolled: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(health.currentFailure()).toBeNull();
  });

  it("treats a throwing probe as a failure instead of rejecting", async () => {
    const warn = vi.fn();
    const health = new IsolationHealth(testPolicy({ registryDir: "/tmp/pcl-health" }), {
      logger: { warn, info: vi.fn() },
      probe: async () => {
        throw new Error("boom");
      },
      setTimer: () => ({}),
      clearTimer: () => {},
    });
    await expect(health.start()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(health.shouldAttempt()).toBe(false);
  });

  it("stops scheduling after stop()", async () => {
    const { health, timers } = setup([FAIL]);
    await health.start();
    health.stop();
    expect(timers.every((t) => t.cleared)).toBe(true);
    health.observeLaunch({ enrolled: false, reason: "x" });
    expect(timers).toHaveLength(1);
  });
});
