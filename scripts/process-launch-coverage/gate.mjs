// The process-launch coverage gate (SX-2476). Every place production code can
// start an OS process is listed in manifest.json with an owner, the way the
// process stays inside an agent process scope (or why it may stay outside),
// and a test. A new, removed or changed launch site that the manifest does not
// describe is a violation, so a bypass cannot land unnoticed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractEmbeddedPrograms, scanEmbeddedProgram, scanSource } from "./scan.mjs";
import { scanPatchText } from "./scan-patch.mjs";
import { scanRustSource } from "./scan-rust.mjs";

export const REQUIRED_GENERATED_LAUNCHERS = [
  "packages/adapter-utils/src/local-process-sandbox.ts",
  "packages/adapter-utils/src/github-launcher.ts",
  "packages/paperclip-runner/src/drivers/acpx/native-distribution-integrity.ts",
  "packages/paperclip-runner/src/providers/grok/launcher.cjs",
];

export const REQUIRED_PATCHES = ["patches/acpx@0.12.0.patch", "patches/acpx@0.13.1.patch"];

// Text no generated launcher may contain: each one moves a process out of the
// scope of the process that runs the launcher.
const SCOPE_ESCAPE_PATTERNS = [
  [/detached\s*:\s*true/, "detached: true"],
  [/\bsetsid\b/, "setsid"],
  [/systemd-run/, "systemd-run"],
  [/\bunshare\b/, "unshare"],
  [/\bnohup\b/, "nohup"],
];

const NODE_SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const MIN_REASON_LENGTH = 30;

export function listTrackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return output.split("\0").filter(Boolean);
}

