import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

/** Builds the helper if needed, probes the real user manager, and owns a unique test slice. */
export async function prepareLiveIsolation(): Promise<LiveIsolation> {
  const slice = `app-pcltest${randomBytes(4).toString("hex")}.slice`;
  const none = (skip: string): LiveIsolation => ({ helper: null, slice, skip, cleanup: () => {} });
  if (process.platform !== "linux" || !process.getuid) return none("not linux");
  let helper = path.join(processLaunchRoot, "dist", "bin", "paperclip-scope-exec");
  if (!existsSync(helper)) {
    try {
      process.env.CARGO_BUILD_JOBS ??= "2";
      const script = path.join(processLaunchRoot, "scripts", "build-helper.mjs");
      const mod = (await import(pathToFileURL(script).href)) as { buildHelper(o: { stdio: string }): Promise<string | null> };
      const built = await mod.buildHelper({ stdio: "pipe" });
      if (!built) return none("helper not built");
      helper = built;
    } catch (error) {
      return none(`helper build failed: ${String((error as Error).message).split("\n")[0]}`);
    }
  }
  const dir = mkdtempSync(path.join(tmpdir(), "au-probe-"));
  try {
    const status = path.join(dir, "status.json");
    const unit = `pcltest-probe-${randomBytes(8).toString("hex")}.scope`;
    const result = spawnSync(
      helper,
      ["--unit", unit, "--slice", slice, "--user-bus", userBusAddress(), "--status-file", status, "--", "true"],
      { timeout: 10_000 },
    );
    const parsed = result.status === 0 ? (JSON.parse(readFileSync(status, "utf8")) as { outcome: string; reason?: string }) : null;
    if (parsed?.outcome !== "enrolled") return none(`user manager unavailable (${parsed?.reason ?? `exit ${result.status}`})`);
  } catch (error) {
    return none(`probe failed: ${(error as Error).message}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    helper,
    slice,
    skip: null,
    cleanup() {
      try {
        execFileSync("systemctl", ["--user", "stop", slice], { stdio: "ignore", timeout: 15_000 });
      } catch {
        // Already gone.
      }
    },
  };
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
