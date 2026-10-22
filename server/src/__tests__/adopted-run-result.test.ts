import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRunEvents, heartbeatRuns } from "@paperclipai/db";
import {
  ADOPTED_OUTPUT_DRAINED_MESSAGE,
  ADOPTED_OUTPUT_STOPPED_EARLY_MESSAGE,
  AdoptedRunOutputInconclusiveError,
  classifyAdoptedOutputReceipt,
  openAdoptedRunOutput,
  readAdoptedOutputReceipt,
  type AdoptedRunLifecycleEvent,
} from "../services/adopted-run-result.js";
import {
  createDurableRunLogStore,
  type RunLogHandle,
  type RunLogStore,
} from "../services/run-log-store.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type Rec = { stream: "stdout" | "stderr" | "system"; chunk: string; seq: number };

describe("adopted run output reader", () => {
  let dir: string;
  let store: RunLogStore;
  const identity = { companyId: randomUUID(), agentId: randomUUID(), runId: randomUUID() };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "adopted-run-result-"));
    store = createDurableRunLogStore({ basePath: dir });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function begin() {
    return store.begin(identity);
  }

  async function write(handle: RunLogHandle, records: Rec[]) {
    for (const record of records) {
      await store.append(handle, { ...record, ts: new Date().toISOString() });
    }
  }

  function open(handle: RunLogHandle, extra: Partial<Parameters<typeof openAdoptedRunOutput>[0]> = {}) {
    return openAdoptedRunOutput({
      runLogStore: store,
      run: {
        id: identity.runId,
        companyId: identity.companyId,
        agentId: identity.agentId,
        logStore: handle.store,
        logRef: handle.logRef,
      },
      expected: identity,
      ...extra,
    });
  }

  async function collect(reader: ReturnType<typeof openAdoptedRunOutput>) {
    const out: Array<{ stream: string; chunk: string; seq: number }> = [];
    for await (const record of reader.output) out.push(record);
    return out;
  }

  function lines(records: Array<{ stream: string; chunk: string }>, stream: string) {
    return records.filter((r) => r.stream === stream).map((r) => r.chunk);
  }

  async function reasonOf(reader: ReturnType<typeof openAdoptedRunOutput>) {
    const outcome = await reader.settle();
    expect(outcome.kind).toBe("inconclusive");
    return outcome.kind === "inconclusive" ? outcome.reason : null;
  }

  it("reassembles provider lines split across outer records, per stream", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: '{"type":"sys', seq: 1 },
      { stream: "stderr", chunk: "warn: one\nwarn: t", seq: 2 },
      { stream: "stdout", chunk: 'tem"}\n{"type":"res', seq: 3 },
      { stream: "stderr", chunk: "wo\n", seq: 4 },
      { stream: "stdout", chunk: 'ult"}\n', seq: 5 },
    ]);
    const reader = open(handle);
    const records = await collect(reader);
    expect(lines(records, "stdout")).toEqual(['{"type":"system"}\n', '{"type":"result"}\n']);
    expect(lines(records, "stderr")).toEqual(["warn: one\n", "warn: two\n"]);
    expect(records.map((r) => r.seq)).toEqual([2, 3, 4, 5]);
    expect(await reader.settle()).toEqual({ kind: "intact", records: 4, lastSeq: 5 });
  });

  it("yields several lines of one outer record and keeps them in order", async () => {
    const handle = await begin();
    await write(handle, [{ stream: "stdout", chunk: "a\nb\nc\n", seq: 1 }]);
    const records = await collect(open(handle));
    expect(lines(records, "stdout")).toEqual(["a\n", "b\n", "c\n"]);
  });

  it("reads multi-byte text and long lines across any page boundary", async () => {
    const handle = await begin();
    const text = "é€😀日本語";
    const expected: string[] = [];
    const written: Rec[] = [];
    for (let i = 0; i < 12; i += 1) {
      written.push({ stream: "stdout", chunk: `{"i":${i},"t":"${text}`, seq: 2 * i + 1 });
      written.push({ stream: "stdout", chunk: `${text}"}\n`, seq: 2 * i + 2 });
      expected.push(`{"i":${i},"t":"${text}${text}"}\n`);
    }
    await write(handle, written);
    for (const pageBytes of [16, 17, 31, 64, 97, 200, 1024]) {
      const reader = open(handle, { limits: { pageBytes } });
      const records = await collect(reader);
      expect(lines(records, "stdout"), `page ${pageBytes}`).toEqual(expected);
      expect((await reader.settle()).kind).toBe("intact");
    }
  });

  it("reads an outer record larger than one page", async () => {
    const handle = await begin();
    const big = `${"x".repeat(5000)}\n`;
    await write(handle, [
      { stream: "stdout", chunk: "head\n", seq: 1 },
      { stream: "stdout", chunk: big, seq: 2 },
    ]);
    const records = await collect(open(handle, { limits: { pageBytes: 64 } }));
    expect(lines(records, "stdout")).toEqual(["head\n", big]);
  });

  it("reads a log across the live and the post-restart log handle as one stream", async () => {
    const before = await begin();
    await write(before, [
      { stream: "stdout", chunk: '{"type":"thread.started"}\n{"type":"agent_', seq: 1 },
      { stream: "stderr", chunk: "early\n", seq: 2 },
    ]);
    await store.finalize(before);
    const after = await begin();
    expect(after.attemptId).not.toBe(before.attemptId);
    expect(after.logRef).toBe(before.logRef);
    await write(after, [
      { stream: "stdout", chunk: 'message"}\n', seq: 3 },
      { stream: "stdout", chunk: '{"type":"turn.completed"}\n', seq: 4 },
    ]);
    const reader = open(after);
    const records = await collect(reader);
    expect(lines(records, "stdout")).toEqual([
      '{"type":"thread.started"}\n',
      '{"type":"agent_message"}\n',
      '{"type":"turn.completed"}\n',
    ]);
    expect(lines(records, "stderr")).toEqual(["early\n"]);
    expect(await reader.settle()).toEqual({ kind: "intact", records: 4, lastSeq: 4 });
  });

  it("drops exact duplicate records and reads the rest once", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stdout", chunk: "two\n", seq: 2 },
      { stream: "stderr", chunk: "e\n", seq: 3 },
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stderr", chunk: "e\n", seq: 3 },
      { stream: "stdout", chunk: "three\n", seq: 4 },
    ]);
    const reader = open(handle);
    const records = await collect(reader);
    expect(lines(records, "stdout")).toEqual(["one\n", "two\n", "three\n"]);
    expect(lines(records, "stderr")).toEqual(["e\n"]);
    expect(await reader.settle()).toEqual({ kind: "intact", records: 4, lastSeq: 4 });
  });

  it("is inconclusive when one seq holds different content", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stdout", chunk: "two\n", seq: 2 },
      { stream: "stdout", chunk: "other\n", seq: 1 },
    ]);
    const reader = open(handle);
    await expect(collect(reader)).rejects.toMatchObject({
      name: "AdoptedRunOutputInconclusiveError",
      reason: "conflicting_duplicate_sequence",
    });
    expect(await reasonOf(reader)).toBe("conflicting_duplicate_sequence");
  });

  it("is inconclusive when a duplicate seq changes stream", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stderr", chunk: "one\n", seq: 1 },
    ]);
    expect(await reasonOf(open(handle))).toBe("conflicting_duplicate_sequence");
  });

  it("is inconclusive on a sequence gap or a seq that goes back to an unseen number", async () => {
    const gap = await begin();
    await write(gap, [
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stdout", chunk: "three\n", seq: 3 },
    ]);
    expect(await reasonOf(open(gap))).toBe("sequence_gap");

    await fs.rm(dir, { recursive: true, force: true });
    const back = await begin();
    await write(back, [
      { stream: "stdout", chunk: "five\n", seq: 5 },
      { stream: "stdout", chunk: "six\n", seq: 6 },
    ]);
    await fs.appendFile(
      path.join(dir, back.logRef),
      `${JSON.stringify({ ts: "t", stream: "stdout", chunk: "x\n", seq: 2 })}\n`,
    );
    expect(await reasonOf(open(back))).toBe("sequence_out_of_order");
  });

  it("starts at any seq and can skip output before a later one", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: "old\n", seq: 7 },
      { stream: "stdout", chunk: "new\n", seq: 8 },
      { stream: "stdout", chunk: "newer\n", seq: 9 },
    ]);
    expect(lines(await collect(open(handle)), "stdout")).toEqual(["old\n", "new\n", "newer\n"]);
    expect(lines(await collect(open(handle, { fromSeq: 8 })), "stdout")).toEqual(["new\n", "newer\n"]);
  });

  it("is inconclusive when a chunk was compacted by the run log", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: "head\n[paperclip truncated run log chunk: omitted 120 chars]\ntail\n", seq: 1 },
    ]);
    expect(await reasonOf(open(handle))).toBe("compaction_marker");
  });

  it("does not take quoted marker text inside a JSON line for a compaction", async () => {
    const handle = await begin();
    const line = JSON.stringify({ text: "\n[paperclip truncated run log chunk: omitted 120 chars]\n" });
    await write(handle, [{ stream: "stdout", chunk: `${line}\n`, seq: 1 }]);
    const reader = open(handle);
    expect(lines(await collect(reader), "stdout")).toEqual([`${line}\n`]);
    expect((await reader.settle()).kind).toBe("intact");
  });

  it("is inconclusive on a provider line over the limit, in one chunk or many", async () => {
    const one = await begin();
    await write(one, [{ stream: "stdout", chunk: `${"x".repeat(120)}\n`, seq: 1 }]);
    expect(await reasonOf(open(one, { limits: { maxLineBytes: 100 } }))).toBe("over_limit_line");

    await fs.rm(dir, { recursive: true, force: true });
    const many = await begin();
    await write(many, [
      { stream: "stdout", chunk: "x".repeat(60), seq: 1 },
      { stream: "stderr", chunk: "ok\n", seq: 2 },
      { stream: "stdout", chunk: "x".repeat(60), seq: 3 },
    ]);
    expect(await reasonOf(open(many, { limits: { maxLineBytes: 100 } }))).toBe("over_limit_line");
  });

  it("counts the limit in bytes and accepts a line exactly at it", async () => {
    const handle = await begin();
    await write(handle, [{ stream: "stdout", chunk: `${"é".repeat(50)}\n`, seq: 1 }]);
    const reader = open(handle, { limits: { maxLineBytes: 100 } });
    expect(await collect(reader)).toHaveLength(1);
    expect((await reader.settle()).kind).toBe("intact");
    const over = open(handle, { limits: { maxLineBytes: 99 } });
    expect(await reasonOf(over)).toBe("over_limit_line");
  });

  it("is inconclusive on an outer record over the limit", async () => {
    const handle = await begin();
    await write(handle, [{ stream: "stdout", chunk: `${"x".repeat(5000)}\n`, seq: 1 }]);
    const reader = open(handle, { limits: { pageBytes: 64, maxOuterLineBytes: 1024 } });
    expect(await reasonOf(reader)).toBe("over_limit_line");
  });

  it("is inconclusive on a malformed outer record", async () => {
    const cases: Array<[string, string]> = [
      ["not json", "{not json"],
      ["array", "[1]"],
      ["no seq", JSON.stringify({ stream: "stdout", chunk: "a\n" })],
      ["fractional seq", JSON.stringify({ stream: "stdout", chunk: "a\n", seq: 1.5 })],
      ["bad stream", JSON.stringify({ stream: "stdin", chunk: "a\n", seq: 1 })],
      ["bad chunk", JSON.stringify({ stream: "stdout", chunk: 5, seq: 1 })],
      ["cut off", '{"stream":"stdout","chunk":"a\\n","se'],
    ];
    for (const [label, bad] of cases) {
      await fs.rm(dir, { recursive: true, force: true });
      const handle = await begin();
      await write(handle, [{ stream: "stdout", chunk: "ok\n", seq: 1 }]);
      await fs.appendFile(path.join(dir, handle.logRef), `${bad}\n`);
      expect(await reasonOf(open(handle)), label).toBe("malformed_outer_record");
    }
  });

  it("is inconclusive when the last provider line never ended", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: '{"type":"result"}\n{"type":"res', seq: 1 },
    ]);
    const reader = open(handle);
    await expect(collect(reader)).rejects.toMatchObject({ reason: "unterminated_final_line" });
    expect(await reasonOf(reader)).toBe("unterminated_final_line");
  });

  it("checks company, agent, run and log identity before reading", async () => {
    const handle = await begin();
    await write(handle, [{ stream: "stdout", chunk: "a\n", seq: 1 }]);
    const run = {
      id: identity.runId,
      companyId: identity.companyId,
      agentId: identity.agentId,
      logStore: handle.store,
      logRef: handle.logRef,
    };
    const cases = [
      { ...run, companyId: randomUUID() },
      { ...run, agentId: randomUUID() },
      { ...run, id: randomUUID() },
      { ...run, logRef: path.join(randomUUID(), identity.agentId, `${identity.runId}.ndjson`) },
      { ...run, logRef: path.join("..", handle.logRef) },
    ];
    for (const bad of cases) {
      const reader = openAdoptedRunOutput({ runLogStore: store, run: bad, expected: identity });
      const outcome = await reader.settle();
      expect(outcome).toMatchObject({ kind: "inconclusive", reason: "identity_mismatch" });
    }
    for (const bad of [{ ...run, logStore: null }, { ...run, logRef: null }, { ...run, logStore: "s3" }]) {
      const reader = openAdoptedRunOutput({ runLogStore: store, run: bad, expected: identity });
      expect(await reader.settle()).toMatchObject({ kind: "inconclusive", reason: "log_unavailable" });
    }
  });

  it("is inconclusive when the log cannot be read", async () => {
    const handle = await begin();
    await fs.rm(path.join(dir, handle.logRef));
    expect(await reasonOf(open(handle))).toBe("log_unavailable");
  });

  it("lets settle read the rest after a consumer stopped early or ignored an error", async () => {
    const handle = await begin();
    await write(handle, [
      { stream: "stdout", chunk: "one\n", seq: 1 },
      { stream: "stdout", chunk: "two\n", seq: 2 },
      { stream: "stdout", chunk: "three\n", seq: 4 },
    ]);
    const early = open(handle);
    for await (const record of early.output) {
      expect(record.chunk).toBe("one\n");
      break;
    }
    expect(await early.settle()).toMatchObject({ kind: "inconclusive", reason: "sequence_gap" });

    const swallowing = open(handle);
    await collect(swallowing).catch(() => undefined);
    expect(await swallowing.settle()).toMatchObject({ kind: "inconclusive", reason: "sequence_gap" });
  });

  it("reports an empty log as intact with no records", async () => {
    const handle = await begin();
    const reader = open(handle);
    expect(await collect(reader)).toEqual([]);
    expect(await reader.settle()).toEqual({ kind: "intact", records: 0, lastSeq: null });
  });

  it("exposes a typed error for the inconclusive reasons", () => {
    const error = new AdoptedRunOutputInconclusiveError("sequence_gap", "after seq 1");
    expect(error.reason).toBe("sequence_gap");
    expect(error.message).toBe("sequence_gap: after seq 1");
  });
});

