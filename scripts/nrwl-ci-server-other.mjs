#!/usr/bin/env node
// Fork-only (llwt/paperclip), used by .github/workflows/nrwl-ci.yml.
//
// Runs every test file of the server vitest project that none of the server
// shards select. The shards (run-vitest-stable.mjs general-server and
// serialized) pick files by path rules, so a file the rules miss would run in
// unsharded `pnpm test:run` but in no CI lane. The complement is computed from
// vitest's own collection and the runner's dry-run output, so it needs no file
// list. Pass --list to print the files without running them.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverProject = "@paperclipai/server";
const env = { ...process.env, NODE_ENV: "test" };

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) {
    console.error(`[nrwl-ci-server-other] ${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout);
}

function shardDryRun(args) {
  return capture(process.execPath, ["scripts/run-vitest-stable.mjs", ...args, "--dry-run"]);
}

const collected = capture("pnpm", [
  "exec",
  "vitest",
  "list",
  "--project",
  serverProject,
  "--filesOnly",
  "--json",
])
  .map((entry) => path.relative(repoRoot, entry.file).split(path.sep).join("/"))
  .sort((a, b) => a.localeCompare(b));

const sharded = new Set([
  ...shardDryRun([
    "--mode",
    "general",
    "--group",
    "general-server",
    "--shard-index",
    "0",
    "--shard-count",
    "1",
  ]).selectedGeneralServerSuites,
  ...shardDryRun(["--mode", "serialized"]).selectedSerializedSuites,
]);

const collectedSet = new Set(collected);
const unknown = [...sharded].filter((file) => !collectedSet.has(file));
if (collected.length === 0 || sharded.size === 0 || unknown.length > 0) {
  console.error(
    `[nrwl-ci-server-other] cannot compare: ${collected.length} collected, ${sharded.size} sharded, ` +
      `${unknown.length} sharded files vitest did not collect${unknown.length > 0 ? `: ${unknown.join(", ")}` : ""}`,
  );
  process.exit(1);
}

const remaining = collected.filter((file) => !sharded.has(file));
console.log(
  `[nrwl-ci-server-other] ${collected.length} server test files, ${sharded.size} in the shards, ${remaining.length} here`,
);
for (const file of remaining) {
  console.log(`  ${file}`);
}

if (remaining.length === 0 || process.argv.includes("--list")) {
  process.exit(0);
}

const run = spawnSync("pnpm", ["exec", "vitest", "run", "--project", serverProject, ...remaining], {
  cwd: repoRoot,
  env,
  stdio: "inherit",
});
process.exit(run.status ?? 1);
