import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const SAVED_KEYS = ["NOTIFY_SOCKET", "PAPERCLIP_SERVICE_MANAGED", "VITEST"] as const;
const saved: Record<string, string | undefined> = {};

async function loadWith(env: Partial<Record<(typeof SAVED_KEYS)[number], string>>) {
  for (const key of SAVED_KEYS) {
    const value = env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return await import("../services/systemd-notify.js");
}

describe("systemdNotify", () => {
  beforeEach(() => {
    for (const key of SAVED_KEYS) saved[key] = process.env[key];
    execFileMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null));
  });

  afterEach(() => {
    for (const key of SAVED_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("does nothing when NOTIFY_SOCKET is unset", async () => {
    const { systemdNotify } = await loadWith({ PAPERCLIP_SERVICE_MANAGED: "1" });
    expect(await systemdNotify(["--ready"])).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does nothing when PAPERCLIP_SERVICE_MANAGED is not 1", async () => {
    const { systemdNotify } = await loadWith({ NOTIFY_SOCKET: "/run/systemd/notify" });
    expect(await systemdNotify(["--ready"])).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("does nothing under VITEST", async () => {
    const { systemdNotify } = await loadWith({
      NOTIFY_SOCKET: "/run/systemd/notify",
      PAPERCLIP_SERVICE_MANAGED: "1",
      VITEST: "true",
    });
    expect(await systemdNotify(["--ready"])).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("passes the captured socket explicitly and removes it from process.env", async () => {
    const { systemdNotify } = await loadWith({
      NOTIFY_SOCKET: "/run/systemd/notify",
      PAPERCLIP_SERVICE_MANAGED: "1",
    });
    expect(process.env.NOTIFY_SOCKET).toBeUndefined();

    expect(await systemdNotify(["--ready", "--status=up"])).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe("systemd-notify");
    expect(args).toEqual(["--ready", "--status=up"]);
    expect(opts.env.NOTIFY_SOCKET).toBe("/run/systemd/notify");
    expect(process.env.NOTIFY_SOCKET).toBeUndefined();
  });
});
