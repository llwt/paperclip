#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentMaxWorkers } from "./agent-test-limits.mjs";

export function typecheckArgs(env = process.env) {
  const workers = agentMaxWorkers(env);
  return [
    "-r",
    ...(workers === undefined ? [] : [`--workspace-concurrency=${workers}`]),
    "typecheck",
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync("pnpm", [...typecheckArgs(), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}
