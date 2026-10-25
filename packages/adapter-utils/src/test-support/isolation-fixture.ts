import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createSystemdIsolationPolicy,
  IsolationHealth,
  type CapabilityResult,
  type IsolationLogger,
  type SystemdIsolationPolicy,
} from "@paperclipai/process-launch";
import { configureAgentProcessIsolation } from "../process-isolation.js";

const processLaunchRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../process-launch");

export function userBusAddress(): string {
  return `unix:path=${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`}/bus`;
}

export interface LiveIsolation {
  helper: string | null;
  slice: string;
  /** Why live user manager cases cannot run here, or null when they can. */
  skip: string | null;
  cleanup(): void;
}

const SYSTEMCTL_PROBE_TIMEOUT_MS = 2_000;
const HELPER_PROBE_TIMEOUT_MS = 4_000;

/** Probes the real user manager with short timeouts and owns a unique test slice. Never builds the helper; a missing one skips the live cases. */
export async function prepareLiveIsolation(): Promise<LiveIsolation> {
  const slice = `app-pcltest${randomBytes(4).toString("hex")}.slice`;
  const none = (skip: string): LiveIsolation => ({ helper: null, slice, skip, cleanup: () => {} });
  if (process.platform !== "linux" || !process.getuid) return none("not linux");
  const helper = path.join(processLaunchRoot, "dist", "bin", "paperclip-scope-exec");
  if (!existsSync(helper)) return none("helper binary not built (run the process-launch build)");
  const busPath = userBusAddress().replace(/^unix:path=/, "");
  if (!existsSync(busPath)) return none(`no systemd user bus at ${busPath}`);
  const systemctl = spawnSync("systemctl", ["--version"], { timeout: SYSTEMCTL_PROBE_TIMEOUT_MS, stdio: "ignore" });
  if (systemctl.error || systemctl.status !== 0) return none("systemctl not available");
  const dir = mkdtempSync(path.join(tmpdir(), "au-probe-"));
  let probeRan = false;
  try {
    const status = path.join(dir, "status.json");
    const unit = `pcltest-probe-${randomBytes(8).toString("hex")}.scope`;
    probeRan = true;
    const result = spawnSync(
      helper,
      ["--unit", unit, "--slice", slice, "--user-bus", userBusAddress(), "--status-file", status, "--", "true"],
      { timeout: HELPER_PROBE_TIMEOUT_MS },
    );
    const parsed = result.status === 0 ? (JSON.parse(readFileSync(status, "utf8")) as { outcome: string; reason?: string }) : null;
    if (parsed?.outcome !== "enrolled") {
      stopUserSlice(slice);
      return none(`user manager unavailable (${parsed?.reason ?? (result.error ? result.error.message : `exit ${result.status}`)})`);
    }
  } catch (error) {
    if (probeRan) stopUserSlice(slice);
    return none(`probe failed: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    helper,
    slice,
    skip: null,
    cleanup() {
      stopUserSlice(slice);
    },
  };
}

function userManagerEnv(): NodeJS.ProcessEnv {
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.()}`;
  return { ...process.env, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: userBusAddress() };
}

function sliceIsActive(slice: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", slice], { env, timeout: SYSTEMCTL_PROBE_TIMEOUT_MS }).status === 0;
}

/** Stops a test slice and throws if it is still active, so a leaked unit fails the run instead of piling up. */
function stopUserSlice(slice: string): void {
  const env = userManagerEnv();
  if (!sliceIsActive(slice, env)) return;
  const stop = spawnSync("systemctl", ["--user", "stop", slice], { env, timeout: 5_000, encoding: "utf8" });
  if (sliceIsActive(slice, env)) {
    throw new Error(`test slice ${slice} is still active after stop (exit ${stop.status}): ${stop.stderr?.trim() ?? ""}`);
  }
}

export interface RecordedLogger extends IsolationLogger {
  warnings: Array<{ fields: Record<string, unknown>; message: string }>;
  infos: Array<{ fields: Record<string, unknown>; message: string }>;
}

export function recordedLogger(): RecordedLogger {
  const warnings: RecordedLogger["warnings"] = [];
  const infos: RecordedLogger["infos"] = [];
  return {
    warnings,
    infos,
    warn: (fields, message) => void warnings.push({ fields, message }),
    info: (fields, message) => void infos.push({ fields, message }),
  };
}

export interface ConfiguredIsolation {
  policy: SystemdIsolationPolicy;
  health: IsolationHealth;
  logger: RecordedLogger;
}

/** Install a systemd policy as the host policy. The health probe is stubbed; no real check runs. */
export function configureTestIsolation(options: {
  registryDir: string;
  helperPath: string | null;
  slice: string;
  probe?: () => Promise<CapabilityResult>;
  enrollmentDeadlineMs?: number;
  userBus?: string;
}): ConfiguredIsolation {
  const policy = createSystemdIsolationPolicy({
    slice: options.slice,
    instanceId: "autest",
    registryDir: options.registryDir,
    helperPath: options.helperPath,
    userBusAddress: options.userBus ?? userBusAddress(),
    ...(options.enrollmentDeadlineMs ? { enrollmentDeadlineMs: options.enrollmentDeadlineMs } : {}),
  });
  const logger = recordedLogger();
  const health = new IsolationHealth(policy, {
    logger,
    probe: options.probe ?? (async () => ({ ok: true })),
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  configureAgentProcessIsolation({ policy, health });
  return { policy, health, logger };
}
