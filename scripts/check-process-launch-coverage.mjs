#!/usr/bin/env node
// Process-launch coverage gate (SX-2476). See scripts/process-launch-coverage/gate.mjs.
//   node scripts/check-process-launch-coverage.mjs             check the tree against the manifest
//   node scripts/check-process-launch-coverage.mjs --write     refresh pinned site counts (new files are added as "unclassified")
//   node scripts/check-process-launch-coverage.mjs --external <dir>
//                                                              check that an external adapter package has no launch site of its own
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, regenerateManifest, runGate, scanExternalAdapter, listTrackedFiles, readRepoFile } from "./process-launch-coverage/gate.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function listDirectory(directory) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (statSync(full).isFile()) out.push(path.relative(directory, full).split(path.sep).join("/"));
    }
  };
  walk(directory);
  return out;
}

function printViolations(violations) {
  const byCode = new Map();
  for (const violation of violations) {
    if (!byCode.has(violation.code)) byCode.set(violation.code, []);
    byCode.get(violation.code).push(violation);
  }
  for (const [code, list] of byCode) {
    console.error(`\n${code} (${list.length})`);
    for (const violation of list) console.error(`  ${violation.file}\n    ${violation.message}`);
  }
}

if (args[0] === "--external") {
  const directory = args[1];
  if (!directory) {
    console.error("usage: check-process-launch-coverage.mjs --external <adapter package directory>");
    process.exit(2);
  }
  const absolute = path.resolve(directory);
  const sites = scanExternalAdapter({
    directory: path.basename(absolute),
    files: listDirectory(absolute),
    readText: (file) => readFileSync(path.join(absolute, file), "utf8"),
  });
  if (sites.length) {
    console.error(`External adapter ${absolute} starts processes itself, so it is not covered by agent process isolation:`);
    for (const site of sites) console.error(`  ${site.file}:${site.line} ${site.kind} ${site.api} (${site.in})`);
    console.error("Start provider processes with runChildProcess (or spawnScoped / execFileAuxiliary) from @paperclipai/adapter-utils/server-utils.");
    process.exit(1);
  }
  console.log(`External adapter ${absolute}: no raw process launch sites.`);
  process.exit(0);
}

if (args[0] === "--write") {
  const manifest = regenerateManifest({ manifest: loadManifest(root), files: listTrackedFiles(root), readText: readRepoFile(root) });
  writeFileSync(path.join(root, "scripts/process-launch-coverage/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log("Refreshed scripts/process-launch-coverage/manifest.json. Classify any entry with class \"unclassified\" by hand.");
}

const result = runGate({ root });
if (result.violations.length) {
  console.error(`Process-launch coverage gate FAILED with ${result.violations.length} violation(s).`);
  printViolations(result.violations);
  console.error("\nEvery process launch needs a class, owner and reason in scripts/process-launch-coverage/manifest.json. See FORK.md, section \"Agent process isolation\".");
  process.exit(1);
}
console.log(
  `Process-launch coverage gate passed: ${result.summary.nodeSites} Node sites in ${result.summary.nodeFiles} files, ${result.summary.rustFiles} Rust files, ${result.summary.patches} patches, ${result.summary.generatedLauncherFiles} generated-launcher files, ${result.summary.matrixRows} matrix rows.`,
);
