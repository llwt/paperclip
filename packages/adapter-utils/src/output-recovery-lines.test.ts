import { describe, expect, it } from "vitest";
import type { AdapterOutputRecoveryRecord } from "./types.js";
import {
  iterateOutputRecoveryLines,
  OutputRecoveryLineTooLargeError,
} from "./output-recovery-lines.js";

function source(records: Array<Omit<AdapterOutputRecoveryRecord, "seq"> & { seq?: number }>) {
  return (async function* () {
    let next = 1;
    for (const record of records) yield { ...record, seq: record.seq ?? next++ } as AdapterOutputRecoveryRecord;
  })();
}

async function collect(
  records: Array<Omit<AdapterOutputRecoveryRecord, "seq"> & { seq?: number }>,
  options: { firstSeq?: number | null; maxLineChars?: number } = {},
) {
  const lines = [];
  for await (const line of iterateOutputRecoveryLines(source(records), { firstSeq: options.firstSeq ?? null, maxLineChars: options.maxLineChars })) {
    lines.push(line);
  }
  return lines;
}

describe("iterateOutputRecoveryLines", () => {
  it("joins a line split across records and strips carriage returns", async () => {
    const lines = await collect([
      { stream: "stdout", chunk: "hel" },
      { stream: "stdout", chunk: "lo\r\nwor" },
      { stream: "stdout", chunk: "ld\n" },
    ]);
    expect(lines.map((line) => [line.text, line.seq, line.terminated])).toEqual([
      ["hello", 1, true],
      ["world", 2, true],
    ]);
  });

  it("keeps stderr from splicing into a partial stdout line", async () => {
    const lines = await collect([
      { stream: "stdout", chunk: '{"a":' },
      { stream: "stderr", chunk: "warn\n" },
      { stream: "stdout", chunk: "1}\n" },
    ]);
    expect(lines.map((line) => [line.stream, line.text])).toEqual([
      ["stderr", "warn"],
      ["stdout", '{"a":1}'],
    ]);
  });

  it("yields an unterminated tail last, flagged", async () => {
    const lines = await collect([{ stream: "stdout", chunk: "done\ntail" }]);
    expect(lines.map((line) => [line.text, line.terminated])).toEqual([
      ["done", true],
      ["tail", false],
    ]);
  });

  it("skips records before firstSeq", async () => {
    const lines = await collect(
      [
        { stream: "stdout", chunk: "old\n", seq: 1 },
        { stream: "stdout", chunk: "partial-old", seq: 2 },
        { stream: "stdout", chunk: "new\n", seq: 3 },
      ],
      { firstSeq: 3 },
    );
    expect(lines.map((line) => line.text)).toEqual(["new"]);
  });

  it("keeps multibyte text intact across records", async () => {
    const lines = await collect([
      { stream: "stdout", chunk: "héllo \u{1F600}" },
      { stream: "stdout", chunk: " done\n" },
    ]);
    expect(lines[0]?.text).toBe("héllo \u{1F600} done");
  });

  it("throws when one line outgrows the limit", async () => {
    await expect(
      collect([{ stream: "stdout", chunk: "abcd" }, { stream: "stdout", chunk: "efgh" }], { maxLineChars: 6 }),
    ).rejects.toBeInstanceOf(OutputRecoveryLineTooLargeError);
  });

  it("allows many short lines in one record under a small limit", async () => {
    const lines = await collect([{ stream: "stdout", chunk: "aaaa\nbbbb\ncccc\n" }], { maxLineChars: 5 });
    expect(lines).toHaveLength(3);
  });
});
