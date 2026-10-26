import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkManifest, classifyRoot, listTrackedFiles, loadManifest, readRepoFile, regenerateManifest } from "./process-launch-coverage/gate.mjs";
import { scanSource } from "./process-launch-coverage/scan.mjs";
import { scanRustSource } from "./process-launch-coverage/scan-rust.mjs";
import { scanPatchText } from "./process-launch-coverage/scan-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const trackedFiles = listTrackedFiles(root);
const readReal = readRepoFile(root);

/** Run the gate against the real tree with files added or replaced in memory. */
function gate({ overlay = {}, manifest = loadManifest(root), drop = [] } = {}) {
  const files = [...new Set([...trackedFiles, ...Object.keys(overlay)])].filter((file) => !drop.includes(file));
  const readText = (file) => (file in overlay ? overlay[file] : readReal(file));
  return checkManifest({ manifest, files, readText }).violations;
}

function codes(violations) {
  return violations.map((violation) => `${violation.code}:${violation.file}`);
}

function expectViolation(violations, code, file) {
  assert.ok(
    violations.some((violation) => violation.code === code && (file === undefined || violation.file === file)),
    `expected ${code}${file ? ` for ${file}` : ""}, got ${JSON.stringify(codes(violations))}`,
  );
}

test("the gate passes on the current tree", () => {
  const violations = gate();
  assert.deepEqual(violations, []);
});

