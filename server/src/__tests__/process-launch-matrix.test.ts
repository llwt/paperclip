import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_ADAPTER_TYPES } from "../adapters/builtin-adapter-types.js";
import { listServerAdapters } from "../adapters/registry.js";

vi.mock("../vendor/paperclip-runner/live/index.js", () => ({
  probeAcpxClaudeInstallation: vi.fn(),
  probeAcpxGrokInstallation: vi.fn(),
  probeAcpxPiInstallation: vi.fn(),
  probeAcpxCursorInstallation: vi.fn(async () => undefined),
}));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const manifest = JSON.parse(readFileSync(path.join(root, "scripts/process-launch-coverage/manifest.json"), "utf8")) as {
  matrix: Array<{ id: string; launch: string }>;
};

describe("process-launch coverage matrix", () => {
  const rows = new Map(manifest.matrix.map((row) => [row.id, row.launch]));

  it("has a row for every adapter the server registers at runtime", () => {
    const registered = listServerAdapters().map((adapter) => `adapter:${adapter.type}`);
    expect(registered.length).toBeGreaterThan(0);
    expect(registered.filter((id) => !rows.has(id))).toEqual([]);
  });

  it("has a row for every built-in adapter type", () => {
    const builtin = [...BUILTIN_ADAPTER_TYPES].map((type) => `adapter:${type}`);
    expect(builtin.filter((id) => !rows.has(id))).toEqual([]);
  });

  it("has no adapter row that the server no longer registers", () => {
    const registered = new Set(listServerAdapters().map((adapter) => `adapter:${adapter.type}`));
    const stale = [...rows.keys()].filter((id) => id.startsWith("adapter:") && !registered.has(id));
    expect(stale).toEqual([]);
  });
});
