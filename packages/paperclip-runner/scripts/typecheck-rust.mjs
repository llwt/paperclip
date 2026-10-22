#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function cargoTypecheckEnv(env = process.env) {
  return env.PAPERCLIP_RUN_ID && env.CI !== "true" && env.CARGO_BUILD_JOBS === undefined
    ? { ...env, CARGO_BUILD_JOBS: "2" }
    : env;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = cargoTypecheckEnv();
  for (const args of [
    ["fmt", "--manifest-path", "runner/Cargo.toml", "--all", "--", "--check"],
    ["check", "--manifest-path", "runner/Cargo.toml", "--locked", "--workspace"],
  ]) {
    const result = spawnSync("cargo", args, { env, stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
