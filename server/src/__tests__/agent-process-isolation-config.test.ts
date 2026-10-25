import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fileConfig = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock("../config-file.ts", async () => {
  const actual = await vi.importActual<typeof import("../config-file.ts")>("../config-file.ts");
  return { ...actual, readConfigFile: () => fileConfig.value };
});

import { loadConfig } from "../config.ts";

function withIsolation(agentProcessIsolation: Record<string, unknown> | undefined) {
  return {
    $meta: { version: 1, updatedAt: "2026-10-25T00:00:00.000Z", source: "configure" },
    database: { mode: "embedded-postgres", embeddedPostgresPort: 54329, backup: {} },
    logging: { mode: "file" },
    server: { port: 3100, ...(agentProcessIsolation ? { agentProcessIsolation } : {}) },
  };
}

// Agent process isolation decides how agent processes are contained, so its
// settings come only from the instance config file and the server's own
// environment. An unusable value stops the server rather than silently
// running agents without the isolation the operator asked for.
describe("agent process isolation config", () => {
  beforeEach(() => {
    fileConfig.value = null;
    vi.stubEnv("PAPERCLIP_AGENT_PROCESS_ISOLATION", undefined);
    vi.stubEnv("PAPERCLIP_AGENT_SYSTEMD_SLICE", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is off with the app-agents slice by default", () => {
    expect(loadConfig().agentProcessIsolation).toEqual({ mode: "off", slice: "app-agents.slice" });
  });

  it("reads the instance config file", async () => {
    const { paperclipConfigSchema } = await import("@paperclipai/shared");
    fileConfig.value = paperclipConfigSchema.parse(
      withIsolation({ mode: "systemd", slice: "work-agents.slice" }),
    ) as unknown as Record<string, unknown>;
    expect(loadConfig().agentProcessIsolation).toEqual({ mode: "systemd", slice: "work-agents.slice" });
  });

  it("lets the environment override the config file", async () => {
    const { paperclipConfigSchema } = await import("@paperclipai/shared");
    fileConfig.value = paperclipConfigSchema.parse(
      withIsolation({ mode: "systemd", slice: "work-agents.slice" }),
    ) as unknown as Record<string, unknown>;
    vi.stubEnv("PAPERCLIP_AGENT_PROCESS_ISOLATION", "off");
    vi.stubEnv("PAPERCLIP_AGENT_SYSTEMD_SLICE", "other-agents.slice");
    expect(loadConfig().agentProcessIsolation).toEqual({ mode: "off", slice: "other-agents.slice" });
  });

  it("turns isolation on from the environment alone", () => {
    vi.stubEnv("PAPERCLIP_AGENT_PROCESS_ISOLATION", "systemd");
    expect(loadConfig().agentProcessIsolation).toEqual({ mode: "systemd", slice: "app-agents.slice" });
  });

  it("trims environment values and ignores an empty slice", () => {
    vi.stubEnv("PAPERCLIP_AGENT_PROCESS_ISOLATION", " systemd ");
    vi.stubEnv("PAPERCLIP_AGENT_SYSTEMD_SLICE", "  ");
    expect(loadConfig().agentProcessIsolation).toEqual({ mode: "systemd", slice: "app-agents.slice" });
  });

  it("rejects an unknown mode", () => {
    vi.stubEnv("PAPERCLIP_AGENT_PROCESS_ISOLATION", "cgroup");
    expect(() => loadConfig()).toThrow(/PAPERCLIP_AGENT_PROCESS_ISOLATION/);
  });

  it.each(["agents", "-.slice", "a/b.slice", "../x.slice", "bad name.slice", "a--b.slice", "a.b.slice"])(
    "rejects the invalid slice %s when isolation is on",
    (slice) => {
      vi.stubEnv("PAPERCLIP_AGENT_PROCESS_ISOLATION", "systemd");
      vi.stubEnv("PAPERCLIP_AGENT_SYSTEMD_SLICE", slice);
      expect(() => loadConfig()).toThrow(/slice/);
    },
  );

  it("does not reject the slice while isolation is off", () => {
    vi.stubEnv("PAPERCLIP_AGENT_SYSTEMD_SLICE", "not a slice");
    expect(loadConfig().agentProcessIsolation.mode).toBe("off");
  });
});
