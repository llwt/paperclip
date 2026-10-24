import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("drops the systemd notify, watchdog and socket-activation variables", () => {
    expect(sanitizeInheritedPaperclipEnv({
      NOTIFY_SOCKET: "/run/systemd/notify",
      WATCHDOG_USEC: "1000000",
      WATCHDOG_PID: "123",
      LISTEN_FDS: "1",
      LISTEN_PID: "123",
      LISTEN_FDNAMES: "http",
      HOME: "/home/agent",
      PATH: "/usr/bin",
    })).toEqual({
      HOME: "/home/agent",
      PATH: "/usr/bin",
    });
  });
});
