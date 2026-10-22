import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVitest } from "vitest/node";
import { agentMaxWorkers } from "./agent-test-limits.mjs";
import { typecheckArgs } from "./run-typecheck.mjs";
import { cargoTypecheckEnv } from "../packages/paperclip-runner/scripts/typecheck-rust.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agentMaxWorkers", () => {
  it.each([
    [{}, undefined],
    [{ PAPERCLIP_RUN_ID: "" }, undefined],
    [{ PAPERCLIP_RUN_ID: "test" }, 2],
    [{ PAPERCLIP_RUN_ID: "test", CI: "true" }, undefined],
    [{ PAPERCLIP_RUN_ID: "test", CI: "false" }, 2],
    [{ CI: "true" }, undefined],
    [{ PAPERCLIP_TEST_MAX_WORKERS: "3" }, 3],
    [{ PAPERCLIP_RUN_ID: "test", PAPERCLIP_TEST_MAX_WORKERS: "3" }, 3],
    [{ CI: "true", PAPERCLIP_TEST_MAX_WORKERS: "3" }, 3],
  ])("resolves %j to %s", (env, expected) => {
    expect(agentMaxWorkers(env)).toBe(expected);
  });

  it.each(["abc", "0", "-1", "1.5", "3x", "", "Infinity", "9007199254740992"])(
    "warns and ignores invalid override %j",
    (override) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(agentMaxWorkers({ PAPERCLIP_TEST_MAX_WORKERS: override })).toBeUndefined();
      expect(agentMaxWorkers({ PAPERCLIP_TEST_MAX_WORKERS: override, PAPERCLIP_RUN_ID: "test" })).toBe(2);
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid PAPERCLIP_TEST_MAX_WORKERS"));
    },
  );
});

describe("typecheck wrapper", () => {
  it.each([
    [{}, ["-r", "typecheck"]],
    [{ PAPERCLIP_RUN_ID: "test" }, ["-r", "--workspace-concurrency=2", "typecheck"]],
    [{ PAPERCLIP_RUN_ID: "test", CI: "true" }, ["-r", "typecheck"]],
    [{ PAPERCLIP_TEST_MAX_WORKERS: "3" }, ["-r", "--workspace-concurrency=3", "typecheck"]],
  ])("preserves pnpm arguments for %j", (env, expected) => {
    expect(typecheckArgs(env)).toEqual(expected);
  });

  it.skipIf(process.platform === "win32").each([undefined, "4"])("passes arguments, Cargo jobs (%s), and the child's exit status through", (jobs) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-typecheck-"));
    try {
      const command = path.join(dir, "pnpm");
      writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "jobs=%s\\n" "$CARGO_BUILD_JOBS"\nexit 7\n');
      chmodSync(command, 0o755);
      const env = { ...process.env, PATH: dir, PAPERCLIP_RUN_ID: "test", CI: "false", PAPERCLIP_TEST_MAX_WORKERS: "2" };
      if (jobs === undefined) delete env.CARGO_BUILD_JOBS;
      else env.CARGO_BUILD_JOBS = jobs;
      const result = spawnSync(process.execPath, [path.join(root, "scripts/run-typecheck.mjs"), "--filter=example"], {
        encoding: "utf8",
        env,
      });
      expect(result.stdout.trim().split("\n")).toEqual(["-r", "--workspace-concurrency=2", "typecheck", "--filter=example", `jobs=${jobs ?? "2"}`]);
      expect(result.status).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Rust typecheck wrapper", () => {
  it.each([
    [{}, undefined],
    [{ PAPERCLIP_RUN_ID: "" }, undefined],
    [{ PAPERCLIP_RUN_ID: "test" }, "2"],
    [{ PAPERCLIP_RUN_ID: "test", CI: "true" }, undefined],
    [{ PAPERCLIP_RUN_ID: "test", CARGO_BUILD_JOBS: "4" }, "4"],
  ])("preserves Cargo settings for %j", (env, expected) => {
    expect(cargoTypecheckEnv(env)).toEqual({ ...env, ...(expected === undefined ? {} : { CARGO_BUILD_JOBS: expected }) });
    expect(env).not.toHaveProperty("CARGO_BUILD_JOBS", "2");
  });

  it.skipIf(process.platform === "win32").each([0, 9])("runs fmt before check and stops on failure (%s)", (fmtStatus) => {
    const dir = mkdtempSync(path.join(tmpdir(), "agent-cargo-"));
    try {
      const command = path.join(dir, "cargo");
      writeFileSync(command, `#!/bin/sh\nprintf "%s jobs=%s\\n" "$*" "$CARGO_BUILD_JOBS"\nif [ "$1" = fmt ]; then exit ${fmtStatus}; fi\nexit 0\n`);
      chmodSync(command, 0o755);
      const env = { ...process.env, PATH: dir, PAPERCLIP_RUN_ID: "test", CI: "false" };
      delete env.CARGO_BUILD_JOBS;
      const result = spawnSync(process.execPath, [path.join(root, "packages/paperclip-runner/scripts/typecheck-rust.mjs")], {
        cwd: path.join(root, "packages/paperclip-runner"),
        encoding: "utf8",
        env,
      });
      expect(result.stdout.trim().split("\n")).toEqual([
        "fmt --manifest-path runner/Cargo.toml --all -- --check jobs=2",
        ...(fmtStatus === 0 ? ["check --manifest-path runner/Cargo.toml --locked --workspace jobs=2"] : []),
      ]);
      expect(result.status).toBe(fmtStatus);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Vitest config resolution", () => {
  it.each([
    ["false", undefined, 2],
    ["true", undefined, undefined],
    ["false", 3, 3],
    ["false", 1, 1],
  ])("keeps the lower server limit with CI=%s and CLI maxWorkers=%s", async (ci, cliWorkers, expected) => {
    vi.stubEnv("PAPERCLIP_RUN_ID", "test");
    vi.stubEnv("CI", ci);
    vi.stubEnv("PAPERCLIP_TEST_MAX_WORKERS", undefined);
    const ctx = await createVitest("test", {
      root,
      watch: false,
      project: ["@paperclipai/server", "@paperclipai/shared"],
      ...(cliWorkers === undefined ? {} : { maxWorkers: cliWorkers }),
    });
    try {
      expect(ctx.config.maxWorkers).toBe(expected);
      expect(ctx.projects.find((project) => project.name === "@paperclipai/server").config.maxWorkers).toBe(1);
      expect(ctx.projects.find((project) => project.name === "@paperclipai/shared").config.maxWorkers).toBeUndefined();
    } finally {
      await ctx.close();
    }
  }, 30000);
});
