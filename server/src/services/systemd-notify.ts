import { execFile } from "node:child_process";

// Captured at module load and removed from process.env so that processes the
// server spawns later (adapters, git, workspace commands) cannot inherit the
// live unit's notify socket and send READY/STOPPING on its behalf.
const notifySocket = process.env.NOTIFY_SOCKET?.trim() || null;
delete process.env.NOTIFY_SOCKET;

export async function systemdNotify(args: string[]): Promise<boolean> {
  if (!notifySocket) return false;
  if (process.env.PAPERCLIP_SERVICE_MANAGED !== "1") return false;
  if (process.env.VITEST) return false;
  return await new Promise<boolean>((resolve) => {
    execFile(
      "systemd-notify",
      args,
      { windowsHide: true, env: { ...process.env, NOTIFY_SOCKET: notifySocket } },
      (error) => resolve(!error),
    );
  });
}
