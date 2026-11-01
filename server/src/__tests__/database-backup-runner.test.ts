import { describe, expect, it } from "vitest";
import {
  createExclusiveBackupRunner,
  DEFAULT_DATABASE_BACKUP_TIMEOUT_MINUTES,
  MAX_DATABASE_BACKUP_TIMEOUT_MS,
  resolveDatabaseBackupTimeoutMs,
} from "../services/database-backup-runner.js";

describe("resolveDatabaseBackupTimeoutMs", () => {
  const defaultMs = DEFAULT_DATABASE_BACKUP_TIMEOUT_MINUTES * 60_000;

  it("defaults to 30 minutes", () => {
    expect(defaultMs).toBe(30 * 60_000);
    expect(resolveDatabaseBackupTimeoutMs(undefined)).toBe(defaultMs);
  });

  it.each(["", "abc", "0", "-5", "NaN", "Infinity"])("uses the default for %j", (raw) => {
    expect(resolveDatabaseBackupTimeoutMs(raw)).toBe(defaultMs);
  });

  it("converts a positive number of minutes", () => {
    expect(resolveDatabaseBackupTimeoutMs("45")).toBe(45 * 60_000);
    expect(resolveDatabaseBackupTimeoutMs("0.5")).toBe(30_000);
  });

  it("uses the default when the milliseconds exceed the setTimeout limit", () => {
    expect(resolveDatabaseBackupTimeoutMs("100000")).toBe(defaultMs);
    expect(resolveDatabaseBackupTimeoutMs("35792")).toBe(defaultMs);
  });

  it("accepts the largest value setTimeout can hold", () => {
    expect(MAX_DATABASE_BACKUP_TIMEOUT_MS).toBe(2_147_483_647);
    expect(resolveDatabaseBackupTimeoutMs("35791")).toBe(35791 * 60_000);
    expect(resolveDatabaseBackupTimeoutMs(String(MAX_DATABASE_BACKUP_TIMEOUT_MS / 60_000))).toBe(
      MAX_DATABASE_BACKUP_TIMEOUT_MS,
    );
  });
});

describe("createExclusiveBackupRunner", () => {
  it("skips a second call while the first runs and reports when it started", async () => {
    let nowMs = Date.parse("2026-11-01T04:38:00Z");
    const runner = createExclusiveBackupRunner(() => nowMs);
    let finish!: (value: string) => void;
    const first = runner.run("scheduled", () => new Promise<string>((resolve) => { finish = resolve; }));

    nowMs += 7 * 60_000;
    const second = await runner.run("scheduled", async () => "never");
    expect(second).toMatchObject({ started: false, runningMinutes: 7, running: { trigger: "scheduled" } });
    expect(second.started === false && second.running.startedAt.toISOString()).toBe("2026-11-01T04:38:00.000Z");

    finish("done");
    expect(await first).toEqual({ started: true, value: "done" });
    expect(await runner.run("manual", async () => "again")).toEqual({ started: true, value: "again" });
  });

  it("frees the slot after a timed out backup so the next scheduled call runs", async () => {
    const runner = createExclusiveBackupRunner();
    const hung = runner.run("scheduled", () => new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Database backup timed out after 30 minutes")), 20);
    }));
    expect((await runner.run("scheduled", async () => "skipped")).started).toBe(false);
    await expect(hung).rejects.toThrow("timed out after 30 minutes");

    expect(await runner.run("scheduled", async () => "ran")).toEqual({ started: true, value: "ran" });
  });
});
