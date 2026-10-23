import type { AdapterOutputRecoveryRecord } from "./types.js";

/** A single provider line cannot be larger than this when recovering a result. */
export const OUTPUT_RECOVERY_MAX_LINE_CHARS = 8 * 1024 * 1024;

export interface OutputRecoveryLine {
  stream: "stdout" | "stderr";
  text: string;
  seq: number;
  /** False for a last line that the output ended without a newline. */
  terminated: boolean;
}

export class OutputRecoveryLineTooLargeError extends Error {
  constructor() {
    super("A provider output line exceeds the recovery size limit");
    this.name = "OutputRecoveryLineTooLargeError";
  }
}

/**
 * Turns ordered output records into lines, keeping a separate partial-line
 * buffer per stream so stderr never splices into stdout. Records before
 * `firstSeq` belong to an earlier invocation and are skipped. Throws
 * OutputRecoveryLineTooLargeError when one line outgrows the limit.
 */
export async function* iterateOutputRecoveryLines(
  output: AsyncIterable<AdapterOutputRecoveryRecord>,
  options: { firstSeq: number | null; maxLineChars?: number },
): AsyncGenerator<OutputRecoveryLine> {
  const maxLineChars = options.maxLineChars ?? OUTPUT_RECOVERY_MAX_LINE_CHARS;
  const pending: Record<"stdout" | "stderr", { text: string; seq: number }> = {
    stdout: { text: "", seq: 0 },
    stderr: { text: "", seq: 0 },
  };

  for await (const record of output) {
    if (options.firstSeq !== null && record.seq < options.firstSeq) continue;
    const buffer = pending[record.stream];
    const pieces = record.chunk.split("\n");
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index] ?? "";
      if (buffer.text.length === 0) buffer.seq = record.seq;
      buffer.text += piece;
      if (buffer.text.length > maxLineChars) throw new OutputRecoveryLineTooLargeError();
      if (index === pieces.length - 1) break;
      const line = buffer.text;
      yield {
        stream: record.stream,
        text: line.endsWith("\r") ? line.slice(0, -1) : line,
        seq: buffer.seq,
        terminated: true,
      };
      buffer.text = "";
    }
  }

  for (const stream of ["stdout", "stderr"] as const) {
    const buffer = pending[stream];
    if (buffer.text.length === 0) continue;
    yield { stream, text: buffer.text, seq: buffer.seq, terminated: false };
  }
}
