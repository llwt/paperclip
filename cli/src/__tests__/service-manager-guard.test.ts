import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { takeBlockedServiceManagerCalls } from "./helpers/service-manager-guard.js";
import { defaultCommandRunner, detectServiceManager } from "../services/service-manager.js";

describe("service manager guard", () => {
  // Each test here trips the guard on purpose; take the record so the guard's
  // own afterEach does not fail the test.
  afterEach(() => {
    takeBlockedServiceManagerCalls();
  });

  it("blocks the default command runner before it reaches systemctl", async () => {
    await expect(defaultCommandRunner("systemctl", ["--user", "stop", "paperclipai.service"]))
      .rejects.toThrow("Blocked service manager command in a test");
    await expect(defaultCommandRunner("journalctl", ["--user"], { inherit: true }))
      .rejects.toThrow("Blocked service manager command in a test");
    expect(takeBlockedServiceManagerCalls()).toEqual([
      "systemctl --user stop paperclipai.service",
      "journalctl --user",
    ]);
  });

  it("records a call even when the caller swallows the error", async () => {
    const detection = await detectServiceManager({ platform: "linux", instanceId: "default" });
    expect(detection.supported).toBe(false);
    expect(takeBlockedServiceManagerCalls()).toEqual(["systemctl --user show-environment"]);
  });

  it("blocks every child_process entry point and absolute paths", async () => {
    expect(() => execFileSync("/usr/bin/systemctl", ["--user", "daemon-reload"])).toThrow("Blocked");
    expect(() => spawnSync("launchctl", ["bootout", "gui/501/ing.paperclip.paperclipai"])).toThrow("Blocked");
    expect(() => execFile("loginctl", ["enable-linger", "someone"], () => undefined)).toThrow("Blocked");
    await expect(promisify(execFile)("systemctl", ["--user", "disable", "paperclipai.service"])).rejects.toThrow("Blocked");
    expect(takeBlockedServiceManagerCalls()).toHaveLength(4);
  });

  it("leaves other commands alone", () => {
    expect(execFileSync(process.execPath, ["-p", "1 + 1"], { encoding: "utf8" }).trim()).toBe("2");
    expect(takeBlockedServiceManagerCalls()).toEqual([]);
  });
});
