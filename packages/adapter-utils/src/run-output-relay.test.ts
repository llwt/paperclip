import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readRunOutputRelayBytes,
  readRunOutputRelayOffsets,
  readRunOutputRelayState,
  runOutputRelayLogPath,
  splitRunOutputRelayBytes,
  writeRunOutputRelayOffsets,
} from "./run-output-relay.js";
import {
  handOffRunningProcessOutput,
  runChildProcess,
  runningProcesses,
} from "./server-utils.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform === "win32")("run output relay", () => {
  it("keeps a child's output after the spawning reader hands it off", async () => {
    const workDir = await tempDir("paperclip-relay-child-");
    const relayDir = path.join(workDir, "relay");
    const gate = path.join(workDir, "go");
    const runId = randomUUID();
    const script = [
      "const fs = require('node:fs');",
      "process.stdout.write('before\\n');",
      `const gate = ${JSON.stringify(gate)};`,
      "const timer = setInterval(() => {",
      "  if (!fs.existsSync(gate)) return;",
      "  clearInterval(timer);",
      "  process.stdout.write('after stdout\\n');",
      "  process.stderr.write('after stderr\\n');",
      "  process.exit(0);",
      "}, 20);",
    ].join("\n");
    const chunks: string[] = [];
    let settled = false;
    void runChildProcess(runId, process.execPath, ["-e", script], {
      cwd: workDir,
      env: {},
      timeoutSec: 0,
      graceSec: 1,
      onLog: async (_stream, chunk) => {
        chunks.push(chunk);
      },
    }).finally(() => {
      settled = true;
    });
    expect(await waitFor(() => chunks.join("").includes("before"))).toBe(true);

    const relay = await handOffRunningProcessOutput(runId, relayDir);
    expect(relay?.relayPid).toBeGreaterThan(0);
    expect(runningProcesses.has(runId)).toBe(false);
    await expect(handOffRunningProcessOutput(runId, relayDir)).resolves.toBeNull();

    await fs.writeFile(gate, "go");
    expect(
      await waitFor(async () => (await readRunOutputRelayState(relayDir))?.status === "ended"),
    ).toBe(true);

    expect(await fs.readFile(runOutputRelayLogPath(relayDir, "stdout"), "utf8")).toBe("after stdout\n");
    expect(await fs.readFile(runOutputRelayLogPath(relayDir, "stderr"), "utf8")).toBe("after stderr\n");
    // The spawning reader saw nothing after the handoff and does not settle
    // the run from its partial output.
    expect(chunks.join("")).toBe("before\n");
    expect(settled).toBe(false);
  });

  it("reads relay bytes from an offset and round-trips saved offsets", async () => {
    const relayDir = await tempDir("paperclip-relay-files-");
    await fs.writeFile(runOutputRelayLogPath(relayDir, "stdout"), "hello world");
    expect((await readRunOutputRelayBytes(relayDir, "stdout", 6, 1024)).toString()).toBe("world");
    expect((await readRunOutputRelayBytes(relayDir, "stderr", 0, 1024)).length).toBe(0);
    expect(await readRunOutputRelayOffsets(relayDir)).toEqual({ stdout: 0, stderr: 0 });
    await writeRunOutputRelayOffsets(relayDir, { stdout: 11, stderr: 3 });
    expect(await readRunOutputRelayOffsets(relayDir)).toEqual({ stdout: 11, stderr: 3 });
    expect(await readRunOutputRelayState(relayDir)).toBeNull();
  });
});

describe("splitRunOutputRelayBytes", () => {
  it("cuts after the last newline that fits and keeps every byte", () => {
    const input = Buffer.from("aaaa\nbbbb\ncccc\n");
    const chunks = splitRunOutputRelayBytes(input, 12);
    expect(chunks.map((chunk) => chunk.toString())).toEqual(["aaaa\nbbbb\n", "cccc\n"]);
  });

  it("cuts a line longer than the limit on a character boundary", () => {
    const input = Buffer.from("ab\u20accd");
    const chunks = splitRunOutputRelayBytes(input, 4, true);
    expect(chunks.map((chunk) => chunk.toString())).toEqual(["ab", "\u20acc", "d"]);
    expect(Buffer.concat(chunks).equals(input)).toBe(true);
  });

  it("leaves an unfinished character at the end for the next read unless final", () => {
    const euro = Buffer.from("\u20ac");
    const input = Buffer.concat([Buffer.from("x"), euro.subarray(0, 2)]);
    expect(splitRunOutputRelayBytes(input, 1024).map((chunk) => chunk.toString())).toEqual(["x"]);
    expect(Buffer.concat(splitRunOutputRelayBytes(input, 1024, true)).equals(input)).toBe(true);
    expect(splitRunOutputRelayBytes(euro.subarray(0, 1), 1024)).toEqual([]);
    expect(splitRunOutputRelayBytes(Buffer.from("\u{1f600}"), 1024).map((chunk) => chunk.toString())).toEqual([
      "\u{1f600}",
    ]);
  });
});
