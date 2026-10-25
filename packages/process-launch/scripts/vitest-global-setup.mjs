import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildHelper } from "./build-helper.mjs";

// Builds the helper once and probes whether this machine has a usable
// systemd user manager. Real-manager tests use only an owned, uniquely
// named test slice, which teardown stops.

function userBusAddress() {
  const configured = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (configured) return configured;
  if (process.env.XDG_RUNTIME_DIR) return `unix:path=${process.env.XDG_RUNTIME_DIR}/bus`;
  return `unix:path=/run/user/${process.getuid()}/bus`;
}

async function buildForTests() {
  if (process.platform !== "linux") return { helper: null, reason: `unsupported platform ${process.platform}` };
  process.env.CARGO_BUILD_JOBS ??= "2";
  try {
    return { helper: await buildHelper({ stdio: "pipe" }), reason: null };
  } catch (error) {
    return { helper: null, reason: `helper build failed: ${String(error.message ?? error).split("\n")[0]}` };
  }
}

function probeManager(helper, slice) {
  if (!helper) return "no helper binary";
  if (!process.getuid) return "no uid";
  const dir = mkdtempSync(path.join(tmpdir(), "pcl-probe-"));
  try {
    const status = path.join(dir, "status.json");
    const unit = `pcltest-probe-${randomBytes(8).toString("hex")}.scope`;
    const result = spawnSync(helper, [
      "--unit", unit, "--slice", slice, "--user-bus", userBusAddress(), "--status-file", status, "--", "true",
    ], { timeout: 10_000 });
    if (result.status !== 0) return `probe exited ${result.status}`;
    const parsed = JSON.parse(readFileSync(status, "utf8"));
    return parsed.outcome === "enrolled" ? null : `user manager unavailable (${parsed.reason})`;
  } catch (error) {
    return `probe failed: ${error.message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export default async function setup({ provide }) {
  const { helper, reason } = await buildForTests();
  const slice = `app-pcltest${randomBytes(4).toString("hex")}.slice`;
  const managerSkip = reason ?? probeManager(helper, slice);
  provide("scopeHelper", helper);
  provide("scopeHelperSkipReason", reason);
  provide("testSlice", slice);
  provide("systemdSkipReason", managerSkip);
  return () => {
    if (managerSkip) return;
    // Stop only this run's own test slice; every test scope lives below it.
    try {
      execFileSync("systemctl", ["--user", "stop", slice], { stdio: "ignore", timeout: 15_000 });
    } catch {
      // Already gone.
    }
  };
}