test("the CLI exits 0 on the current tree", () => {
  const result = spawnSync(process.execPath, [path.join(root, "scripts/check-process-launch-coverage.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Process-launch coverage gate passed/);
});

test("scanner reports every Node launch form, including aliases and indirect use", () => {
  const forms = {
    alias: [`import { spawn as launch } from "node:child_process"; export function f(){ return launch("x", []); }`, "spawn"],
    promisifiedExecFile: [
      `import { execFile } from "node:child_process"; import { promisify } from "node:util"; const run = promisify(execFile); export async function f(){ await run("x", []); }`,
      "execFile",
    ],
    execFileSync: [`import { execFileSync } from "child_process"; export const f = () => execFileSync("x");`, "execFileSync"],
    spawnSync: [`import cp from "node:child_process"; export function f(){ return cp.spawnSync("x"); }`, "spawnSync"],
    fork: [`import { fork } from "node:child_process"; export function f(){ return fork("w.js"); }`, "fork"],
    namespaceElement: [`import * as cp from "node:child_process"; export function f(){ return cp["spawn"]("x"); }`, "spawn"],
    dynamicImport: [`export async function f(){ const { spawn } = await import("node:child_process"); return spawn("x"); }`, "spawn"],
    require: [`const { spawn } = require("node:child_process"); module.exports = () => spawn("x");`, "spawn"],
    getBuiltinModule: [`export function f(){ return process.getBuiltinModule("node:child_process").spawn("x"); }`, "spawn"],
    library: [`import { execa } from "execa"; export const f = () => execa("x");`, "execa"],
    sdkHook: [`export function f(acpx){ return acpx.createAcpRuntime({ spawnAgent: (cmd) => cmd }); }`, "spawnAgent"],
  };
  for (const [name, [source, api]] of Object.entries(forms)) {
    const { sites, parseErrors } = scanSource(source, "x.ts");
    assert.deepEqual(parseErrors, [], name);
    assert.ok(sites.some((site) => site.api === api || site.api.endsWith(`#${api}`)), `${name}: no ${api} site in ${JSON.stringify(sites)}`);
  }
});

test("scanner ignores type-only imports, unused bindings and regex exec", () => {
  for (const source of [
    `import type { ChildProcess } from "node:child_process"; export type T = ChildProcess;`,
    `import { spawn } from "node:child_process"; export const x = 1;`,
    `export const m = /a/.exec("a");`,
  ]) {
    assert.deepEqual(scanSource(source, "x.ts").sites, [], source);
  }
});

test("scanner finds launch calls inside generated program text", () => {
  const source = "export const program = `const { spawn } = require('node:child_process'); spawn('x');`;";
  assert.ok(scanSource(source, "x.ts").sites.some((site) => site.kind === "embedded-script"));
  const array = 'export const lines = ["const cp = require(\\"node:child_process\\");", "cp.spawn(\\"x\\");"];';
  assert.ok(scanSource(array, "x.ts").sites.some((site) => site.kind === "embedded-script"));
});

test("Rust scanner finds an aliased Command import, exec and fork but not comments, strings or cfg(test)", () => {
  const source = [
    "use std::process::Command as Cmd;",
    "// Command::new(\"ignored\")",
    "fn a() { let s = \"Command::new(x)\"; }",
    "fn b() { Cmd::new(\"x\"); }",
    "fn c() { unsafe { libc::fork(); libc::execv(p, a); } }",
    "#[cfg(test)]\nmod tests { fn t() { Command::new(\"t\"); } }",
  ].join("\n");
  const found = scanRustSource(source).sites.map((site) => `${site.in}|${site.api}`);
  assert.ok(found.includes("<module>|Command::alias"), JSON.stringify(found));
  assert.ok(found.some((entry) => entry.startsWith("c|libc::fork")), JSON.stringify(found));
  assert.ok(!found.some((entry) => entry.startsWith("a|")), JSON.stringify(found));
  assert.ok(!found.some((entry) => entry.startsWith("t|")), JSON.stringify(found));
});

test("patch scanner counts only added lines", () => {
  const patch = [
    "diff --git a/x.js b/x.js",
    "--- a/x.js",
    "+++ b/x.js",
    "@@ -1,2 +1,3 @@",
    "-const old = spawn(a);",
    "+const child = spawn(command, args);",
    " const keep = spawn(b);",
  ].join("\n");
  assert.equal(scanPatchText(patch).counts.spawn, 1);
});

test("root classification has no blanket exemption for server scripts or src directories", () => {
  assert.equal(classifyRoot("server/src/scripts/x.ts"), "production");
  assert.equal(classifyRoot("server/src/services/x.ts"), "production");
  assert.equal(classifyRoot("packages/foo/src/x.ts"), "production");
  assert.equal(classifyRoot("packages/foo/src/test-support/x.ts"), "production");
  assert.equal(classifyRoot("server/scripts/x.ts"), "tooling");
  assert.equal(classifyRoot("scripts/x.mjs"), "tooling");
  assert.equal(classifyRoot("packages/foo/tests/x.ts"), "test");
  assert.equal(classifyRoot("packages/foo/src/x.test.ts"), "test");
  assert.equal(classifyRoot("server/src/__tests__/x.ts"), "test");
  assert.equal(classifyRoot("something-new/lib/x.ts"), "unknown");
});

const BYPASSES = {
  "aliased import in a new production file": {
    overlay: { "server/src/services/new-bypass.ts": `import { spawn as go } from "node:child_process";\nexport function run(){ return go("sh", ["-c", "work"]); }\n` },
    code: "unclassified",
    file: "server/src/services/new-bypass.ts",
  },
  "promisified execFile in a new production file": {
    overlay: { "packages/adapter-utils/src/new-bypass.ts": `import { execFile } from "node:child_process";\nimport { promisify } from "node:util";\nconst run = promisify(execFile);\nexport const go = () => run("sh");\n` },
    code: "unclassified",
    file: "packages/adapter-utils/src/new-bypass.ts",
  },
  "createRequire binding with another name in a new production file": {
    overlay: { "server/src/services/require-bypass.ts": `import { createRequire } from "node:module";\nconst r = createRequire(import.meta.url);\nexport const go = () => r("node:child_process").execFile("sh");\n` },
    code: "unclassified",
    file: "server/src/services/require-bypass.ts",
  },
  "createRequire imported under another name": {
    overlay: { "server/src/services/require-bypass2.ts": `import { createRequire as make } from "node:module";\nconst load = make(import.meta.url);\nconst { spawn } = load("node:child_process");\nexport const go = () => spawn("sh");\n` },
    code: "unclassified",
    file: "server/src/services/require-bypass2.ts",
  },
  "execFileSync in a new production file": {
    overlay: { "server/src/new-bypass.ts": `import { execFileSync } from "node:child_process";\nexport const go = () => execFileSync("sh");\n` },
    code: "unclassified",
    file: "server/src/new-bypass.ts",
  },
  "fork in a new production file": {
    overlay: { "server/src/services/worker-bypass.ts": `import { fork } from "node:child_process";\nexport const go = () => fork("w.js");\n` },
    code: "unclassified",
    file: "server/src/services/worker-bypass.ts",
  },
  "dynamic import of child_process": {
    overlay: { "packages/shared/src/dyn-bypass.ts": `export async function go(){ const cp = await import("node:child_process"); return cp.spawn("sh"); }\n` },
    code: "unclassified",
    file: "packages/shared/src/dyn-bypass.ts",
  },
  "SDK launch hook": {
    overlay: { "packages/adapter-utils/src/hook-bypass.ts": `export const go = (rt) => rt.createAcpRuntime({ spawnAgent: (c) => c });\n` },
    code: "unclassified",
    file: "packages/adapter-utils/src/hook-bypass.ts",
  },
  "a script under server/src/scripts is not exempt": {
    overlay: { "server/src/scripts/bypass.ts": `import { spawn } from "node:child_process";\nexport const go = () => spawn("sh");\n` },
    code: "unclassified",
    file: "server/src/scripts/bypass.ts",
  },
  "launch outside every declared root": {
    overlay: { "somewhere-new/lib/bypass.js": `const { spawn } = require("node:child_process");\nmodule.exports = () => spawn("sh");\n` },
    code: "unknown-root",
    file: "somewhere-new/lib/bypass.js",
  },
  "a new Rust Command in a runner crate": {
    overlay: { "packages/paperclip-runner/runner/crates/runner-core/src/bypass.rs": `use std::process::Command;\nfn go() { Command::new("sh").spawn().ok(); }\n` },
    code: "unclassified",
    file: "packages/paperclip-runner/runner/crates/runner-core/src/bypass.rs",
  },
  "Rust Command outside the declared Rust roots": {
    overlay: { "elsewhere/src/bypass.rs": `use std::process::Command;\nfn go() { Command::new("sh"); }\n` },
    code: "unknown-root",
    file: "elsewhere/src/bypass.rs",
  },
  "a patch that adds a new spawn": {
    overlay: { "patches/other-dep@1.0.0.patch": ["diff --git a/index.js b/index.js", "--- a/index.js", "+++ b/index.js", "@@ -1 +1,2 @@", " keep", "+const child = spawn(cmd, args);"].join("\n") },
    code: "unclassified",
    file: "patches/other-dep@1.0.0.patch",
  },
  "an extra launch in an already classified file": {
    mutate: (overlay) => {
      const file = "server/src/services/photon/media.ts";
      overlay[file] = `${readReal(file)}\nimport { execFile as extraLaunch } from "node:child_process";\nexport const extra = () => extraLaunch("sh");\n`;
      return file;
    },
    code: "site-drift",
  },
  "an extra launch added to a generated launcher program": {
    mutate: (overlay) => {
      const file = "packages/adapter-utils/src/local-process-sandbox.ts";
      overlay[file] = readReal(file).replace("createNetworkProxyBridge", "createNetworkProxyBridge").replace(/spawn\(/, "spawn(");
      const source = readReal(file);
      const marker = source.indexOf("child_process");
      assert.ok(marker > 0, "launcher marker present");
      overlay[file] = `${source}\nexport const injected = "const { spawn: s2 } = require('node:child_process'); s2('sh');";\n`;
      return file;
    },
    code: "site-drift",
  },
  "a generated launcher that detaches into its own session": {
    mutate: (overlay) => {
      const file = "packages/adapter-utils/src/github-launcher.ts";
      const source = readReal(file);
      assert.ok(/\bspawn\(/.test(source), "launcher spawns");
      overlay[file] = source.replace(/\bspawn\(([^)]*)\)/, "spawn($1, { detached: true })");
      return file;
    },
    code: "generated-launcher",
  },
};

for (const [name, bypass] of Object.entries(BYPASSES)) {
  test(`gate fails on: ${name}`, () => {
    const overlay = { ...(bypass.overlay ?? {}) };
    const file = bypass.mutate ? bypass.mutate(overlay) : bypass.file;
    expectViolation(gate({ overlay }), bypass.code, file);
  });
}

test("gate fails when a registered adapter has no matrix row", () => {
  const registry = readReal("server/src/adapters/registry.ts");
  const overlay = { "server/src/adapters/registry.ts": `${registry}\nconst injected = {\n  type: "brand_new_local",\n};\n` };
  expectViolation(gate({ overlay }), "matrix-missing-row", "adapter:brand_new_local");
});

test("gate fails when a runner driver or adapter package has no matrix row", () => {
  const overlay = {
    "packages/paperclip-runner/src/drivers/newdriver/driver.ts": "export const x = 1;\n",
    "packages/adapters/new-local/package.json": "{}\n",
  };
  const violations = gate({ overlay });
  expectViolation(violations, "matrix-missing-row", "runner-driver:newdriver");
  expectViolation(violations, "matrix-missing-row", "adapter-package:new-local");
});

test("gate fails when a remote-only row starts to launch a process", () => {
  const manifest = loadManifest(root);
  const row = manifest.matrix.find((entry) => entry.id === "adapter:http");
  const overlay = { "server/src/adapters/http/launch-bypass.ts": `import { spawn } from "node:child_process";\nexport const go = () => spawn("sh");\n` };
  const next = structuredClone(manifest);
  next.files["server/src/adapters/http/launch-bypass.ts"] = {
    class: "control-plane-exempt",
    owner: "test",
    exemption: "host-lookup",
    reason: "An attempt to hide a launch behind an exemption inside a remote-only adapter.",
    sites: { "go|node-builtin:spawn:call": 1 },
  };
  assert.ok(row.owns.some((prefix) => "server/src/adapters/http/launch-bypass.ts".startsWith(prefix)));
  expectViolation(gate({ overlay, manifest: next }), "matrix-launches", "adapter:http");
});

test("gate fails on manifest drift in both directions and on invalid entries", () => {
  const manifest = loadManifest(root);

  const fewer = structuredClone(manifest);
  const target = "server/src/services/photon/media.ts";
  fewer.files[target].sites = {};
  expectViolation(gate({ manifest: fewer }), "site-drift", target);

  const stale = structuredClone(manifest);
  stale.files["server/src/services/deleted-long-ago.ts"] = { ...stale.files[target] };
  expectViolation(gate({ manifest: stale }), "stale-entry", "server/src/services/deleted-long-ago.ts");

  const noReason = structuredClone(manifest);
  noReason.files[target].reason = "ok";
  expectViolation(gate({ manifest: noReason }), "invalid-entry", target);

  const noExemption = structuredClone(manifest);
  delete noExemption.files[target].exemption;
  expectViolation(gate({ manifest: noExemption }), "invalid-entry", target);

  const noTest = structuredClone(manifest);
  noTest.files["packages/process-launch/src/launch.ts"].test = "packages/process-launch/src/missing.test.ts";
  expectViolation(gate({ manifest: noTest }), "invalid-entry", "packages/process-launch/src/launch.ts");

  const unknownClass = structuredClone(manifest);
  unknownClass.files[target].class = "whatever";
  expectViolation(gate({ manifest: unknownClass }), "invalid-entry", target);
});

test("gate fails when a required generated launcher, patch or doc statement disappears", () => {
  const manifest = loadManifest(root);
  const noLauncher = structuredClone(manifest);
  delete noLauncher.generatedLaunchers["packages/paperclip-runner/src/providers/grok/launcher.cjs"];
  expectViolation(gate({ manifest: noLauncher }), "missing-required", "packages/paperclip-runner/src/providers/grok/launcher.cjs");

  const noPatch = structuredClone(manifest);
  delete noPatch.patches["patches/acpx@0.13.1.patch"];
  expectViolation(gate({ manifest: noPatch }), "missing-required", "patches/acpx@0.13.1.patch");

  const overlay = { "packages/adapters/AUTHORING.md": "# Authoring\n" };
  expectViolation(gate({ overlay }), "doc-missing", "packages/adapters/AUTHORING.md");
});

test("--write adds a new launch file as unclassified, which still fails the gate", () => {
  const overlay = { "server/src/services/another-bypass.ts": `import { spawn } from "node:child_process";\nexport const go = () => spawn("sh");\n` };
  const files = [...trackedFiles, ...Object.keys(overlay)];
  const readText = (file) => (file in overlay ? overlay[file] : readReal(file));
  const regenerated = regenerateManifest({ manifest: loadManifest(root), files, readText });
  assert.equal(regenerated.files["server/src/services/another-bypass.ts"].class, "unclassified");
  expectViolation(checkManifest({ manifest: regenerated, files, readText }).violations, "invalid-entry", "server/src/services/another-bypass.ts");
});

test("--write on the current tree changes nothing", () => {
  const manifest = loadManifest(root);
  assert.deepEqual(regenerateManifest({ manifest, files: trackedFiles, readText: readReal }), manifest);
});

test("--external accepts an adapter that uses the shared launch API and rejects a raw launch", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "paperclip-external-adapter-"));
  const run = () =>
    spawnSync(process.execPath, [path.join(root, "scripts/check-process-launch-coverage.mjs"), "--external", directory], { encoding: "utf8" });
  try {
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(
      path.join(directory, "src/execute.js"),
      `import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";\nexport const execute = (ctx) => runChildProcess(ctx.runId, "tool", [], { cwd: ".", env: {}, timeoutSec: 1, graceSec: 1, onLog: async () => {} });\n`,
    );
    const ok = run();
    assert.equal(ok.status, 0, ok.stderr);

    writeFileSync(path.join(directory, "src/bypass.js"), `import { spawn as launch } from "node:child_process";\nexport const go = () => launch("tool", []);\n`);
    const bad = run();
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /bypass\.js/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const installedAcpxInventory = {
  "0.12.0": [
    "flows.js|runShellAction|spawn:call",
    "live-checkpoint.js|<module>|execFile:reference",
    "live-checkpoint.js|killWindowsProcessTree|spawn:call",
    "live-checkpoint.js|readCommandOutput|spawn:call",
    "live-checkpoint.js|runProcessGroupListCommand|spawn:call",
    "live-checkpoint.js|runProcessListCommand|spawn:call",
    "live-checkpoint.js|runWindowsProcessListCommand|spawn:call",
    "live-checkpoint.js|runWslpath|execFile:call",
    "live-checkpoint.js|spawnAgentProcess|spawn:call",
    "live-checkpoint.js|spawnAndWait|spawn:call",
    "output.js|<module>|execFile:reference",
    "output.js|readPosixCommandLine|execFile:call",
    "output.js|readWindowsCommandLine|execFile:call",
    "output.js|spawnQueueOwnerProcess|spawn:call",
    "runtime.js|createClient|spawnAgent:reference",
  ],
  "0.13.1": [
    "flows.js|runShellAction|spawn:call",
    "live-checkpoint.js|killWindowsProcessTree|spawn:call",
    "live-checkpoint.js|readCommandOutput|spawn:call",
    "live-checkpoint.js|runTimedExecFile|execFile:call",
    "live-checkpoint.js|spawnAgentProcess|spawn:call",
    "live-checkpoint.js|spawnAndWait|spawn:call",
    "output.js|spawnQueueOwnerProcess|spawn:call",
    "runtime.js|createClient|spawnAgent:reference",
  ],
};

for (const [version, expected] of Object.entries(installedAcpxInventory)) {
  test(`installed patched acpx ${version}: agent launch goes through the spawnAgent hook and no launch site is added silently`, (t) => {
    const store = path.join(root, "node_modules/.pnpm");
    const entry = existsSync(store) ? readdirSync(store).find((name) => name.startsWith(`acpx@${version}_patch_hash=`)) : undefined;
    if (!entry) return t.skip(`patched acpx ${version} is not installed`);
    const dist = path.join(store, entry, "node_modules/acpx/dist");
    const actual = [];
    for (const name of readdirSync(dist).filter((file) => file.endsWith(".js"))) {
      const source = readFileSync(path.join(dist, name), "utf8");
      for (const site of scanSource(source, name).sites) {
        actual.push(`${name.replace(/-[\w-]{8}\.js$/, ".js")}|${site.in}|${site.api}:${site.form}`);
      }
      if (name.startsWith("live-checkpoint-")) {
        assert.match(
          source,
          /async spawnAgentProcess\(plan\) \{[\s\S]*?this\.options\.spawnAgent\s*\?\s*this\.options\.spawnAgent\(\{[\s\S]*?\}\)\s*:\s*spawn\(/,
          "the agent launch must prefer the host hook",
        );
      }
    }
    assert.deepEqual(actual.sort(), expected);
  });
}
