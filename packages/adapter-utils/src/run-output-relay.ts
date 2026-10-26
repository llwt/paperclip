import type { ChildProcess, StdioOptions } from "node:child_process";
import { spawnScoped } from "./scoped-process.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

// A local child's stdout/stderr are pipes whose read end belongs to the server
// that spawned it. On a hot restart that server exits while the child keeps
// running, so without a new reader every later write fails with EPIPE and the
// output is gone. Before the old server exits it hands the read ends to a
// small detached relay. The relay appends everything it reads to per-stream
// files and records when both streams reach EOF; the next server tails the
// files from its saved offsets.

export const RUN_OUTPUT_RELAY_STATE_FILE = "state.json";
export const RUN_OUTPUT_RELAY_OFFSETS_FILE = "tail-offsets.json";
export const RUN_OUTPUT_RELAY_STREAMS = ["stdout", "stderr"] as const;
export type RunOutputRelayStream = (typeof RUN_OUTPUT_RELAY_STREAMS)[number];

export interface RunOutputRelayState {
  version: 1;
  status: "running" | "ended";
  relayPid: number;
  startedAt: string;
  endedAt?: string;
}

export type RunOutputRelayOffsets = Record<RunOutputRelayStream, number>;

export function runOutputRelayLogPath(dir: string, stream: RunOutputRelayStream) {
  return path.join(dir, `${stream}.log`);
}

// Plain CommonJS for `node -e`. The relay reads fd 3 (stdout) and fd 4
// (stderr), ignores the stop signals a service manager or terminal may send,
// and exits only after both pipes reach EOF, which is when the child and every
// descendant holding them are gone.
const RELAY_SCRIPT = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM", "SIGPIPE"]) process.on(signal, () => {});
const dir = process.env.PAPERCLIP_RUN_OUTPUT_RELAY_DIR;
const startedAt = new Date().toISOString();
function writeState(extra) {
  const state = { version: 1, relayPid: process.pid, startedAt, ...extra };
  const tmp = path.join(dir, "state.json." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, path.join(dir, "state.json"));
}
let open = 0;
let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  writeState({ status: "ended", endedAt: new Date().toISOString() });
  process.exit(0);
}
const inputs = [];
for (const [name, fd] of [["stdout", 3], ["stderr", 4]]) {
  let input;
  try {
    fs.fstatSync(fd);
    input = new net.Socket({ fd, readable: true, writable: false });
  } catch {
    continue;
  }
  const out = fs.openSync(path.join(dir, name + ".log"), "a", 0o600);
  open += 1;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    try { fs.closeSync(out); } catch {}
    open -= 1;
    if (open === 0) finish();
  };
  input.on("data", (chunk) => {
    let written = 0;
    while (written < chunk.length) written += fs.writeSync(out, chunk, written, chunk.length - written);
  });
  input.on("end", close);
  input.on("close", close);
  input.on("error", close);
  inputs.push(input);
}
writeState({ status: "running" });
if (open === 0) finish();
`;

/**
 * Spawn a detached relay that owns the given pipe read ends from now on. The
 * caller must have paused both streams; it must destroy its own copies once
 * this returns so the relay is the only reader.
 */
export async function spawnRunOutputRelay(input: {
  dir: string;
  stdout: Readable | null;
  stderr: Readable | null;
}): Promise<{ relayPid: number }> {
  await fs.mkdir(input.dir, { recursive: true, mode: 0o700 });
  for (const stream of RUN_OUTPUT_RELAY_STREAMS) {
    await fs.appendFile(runOutputRelayLogPath(input.dir, stream), "", { mode: 0o600 });
  }
  const stdio: StdioOptions = [
    "ignore",
    "ignore",
    "ignore",
    input.stdout ?? "ignore",
    input.stderr ?? "ignore",
  ];
  // The relay is its own scope owner: stopping or finishing the provider's
  // scope never reaches it, so it keeps draining output to the end.
  const relay: ChildProcess = spawnScoped({
    command: process.execPath,
    args: ["-e", RELAY_SCRIPT],
    options: {
      detached: process.platform !== "win32",
      env: { PAPERCLIP_RUN_OUTPUT_RELAY_DIR: input.dir },
      stdio,
    },
    owner: { kind: "relay" },
  }).child;
  if (typeof relay.pid !== "number" || relay.pid <= 0) {
    const error = await new Promise<Error>((resolve) => {
      relay.once("error", resolve);
      setTimeout(() => resolve(new Error("run output relay did not start")), 1_000).unref();
    });
    throw error;
  }
  relay.on("error", () => undefined);
  relay.unref();
  return { relayPid: relay.pid };
}

export async function readRunOutputRelayState(dir: string): Promise<RunOutputRelayState | null> {
  const raw = await fs.readFile(path.join(dir, RUN_OUTPUT_RELAY_STATE_FILE), "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RunOutputRelayState>;
    if (
      parsed.version !== 1 ||
      (parsed.status !== "running" && parsed.status !== "ended") ||
      typeof parsed.relayPid !== "number" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return parsed as RunOutputRelayState;
  } catch {
    return null;
  }
}

/**
 * The relay writes its state file right after it opens its inputs. A server
 * that adopts the run immediately after the handoff may get there first, so
 * wait briefly for it.
 */
export async function waitForRunOutputRelayState(dir: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readRunOutputRelayState(dir);
    if (state) return state;
    const dirExists = await fs.stat(dir).then(() => true, () => false);
    if (!dirExists || Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function readRunOutputRelayOffsets(dir: string): Promise<RunOutputRelayOffsets> {
  const offsets: RunOutputRelayOffsets = { stdout: 0, stderr: 0 };
  const raw = await fs.readFile(path.join(dir, RUN_OUTPUT_RELAY_OFFSETS_FILE), "utf8").catch(() => null);
  if (!raw) return offsets;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<RunOutputRelayStream, unknown>>;
    for (const stream of RUN_OUTPUT_RELAY_STREAMS) {
      const value = parsed[stream];
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) offsets[stream] = value;
    }
  } catch {
    // The file is only ever replaced by rename, so this is not a torn write.
  }
  return offsets;
}

export async function writeRunOutputRelayOffsets(dir: string, offsets: RunOutputRelayOffsets) {
  const tmp = path.join(dir, `${RUN_OUTPUT_RELAY_OFFSETS_FILE}.${process.pid}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(offsets), { mode: 0o600 });
  await fs.rename(tmp, path.join(dir, RUN_OUTPUT_RELAY_OFFSETS_FILE));
}

