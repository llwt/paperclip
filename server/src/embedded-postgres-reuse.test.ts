import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import detectPort from "detect-port";
import { describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, prepareEmbeddedPostgresNativeRuntime } from "@paperclipai/db";
import { createReusedEmbeddedPostgresShutdown } from "./embedded-postgres-owner.js";
import { coordinateHeartbeatSchedulerShutdown, finalizeServerShutdown } from "./shutdown.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported && process.platform !== "win32" ? describe : describe.skip;

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describePostgres("reused embedded PostgreSQL shutdown", () => {
  it("stops the reused postmaster after a hot-restart snapshot without stopping an agent process", async () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "paperclip-reused-postmaster-"));
    await prepareEmbeddedPostgresNativeRuntime();
    const postgres = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "paperclip",
      password: "paperclip",
      port: await detectPort(0),
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {},
      onError: () => {},
    });
    let runningPid: number | null = null;
    const agent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    try {
      await postgres.initialise();
      await postgres.start();
      const contents = readFileSync(resolve(dataDir, "postmaster.pid"), "utf8");
      const pid = Number(contents.split("\n")[0]);
      runningPid = pid;
      const stop = createReusedEmbeddedPostgresShutdown(dataDir, contents, pid);
      const snapshot = vi.fn(async () => {
        expect(isAlive(pid)).toBe(true);
        expect(isAlive(agent.pid!)).toBe(true);
        return { skipDrain: true, activeRunIds: ["live-agent"] };
      });
      const shutdown = await coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: snapshot,
        waitForHeartbeatSchedulerIdle: async () => {},
      });
      expect(shutdown.hotRestart).toEqual({ skipDrain: true, activeRunIds: ["live-agent"] });
      await finalizeServerShutdown({
        signal: "SIGTERM",
        shutdownAppServices: undefined,
        closeDatabase: async () => { expect(isAlive(pid)).toBe(true); },
        stopEmbeddedPostgres: stop,
        shutdownInstrumentation: async () => {},
        shutdownSentry: async () => {},
        log: { info: vi.fn(), error: vi.fn() },
      });
      expect(isAlive(pid)).toBe(false);
      expect(isAlive(agent.pid!)).toBe(true);
      expect(existsSync(resolve(dataDir, "postmaster.pid"))).toBe(false);
    } finally {
      const agentExited = once(agent, "exit");
      agent.kill("SIGTERM");
      await agentExited;
      if (runningPid !== null && isAlive(runningPid)) await postgres.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

});

it("leaves a foreign postmaster alone", async () => {
    const dataDir = mkdtempSync(resolve(tmpdir(), "paperclip-foreign-postmaster-"));
    const contents = `${process.pid}\n${dataDir}\n123456\n54330\n`;
    const stop = createReusedEmbeddedPostgresShutdown(dataDir, contents, process.pid);
    writeFileSync(resolve(dataDir, "postmaster.pid"), `${process.pid}\n${dataDir}/foreign\n123456\n54330\n`);
    const signal = vi.spyOn(process, "kill");
    try {
      await expect(stop()).rejects.toThrow("different PostgreSQL data directory");
      expect(signal).not.toHaveBeenCalled();
    } finally {
      signal.mockRestore();
      rmSync(dataDir, { recursive: true, force: true });
    }
});

it.each([
  "124\nDATA_DIR\n123456\n54330\n",
  "123\nDATA_DIR\n123457\n54330\n",
  "123\nDATA_DIR\n123456\n54331\n",
])("refuses a changed postmaster identity at shutdown: %s", async (changed) => {
  const dataDir = mkdtempSync(resolve(tmpdir(), "paperclip-postmaster-identity-"));
  const stop = createReusedEmbeddedPostgresShutdown(dataDir, `123\n${dataDir}\n123456\n54330\n`, 123);
  writeFileSync(resolve(dataDir, "postmaster.pid"), changed.replace("DATA_DIR", dataDir));
  const signal = vi.spyOn(process, "kill");
  try {
    await expect(stop()).rejects.toThrow();
    expect(signal).not.toHaveBeenCalled();
  } finally {
    signal.mockRestore();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

it("does nothing when the reused postmaster already removed its PID file", async () => {
  const dataDir = mkdtempSync(resolve(tmpdir(), "paperclip-stopped-postmaster-"));
  try {
    await createReusedEmbeddedPostgresShutdown(dataDir, `123\n${dataDir}\n123456\n54330\n`, 123)();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