describe("adopted output tail receipt", () => {
  const info = (seq: number, extra: Partial<AdoptedRunLifecycleEvent> = {}): AdoptedRunLifecycleEvent => ({
    seq,
    level: "info",
    message: ADOPTED_OUTPUT_DRAINED_MESSAGE,
    payload: { relayPid: 77, offsets: { stdout: 10, stderr: 0 } },
    ...extra,
  });
  const stopped = (seq: number): AdoptedRunLifecycleEvent => ({
    seq,
    level: "warn",
    message: ADOPTED_OUTPUT_STOPPED_EARLY_MESSAGE,
    payload: { relayPid: 77, offsets: null },
  });
  const gaveUp = (seq: number): AdoptedRunLifecycleEvent => ({
    seq,
    level: "warn",
    message: "Output not captured after hot restart: recording this child's output from its relay kept failing; the unread output stays in the relay files",
    payload: { reason: "output_tail_failed", consecutiveFailures: 60 },
  });
  const noise: AdoptedRunLifecycleEvent = {
    seq: 1,
    level: "info",
    message: "Adopted live child process after hot restart",
    payload: { outputCapture: { mode: "relay", relayPid: 77 } },
  };

  it("takes the info event of the end of the child's output as the receipt", () => {
    expect(classifyAdoptedOutputReceipt([noise, info(5)])).toEqual({ kind: "drained", eventSeq: 5 });
  });

  it("does not take a warning, a give-up, or other events for a receipt", () => {
    expect(classifyAdoptedOutputReceipt([noise, stopped(5)])).toEqual({ kind: "stopped_early", eventSeq: 5 });
    expect(classifyAdoptedOutputReceipt([noise, gaveUp(5)])).toEqual({ kind: "gave_up", eventSeq: 5 });
    expect(classifyAdoptedOutputReceipt([noise])).toEqual({ kind: "absent" });
    expect(classifyAdoptedOutputReceipt([])).toEqual({ kind: "absent" });
    expect(classifyAdoptedOutputReceipt([info(5, { level: "warn" })])).toEqual({ kind: "absent" });
    expect(classifyAdoptedOutputReceipt([info(5, { message: "Child output relay reached the end" })])).toEqual({
      kind: "absent",
    });
  });

  it("lets the latest tail ending decide", () => {
    expect(classifyAdoptedOutputReceipt([gaveUp(3), info(6)])).toEqual({ kind: "drained", eventSeq: 6 });
    expect(classifyAdoptedOutputReceipt([info(3), gaveUp(6)])).toEqual({ kind: "gave_up", eventSeq: 6 });
    expect(classifyAdoptedOutputReceipt([info(6), stopped(3)])).toEqual({ kind: "drained", eventSeq: 6 });
  });

  it("ignores a receipt of another relay when the relay is known", () => {
    expect(classifyAdoptedOutputReceipt([info(5)], 77)).toEqual({ kind: "drained", eventSeq: 5 });
    expect(classifyAdoptedOutputReceipt([info(5)], 78)).toEqual({ kind: "absent" });
    expect(classifyAdoptedOutputReceipt([info(5, { payload: null })], 78)).toEqual({
      kind: "drained",
      eventSeq: 5,
    });
    expect(classifyAdoptedOutputReceipt([gaveUp(5)], 78)).toEqual({ kind: "gave_up", eventSeq: 5 });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("adopted output receipt from the event table", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-adopted-run-result-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  let prefixCounter = 0;
  const nextPrefix = () => `AD${String.fromCharCode(65 + prefixCounter++)}`;

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Adopted", issuePrefix: nextPrefix() });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Agent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "running",
    });
    return { companyId, agentId, runId };
  }

  async function addEvent(
    scope: { companyId: string; agentId: string; runId: string },
    seq: number,
    event: { eventType?: string; level: string; message: string; payload?: Record<string, unknown> },
  ) {
    await db.insert(heartbeatRunEvents).values({
      ...scope,
      seq,
      eventType: event.eventType ?? "lifecycle",
      stream: "system",
      level: event.level,
      message: event.message,
      payload: event.payload ?? null,
    });
  }

  it("reads the receipt of this run only", async () => {
    const mine = await seedRun();
    const other = await seedRun();
    await addEvent(mine, 1, { level: "info", message: "run started" });
    await addEvent(other, 1, {
      level: "info",
      message: ADOPTED_OUTPUT_DRAINED_MESSAGE,
      payload: { relayPid: 77 },
    });
    expect(await readAdoptedOutputReceipt(db, mine)).toEqual({ kind: "absent" });

    await addEvent(mine, 2, {
      eventType: "adapter.invoke",
      level: "info",
      message: ADOPTED_OUTPUT_DRAINED_MESSAGE,
    });
    expect(await readAdoptedOutputReceipt(db, mine)).toEqual({ kind: "absent" });

    await addEvent(mine, 3, {
      level: "info",
      message: ADOPTED_OUTPUT_DRAINED_MESSAGE,
      payload: { relayPid: 77, offsets: { stdout: 1, stderr: 0 } },
    });
    expect(await readAdoptedOutputReceipt(db, mine)).toEqual({ kind: "drained", eventSeq: 3 });
    expect(await readAdoptedOutputReceipt(db, { ...mine, relayPid: 78 })).toEqual({ kind: "absent" });
    expect(await readAdoptedOutputReceipt(db, { ...mine, agentId: randomUUID() })).toEqual({ kind: "absent" });

    await addEvent(mine, 4, {
      level: "warn",
      message: "gave up",
      payload: { reason: "output_tail_failed" },
    });
    expect(await readAdoptedOutputReceipt(db, mine)).toEqual({ kind: "gave_up", eventSeq: 4 });
  });
});