export async function readRunOutputRelayBytes(
  dir: string,
  stream: RunOutputRelayStream,
  offset: number,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await fs.open(runOutputRelayLogPath(dir, stream), "r").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return Buffer.alloc(0);
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Length of the trailing bytes that start a UTF-8 character the buffer does
// not finish yet (0 when the buffer ends on a character boundary).
function incompleteUtf8TailLength(bytes: Buffer, end = bytes.length) {
  for (let back = 1; back <= Math.min(3, end); back += 1) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}

/**
 * Splits bytes read from a relay log into chunks that each decode to whole
 * UTF-8 characters and stay within `maxChunkBytes`, cutting after the last
 * newline in the window when there is one. Unless `final`, an unfinished
 * character at the end is left out, so a saved offset never splits one.
 */
export function splitRunOutputRelayBytes(bytes: Buffer, maxChunkBytes: number, final = false): Buffer[] {
  const end = final ? bytes.length : bytes.length - incompleteUtf8TailLength(bytes);
  const chunks: Buffer[] = [];
  let start = 0;
  while (start < end) {
    let cut = Math.min(end, start + maxChunkBytes);
    if (cut < end) {
      const newline = bytes.lastIndexOf(0x0a, cut - 1);
      if (newline >= start) cut = newline + 1;
      else cut -= incompleteUtf8TailLength(bytes, cut);
      if (cut <= start) cut = Math.min(end, start + maxChunkBytes);
    }
    chunks.push(bytes.subarray(start, cut));
    start = cut;
  }
  return chunks;
}
