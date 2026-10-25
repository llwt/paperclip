import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { resolveHelperPath } from "./helper-path.js";
import type { SystemdIsolationPolicy } from "./policy.js";
import { readProcCgroup, userManagerCgroup } from "./proc.js";
import { isValidSliceName } from "./unit-names.js";

export type CapabilityFailureReason =
  | "unsupported_platform"
  | "invalid_slice"
  | "helper_missing"
  | "busctl_missing"
  | "not_under_user_manager"
  | "cpu_controller_unavailable"
  | "user_bus_unconfigured"
  | "user_bus_unsupported_address"
  | "user_bus_unavailable"
  | "user_manager_unreachable"
  | "slice_unavailable"
  | "probe_failed";

export type CapabilityResult =
  | { ok: true }
  | { ok: false; reason: CapabilityFailureReason; detail?: string };

export interface BusctlRunResult {
  code: number | null;
  stderr: string;
}

export interface CapabilityDeps {
  platform?: NodeJS.Platform;
  uid?: number | null;
  procRoot?: string;
  cgroupRoot?: string;
  /** Runs the policy's busctl with a minimal environment and a hard timeout. */
  runBusctl?: (busctlPath: string, args: string[], userBusAddress: string, timeoutMs: number) => Promise<BusctlRunResult>;
  probeTimeoutMs?: number;
}

export const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

function runBusctlProcess(
  busctlPath: string,
  args: string[],
  userBusAddress: string,
  timeoutMs: number,
): Promise<BusctlRunResult> {
  return new Promise((resolve) => {
    execFile(
      busctlPath,
      args,
      {
        env: { DBUS_SESSION_BUS_ADDRESS: userBusAddress, PATH: "/usr/bin:/bin", LC_ALL: "C" },
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, _stdout, stderr) => {
        if (!error) return resolve({ code: 0, stderr: "" });
        const code = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
          ? ((error as unknown as { code: number }).code)
          : null;
        resolve({ code, stderr: String(stderr ?? error.message).slice(0, 200) });
      },
    );
  });
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function plainUserBusSocket(address: string): string | null {
  const socket = address.startsWith("unix:path=") ? address.slice("unix:path=".length) : null;
  if (!socket || !socket.startsWith("/") || socket.includes(",") || socket.includes(";")) return null;
  return socket;
}

function hasCpuController(cgroupRoot: string, manager: string): boolean {
  try {
    return readFileSync(`${cgroupRoot}${manager}/cgroup.subtree_control`, "utf8")
      .split(/\s+/)
      .includes("cpu");
  } catch {
    return false;
  }
}

const SYSTEMD_BUS = [
  "org.freedesktop.systemd1",
  "/org/freedesktop/systemd1",
  "org.freedesktop.systemd1.Manager",
] as const;

/**
 * Read-only check of everything a launch needs: the helper binary, busctl,
 * the same-UID user manager and its bus, the configured slice and the CPU
 * controller. It starts no unit and moves no process. The first failing
 * check names the reason; the reasons for checks the helper repeats at
 * launch time use the helper's own words.
 */
export async function probeSystemdCapability(
  policy: SystemdIsolationPolicy,
  deps: CapabilityDeps = {},
): Promise<CapabilityResult> {
  if ((deps.platform ?? process.platform) !== "linux") return { ok: false, reason: "unsupported_platform" };
  if (!isValidSliceName(policy.slice)) return { ok: false, reason: "invalid_slice" };
  if (!resolveHelperPath(policy.helperPath)) return { ok: false, reason: "helper_missing" };
  if (!isExecutableFile(policy.busctlPath)) return { ok: false, reason: "busctl_missing" };

  const procRoot = deps.procRoot ?? "/proc";
  const uid = deps.uid === undefined ? (process.getuid?.() ?? null) : deps.uid;
  const own = readProcCgroup("self", procRoot);
  const manager = own && uid !== null ? userManagerCgroup(own, uid) : null;
  if (!manager) return { ok: false, reason: "not_under_user_manager" };
  if (!hasCpuController(deps.cgroupRoot ?? "/sys/fs/cgroup", manager)) {
    return { ok: false, reason: "cpu_controller_unavailable" };
  }

  if (!policy.userBusAddress) return { ok: false, reason: "user_bus_unconfigured" };
  const socket = plainUserBusSocket(policy.userBusAddress);
  if (!socket) return { ok: false, reason: "user_bus_unsupported_address" };
  if (!isSocket(socket)) return { ok: false, reason: "user_bus_unavailable" };

  const run = deps.runBusctl ?? runBusctlProcess;
  const timeoutMs = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const busctl = (args: string[]) =>
    run(policy.busctlPath, ["--user", `--timeout=${timeoutMs}ms`, ...args], policy.userBusAddress as string, timeoutMs + 500);

  const version = await busctl(["get-property", ...SYSTEMD_BUS, "Version"]);
  if (version.code !== 0) return { ok: false, reason: "user_manager_unreachable", detail: version.stderr };

  // The slice need not be active: a transient scope starts it from its unit
  // file. A name with neither an active unit nor a unit file would be created
  // implicitly with default weights, which is not the low-priority slice.
  const active = await busctl(["call", ...SYSTEMD_BUS, "GetUnit", "s", policy.slice]);
  if (active.code !== 0) {
    const file = await busctl(["call", ...SYSTEMD_BUS, "GetUnitFileState", "s", policy.slice]);
    if (file.code !== 0) return { ok: false, reason: "slice_unavailable", detail: file.stderr };
  }
  return { ok: true };
}

function isSocket(file: string): boolean {
  try {
    return statSync(file).isSocket();
  } catch {
    return false;
  }
}