/** How a tracked path is treated: shipped code, a test, build/dev tooling, or not declared. */
export function classifyRoot(file) {
  const sourceIndex = file.indexOf("/src/");
  const head = sourceIndex === -1 ? file : file.slice(0, sourceIndex + 1);
  if (/(?:^|\/)__tests__\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return "test";
  if (/(?:^|\/)(?:tests?|e2e|fixtures)\//.test(head)) return "test";
  if (/^(?:ui|doc|docs|skills|evals|\.github|\.claude|\.agents)\//.test(file)) return "tooling";
  if (/(?:^|\/)scripts\//.test(head)) return "tooling";
  if (/^(?:server|cli)\/src\//.test(file) || /^packages\/.+?\/src\//.test(file)) return "production";
  if (/(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(file)) return "tooling";
  return "unknown";
}

// Parsing every tracked source file takes seconds; the same text is scanned once per process.
const scanCache = new Map();
function scanCached(text, file) {
  const key = `${file}\0${createHash("sha1").update(text).digest("hex")}`;
  let result = scanCache.get(key);
  if (!result) {
    result = scanSource(text, file);
    scanCache.set(key, result);
  }
  return result;
}

function siteKey(site) {
  return `${site.in}|${site.kind}:${site.api}:${site.form}`;
}

function countSites(sites) {
  const counts = {};
  for (const site of sites) counts[siteKey(site)] = (counts[siteKey(site)] ?? 0) + 1;
  return counts;
}

function sortObject(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function diffCounts(expected = {}, actual = {}) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, count] of Object.entries(actual)) {
    if (!(key in expected)) added.push(`${key} x${count}`);
    else if (expected[key] !== count) changed.push(`${key} (manifest ${expected[key]}, tree ${count})`);
  }
  for (const key of Object.keys(expected)) if (!(key in actual)) removed.push(`${key} x${expected[key]}`);
  return { added, removed, changed, equal: !added.length && !removed.length && !changed.length };
}

function describeDiff(diff) {
  return [
    diff.added.length ? `new: ${diff.added.join("; ")}` : "",
    diff.changed.length ? `changed: ${diff.changed.join("; ")}` : "",
    diff.removed.length ? `gone: ${diff.removed.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

/**
 * The classified inventory of the tree: what the gate compares to the manifest.
 *
 * @returns {{ node: Record<string, Record<string, number>>, rust: Record<string, Record<string, number>>, patches: Record<string, Record<string, number>>, generated: Record<string, { programs: Array<{ in: string, sites: Record<string, number>, parsed: boolean, forbidden: string[] }> }>, unknownRoots: string[], failures: Array<{ code: string, file: string, message: string }> }}
 */
export function inventory({ files, readText }) {
  const node = {};
  const rust = {};
  const patches = {};
  const generated = {};
  const unknownRoots = [];
  const failures = [];
  const fail = (code, file, message) => failures.push({ code, file, message });

  for (const file of files) {
    if (NODE_SOURCE.test(file) && !/\.d\.[cm]?ts$/.test(file)) {
      const kind = classifyRoot(file);
      if (kind === "test" || kind === "tooling") continue;
      let text;
      try {
        text = readText(file);
      } catch {
        continue;
      }
      let scanned;
      try {
        scanned = scanCached(text, file);
      } catch (error) {
        fail("parse-error", file, `cannot parse for the launch scan: ${String(error.message).split("\n")[0]}`);
        continue;
      }
      if (scanned.sites.length === 0) continue;
      if (kind === "unknown") {
        unknownRoots.push(file);
        fail(
          "unknown-root",
          file,
          "launches a process but is outside every declared root (production src, test, tooling); move it under a src directory or declare its root in classifyRoot",
        );
        continue;
      }
      node[file] = countSites(scanned.sites);
      if (scanned.sites.some((site) => site.kind === "embedded-script") || REQUIRED_GENERATED_LAUNCHERS.includes(file)) {
        let programs;
        try {
          programs = /\.cjs$/.test(file) && scanned.sites.every((site) => site.kind !== "embedded-script")
            ? [{ line: 1, in: "<file>", text, rawText: text }]
            : extractEmbeddedPrograms(text, file);
        } catch (error) {
          fail("parse-error", file, `cannot extract generated programs: ${String(error.message).split("\n")[0]}`);
          continue;
        }
        generated[file] = {
          programs: programs.map((program) => {
            const result = scanEmbeddedProgram(program);
            return {
              in: program.in,
              sites: sortObject(
                Object.fromEntries(
                  Object.entries(countSites(result.sites)).map(([key, count]) => [key.replace(/^[^|]*\|/, ""), count]),
                ),
              ),
              parsed: result.parsed,
              forbidden: SCOPE_ESCAPE_PATTERNS.filter(([pattern]) => pattern.test(result.text) || pattern.test(program.rawText)).map(([, name]) => name),
            };
          }),
        };
      }
    } else if (/\.rs$/.test(file)) {
      if (/(?:^|\/)(?:tests|benches|examples)\//.test(file)) continue;
      if (!/^packages\/(?:paperclip-runner\/runner|process-launch\/helper)\//.test(file)) {
        const found = scanRustSource(readText(file)).sites;
        if (found.length) {
          unknownRoots.push(file);
          fail("unknown-root", file, "creates a process but is outside the declared Rust roots (the runner crates and the scope helper)");
        }
        continue;
      }
      const sites = scanRustSource(readText(file)).sites;
      if (sites.length) rust[file] = countSites(sites.map((site) => ({ ...site, kind: "rust", form: "call" })));
    } else if (/^patches\/.+\.patch$/.test(file)) {
      const { counts } = scanPatchText(readText(file));
      if (Object.keys(counts).length) patches[file] = sortObject(counts);
    }
  }
  return { node, rust, patches, generated, unknownRoots, failures };
}

function discoverMatrix({ files, readText }) {
  const ids = new Set();
  const registry = readText("server/src/adapters/registry.ts");
  for (const match of registry.matchAll(/^ {2}type: "([a-z0-9_]+)",$/gm)) ids.add(`adapter:${match[1]}`);
  const builtin = /new Set\(\[([\s\S]*?)\]\)/.exec(readText("server/src/adapters/builtin-adapter-types.ts"));
  for (const match of (builtin?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)) ids.add(`adapter:${match[1]}`);
  const shared = /AGENT_ADAPTER_TYPES = \[([\s\S]*?)\] as const/.exec(readText("packages/shared/src/constants.ts"));
  for (const match of (shared?.[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)) ids.add(`adapter:${match[1]}`);
  for (const file of files) {
    let match = /^packages\/adapters\/([^/]+)\/package\.json$/.exec(file);
    if (match) ids.add(`adapter-package:${match[1]}`);
    match = /^packages\/paperclip-runner\/src\/drivers\/([^/]+)\/[^/]+$/.exec(file);
    if (match) ids.add(`runner-driver:${match[1]}`);
    match = /^packages\/paperclip-runner\/src\/providers\/([^/]+)\/[^/]+$/.exec(file);
    if (match) ids.add(`runner-provider:${match[1]}`);
  }
  return ids;
}

const ROW_LAUNCH_KINDS = new Set(["shared-launch", "launch-root", "remote-only", "tombstone", "none"]);

/**
 * Compare the tree to the manifest.
 *
 * @returns {{ violations: Array<{ code: string, file: string, message: string }>, summary: Record<string, number> }}
 */
export function checkManifest({ manifest, files, readText }) {
  const violations = [];
  const fail = (code, file, message) => violations.push({ code, file, message });
  const fileSet = new Set(files);
  const found = inventory({ files, readText });
  violations.push(...found.failures);

  const classes = manifest.classes ?? {};
  const exemptions = manifest.exemptions ?? {};

  const validateEntry = (file, entry, area) => {
    const definition = classes[entry?.class];
    if (!definition) {
      fail("invalid-entry", file, `${area} entry has unknown class "${entry?.class}"; allowed: ${Object.keys(classes).join(", ")}`);
      return;
    }
    for (const field of definition.requires ?? []) {
      if (!entry[field] || (typeof entry[field] === "string" && entry[field].trim() === "")) {
        fail("invalid-entry", file, `${area} entry of class ${entry.class} needs "${field}"`);
      }
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON_LENGTH) {
      fail("invalid-entry", file, `${area} entry needs a reason of at least ${MIN_REASON_LENGTH} characters`);
    }
    if (entry.class === "control-plane-exempt" && !(entry.exemption in exemptions)) {
      fail("invalid-entry", file, `${area} entry has unknown exemption "${entry.exemption}"; allowed: ${Object.keys(exemptions).join(", ")}`);
    }
    for (const field of ["test", "containedBy"]) {
      if (entry[field]) {
        const targets = Array.isArray(entry[field]) ? entry[field] : [entry[field]];
        for (const target of targets) {
          if (!fileSet.has(target)) fail("invalid-entry", file, `${area} entry ${field} "${target}" is not a tracked file`);
        }
      }
    }
  };

  const compareArea = (area, expectedEntries = {}, actual) => {
    for (const [file, sites] of Object.entries(actual)) {
      const entry = expectedEntries[file];
      if (!entry) {
        fail(
          "unclassified",
          file,
          `${area} launches a process and has no manifest entry (${Object.keys(sites).join(", ")}). Classify it in scripts/process-launch-coverage/manifest.json`,
        );
        continue;
      }
      validateEntry(file, entry, area);
      const diff = diffCounts(entry.sites, sites);
      if (!diff.equal) fail("site-drift", file, `${area} launch sites differ from the manifest: ${describeDiff(diff)}`);
    }
    for (const file of Object.keys(expectedEntries)) {
      if (!(file in actual)) fail("stale-entry", file, `${area} manifest entry has no launch site in the tree any more; remove it`);
    }
  };

  compareArea("node", manifest.files, found.node);
  compareArea("rust", manifest.rust, found.rust);

  // Patches: the patched dependency's added launch code.
  for (const [file, counts] of Object.entries(found.patches)) {
    const entry = manifest.patches?.[file];
    if (!entry) {
      fail("unclassified", file, `patch adds process-launch code (${Object.keys(counts).join(", ")}) and has no manifest entry`);
      continue;
    }
    validateEntry(file, entry, "patch");
    const diff = diffCounts(entry.added, counts);
    if (!diff.equal) fail("site-drift", file, `patch launch code differs from the manifest: ${describeDiff(diff)}`);
  }
  for (const file of Object.keys(manifest.patches ?? {})) {
    if (!(file in found.patches)) fail("stale-entry", file, "patch manifest entry matches no added launch code; remove it");
  }
  for (const file of REQUIRED_PATCHES) {
    if (!fileSet.has(file)) fail("missing-required", file, "the patched acpx dependency is part of the launch coverage and must stay in the manifest scan");
    else if (!manifest.patches?.[file]) fail("missing-required", file, "the patched acpx dependency needs a manifest entry");
    else if (!/spawnAgent-hook/.test(Object.keys(found.patches[file] ?? {}).join(","))) {
      fail("missing-required", file, "the patched acpx no longer adds the spawnAgent launch hook the host relies on");
    }
  }

  // Generated launchers: the program text, not only the file that holds it.
  for (const file of REQUIRED_GENERATED_LAUNCHERS) {
    if (!fileSet.has(file)) fail("missing-required", file, "a required generated launcher file is gone; update REQUIRED_GENERATED_LAUNCHERS with its replacement");
    else if (!manifest.generatedLaunchers?.[file]) fail("missing-required", file, "generated launcher has no manifest entry");
  }
  for (const [file, actual] of Object.entries(found.generated)) {
    const entry = manifest.generatedLaunchers?.[file];
    if (!entry) {
      fail("unclassified", file, "file holds generated launcher programs and has no generatedLaunchers entry");
      continue;
    }
    validateEntry(file, entry, "generated launcher");
    if (actual.programs.length !== (entry.programs ?? []).length) {
      fail("site-drift", file, `generated launcher programs: manifest lists ${(entry.programs ?? []).length}, tree has ${actual.programs.length}`);
      continue;
    }
    actual.programs.forEach((program, index) => {
      const expected = entry.programs[index];
      if (!program.parsed) fail("generated-launcher", file, `generated program in ${program.in} does not parse, so its launch calls cannot be verified`);
      if (program.in !== expected.in) fail("site-drift", file, `generated program ${index} moved from ${expected.in} to ${program.in}`);
      const diff = diffCounts(expected.sites, program.sites);
      if (!diff.equal) fail("site-drift", file, `generated program in ${program.in} launches differently: ${describeDiff(diff)}`);
      if (program.forbidden.length) {
        fail("generated-launcher", file, `generated program in ${program.in} leaves its scope: ${program.forbidden.join(", ")}`);
      }
    });
  }
  for (const file of Object.keys(manifest.generatedLaunchers ?? {})) {
    if (!(file in found.generated)) fail("stale-entry", file, "generated launcher manifest entry holds no generated program any more");
  }

  // Registered adapters and drivers all have a matrix row.
  const discovered = discoverMatrix({ files, readText });
  const rows = new Map();
  for (const row of manifest.matrix ?? []) {
    if (rows.has(row.id)) fail("invalid-entry", row.id, "duplicate matrix row");
    rows.set(row.id, row);
    if (!ROW_LAUNCH_KINDS.has(row.launch)) fail("invalid-entry", row.id, `matrix row launch must be one of ${[...ROW_LAUNCH_KINDS].join(", ")}`);
    if (typeof row.reason !== "string" || row.reason.trim().length < MIN_REASON_LENGTH) {
      fail("invalid-entry", row.id, `matrix row needs a reason of at least ${MIN_REASON_LENGTH} characters`);
    }
    if (row.launch !== "remote-only" && row.launch !== "tombstone" && !row.via?.length) {
      fail("invalid-entry", row.id, "a row that can start a local process names the files that launch it (via)");
    }
    if (!row.test) fail("invalid-entry", row.id, "matrix row needs a test");
    for (const field of ["via", "test"]) {
      for (const target of [].concat(row[field] ?? [])) {
        if (!fileSet.has(target)) fail("invalid-entry", row.id, `matrix row ${field} "${target}" is not a tracked file`);
      }
    }
    if (row.launch === "remote-only" || row.launch === "tombstone" || row.launch === "none") {
      if (!row.owns?.length) fail("invalid-entry", row.id, `a ${row.launch} row names the paths it owns (owns) so the gate can prove they launch nothing`);
      for (const prefix of row.owns ?? []) {
        for (const launcher of [...Object.keys(manifest.files ?? {}), ...Object.keys(manifest.generatedLaunchers ?? {})]) {
          if (launcher.startsWith(prefix)) {
            fail("matrix-launches", row.id, `is ${row.launch} but ${launcher} (under ${prefix}) launches processes; give the row a launch kind and via`);
          }
        }
      }
    }
    for (const target of row.via ?? []) {
      if (!manifest.files?.[target] && !manifest.generatedLaunchers?.[target]) {
        fail("invalid-entry", row.id, `matrix row via "${target}" is not a classified launch file; list the launch primitive it goes through`);
      }
    }
  }
  for (const id of discovered) {
    if (!rows.has(id)) fail("matrix-missing-row", id, "is registered but has no launch coverage matrix row");
  }
  for (const id of rows.keys()) {
    if (!discovered.has(id)) fail("matrix-stale-row", id, "has a matrix row but is not registered; remove the row");
  }

  // Docs and wiring.
  for (const doc of manifest.docs ?? []) {
    if (!fileSet.has(doc.file)) {
      fail("doc-missing", doc.file, "required documentation file is missing");
      continue;
    }
    const text = readText(doc.file);
    for (const needle of doc.mustContain ?? []) {
      if (!text.includes(needle)) fail("doc-missing", doc.file, `must contain "${needle}"`);
    }
  }
  for (const wire of manifest.wiring ?? []) {
    if (!fileSet.has(wire.file)) {
      fail("wiring-missing", wire.file, "file that must run the gate is missing");
      continue;
    }
    if (!readText(wire.file).includes(wire.mustContain)) fail("wiring-missing", wire.file, `must run the gate: expected "${wire.mustContain}"`);
  }

  return {
    violations,
    summary: {
      nodeFiles: Object.keys(found.node).length,
      nodeSites: Object.values(found.node).reduce((total, sites) => total + Object.values(sites).reduce((a, b) => a + b, 0), 0),
      rustFiles: Object.keys(found.rust).length,
      patches: Object.keys(found.patches).length,
      generatedLauncherFiles: Object.keys(found.generated).length,
      matrixRows: rows.size,
    },
    inventory: found,
  };
}

export function readRepoFile(root) {
  return (file) => readFileSync(path.join(root, file), "utf8");
}

export function loadManifest(root) {
  return JSON.parse(readFileSync(path.join(root, "scripts/process-launch-coverage/manifest.json"), "utf8"));
}

export function runGate({ root, manifest = loadManifest(root), files = listTrackedFiles(root), readText = readRepoFile(root) }) {
  return checkManifest({ manifest, files, readText });
}

/**
 * Check that an external adapter package uses the shared launch contract: its
 * source may not hold a launch site of its own. Returns the sites it found.
 */
export function scanExternalAdapter({ directory, files, readText }) {
  const sites = [];
  for (const file of files) {
    if (!NODE_SOURCE.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
    if (classifyRoot(file) === "test" || /(?:^|\/)node_modules\//.test(file) || /(?:^|\/)dist\//.test(file)) continue;
    const text = readText(file);
    for (const site of scanSource(text, file).sites) sites.push({ file: path.posix.join(directory, file), ...site });
  }
  return sites;
}

/** Refresh the pinned site counts of the manifest from the tree. Classes and reasons stay as written; new launch files are added as "unclassified", which still fails the gate. */
export function regenerateManifest({ manifest, files, readText }) {
  const found = inventory({ files, readText });
  const next = structuredClone(manifest);
  const refresh = (area, key, actual) => {
    const section = (next[area] ??= {});
    for (const file of Object.keys(section)) if (!(file in actual)) delete section[file];
    for (const [file, value] of Object.entries(actual)) {
      section[file] = { ...(section[file] ?? { class: "unclassified" }), [key]: value };
    }
  };
  refresh("files", "sites", found.node);
  refresh("rust", "sites", found.rust);
  refresh("patches", "added", found.patches);
  const programs = Object.fromEntries(
    Object.entries(found.generated).map(([file, value]) => [file, value.programs.map(({ in: fn, sites }) => ({ in: fn, sites }))]),
  );
  refresh("generatedLaunchers", "programs", programs);
  return next;
}
