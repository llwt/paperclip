// Test-only: the real user manager setup for scope fixtures in other packages
// (the package's own tests use scripts/vitest-global-setup.mjs). Builds the
// helper, probes the manager with one owned scope, and gives each caller its
// own uniquely named test slice, which `stop()` stops.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveUserBusAddress } from "./policy.js";

export interface SystemdTestEnv {
  /** The staged helper, or null when it could not be built here. */
  helper: string | null;
  /** An owned, uniquely named slice; every test scope lives below it. */
  slice: string;
  userBusAddress: string | null;
  /** Why real user manager tests must be skipped, or null when they run. */
  skipReason: string | null;
  /** Stop this caller's own test slice. Safe to call more than once. */
  stop(): void;
}

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function buildHelper(): { helper: string | null; reason: string | null } {
  if (process.platform !== "linux") return { helper: null, reason: `unsupported platform ${process.platform}` };
  try {
    execFileSync(process.execPath, [path.join(packageRoot, "scripts", "build-helper.mjs")], {
      cwd: packageRoot,
      stdio: "pipe",
      env: { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "2" },
    });
    return { helper: path.join(packageRoot, "dist", "bin", "paperclip-scope-exec"), reason: null };
  } catch (error) {
    return { helper: null, reason: `helper build failed: ${String((error as Error).message).split("\n")[0]}` };
  }
}

function probe(helper: string, slice: string, bus: string): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), "pcl-probe-"));
  try {
    const status = path.join(dir, "status.json");
    const unit = `pcltest-probe-${randomBytes(8).toString("hex")}.scope`;
    const result = spawnSync(helper, ["--unit", unit, "--slice", slice, "--user-bus", bus, "--status-file", status, "--", "true"], {
      timeout: 10_000,
    });
    if (result.status !== 0) return `probe exited ${result.status}`;
    const parsed = JSON.parse(readFileSync(status, "utf8")) as { outcome: string; reason: string | null };
    return parsed.outcome === "enrolled" ? null : `user manager unavailable (${parsed.reason})`;
  } catch (error) {
    return `probe failed: ${(error as Error).message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function prepareSystemdTestEnv(): SystemdTestEnv {
  const slice = `app-pcltest${randomBytes(4).toString("hex")}.slice`;
  const userBusAddress = resolveUserBusAddress();
  const { helper, reason } = buildHelper();
  const skipReason = reason ?? (!userBusAddress ? "no user bus address" : probe(helper!, slice, userBusAddress));
  let stopped = false;
  return {
    helper,
    slice,
    userBusAddress,
    skipReason,
    stop() {
      if (stopped || skipReason) return;
      stopped = true;
      try {
        execFileSync("systemctl", ["--user", "stop", slice], { stdio: "ignore", timeout: 15_000 });
      } catch {
        // Already gone.
      }
    },
  };
}
