import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeClient = ReturnType<typeof createFakeClient>;
const clients: FakeClient[] = [];
let behavior: "hang-select" | "hang-copy" | "select-ok" = "hang-select";
let copyStreams: Readable[] = [];
let endRejectsPendingQueries = true;

function createFakeClient(index: number) {
  const pending: Array<(error: Error) => void> = [];
  const neverResolves = () => new Promise<never>((_, reject) => { pending.push(reject); });
  const tag = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (behavior === "hang-select") return neverResolves();
    if (text.includes("FROM information_schema.tables")) {
      return Promise.resolve([{ schema_name: "public", tablename: "things" }]);
    }
    return Promise.resolve([]);
  };
  const client = Object.assign(tag, {
    index,
    end: vi.fn(async () => {
      if (endRejectsPendingQueries) for (const reject of pending) reject(new Error("CONNECTION_DESTROYED"));
    }),
    unsafe: vi.fn((query: string) => {
      if (query.startsWith("SELECT count(*)")) return Promise.resolve([{ n: 1 }]);
      if (query.startsWith("COPY")) {
        const stream = new Readable({ read() {} });
        copyStreams.push(stream);
        return { readable: async () => stream };
      }
      return Promise.resolve([]);
    }),
  });
  return client;
}

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    const client = createFakeClient(clients.length);
    clients.push(client);
    return client;
  }),
}));

const { DatabaseBackupTimeoutError, runDatabaseBackup } = await import("./backup-lib.js");

const retention = { dailyDays: 7, weeklyWeeks: 4, monthlyMonths: 1 };
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-backup-timeout-"));
  clients.length = 0;
  copyStreams = [];
  endRejectsPendingQueries = true;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.PAPERCLIP_PG_DUMP_PATH;
});

describe("runDatabaseBackup timeoutMs", () => {
  it("stops a dump whose query never answers, ends the connection and leaves no files", async () => {
    behavior = "hang-select";
    const started = Date.now();
    const error = await runDatabaseBackup({
      connectionString: "postgres://fake/db",
      backupDir: dir,
      retention,
      backupEngine: "javascript",
      timeoutMs: 100,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DatabaseBackupTimeoutError);
    expect((error as Error).message).toBe("Database backup timed out after 100 ms");
    expect(Date.now() - started).toBeLessThan(900);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(clients).toHaveLength(1);
    expect(clients[0]!.end).toHaveBeenCalledWith({ timeout: 0 });
  });

  it("removes the files itself when the run is stuck and does not settle after the connections are ended", async () => {
    behavior = "hang-select";
    endRejectsPendingQueries = false;
    const error = await runDatabaseBackup({
      connectionString: "postgres://fake/db",
      backupDir: dir,
      retention,
      backupEngine: "javascript",
      timeoutMs: 50,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DatabaseBackupTimeoutError);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("ends the copy connection and destroys the copy stream when a table copy never finishes", async () => {
    behavior = "hang-copy";
    const error = await runDatabaseBackup({
      connectionString: "postgres://fake/db",
      backupDir: dir,
      retention,
      backupEngine: "auto",
      excludeTables: ["public.not_a_table"],
      timeoutMs: 300,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DatabaseBackupTimeoutError);
    expect(clients).toHaveLength(2);
    expect(clients[0]!.end).toHaveBeenCalledWith({ timeout: 0 });
    expect(clients[1]!.end).toHaveBeenCalledWith({ timeout: 0 });
    expect(copyStreams).toHaveLength(1);
    expect(copyStreams[0]!.destroyed).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("kills a hung pg_dump, does not fall back to the JavaScript engine and leaves no partial file", async () => {
    behavior = "select-ok";
    const script = path.join(dir, "..", `fake-pg-dump-${path.basename(dir)}`);
    const pidFile = `${script}.pid`;
    fs.writeFileSync(script, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.stdout.write("-- started\\n");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    process.env.PAPERCLIP_PG_DUMP_PATH = script;
    try {
      const error = await runDatabaseBackup({
        connectionString: "postgres://fake/db",
        backupDir: dir,
        retention,
        backupEngine: "auto",
        timeoutMs: 500,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(DatabaseBackupTimeoutError);
      expect(fs.readdirSync(dir)).toEqual([]);
      expect(clients).toHaveLength(1);
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      fs.rmSync(script, { force: true });
      fs.rmSync(pidFile, { force: true });
    }
  });

  it("does not time out a fast failure differently", async () => {
    behavior = "select-ok";
    process.env.PAPERCLIP_PG_DUMP_PATH = path.join(dir, "missing-pg-dump");
    const error = await runDatabaseBackup({
      connectionString: "postgres://fake/db",
      backupDir: dir,
      retention,
      backupEngine: "pg_dump",
      timeoutMs: 60_000,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DatabaseBackupTimeoutError);
  });
});
