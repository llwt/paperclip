import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, inject, it } from "vitest";
import { tempDirs } from "./test-support.js";

// Packs this package the way a release does, installs the tarball into a
// clean consumer and checks the helper there: path, executable bit, and
// that the installed API finds it.

const helper = inject("scopeHelper");
const helperSkip = inject("scopeHelperSkipReason");
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = tempDirs();
afterEach(() => temp.cleanup());

function pnpmCommand(): string[] {
  const script = process.env.npm_execpath;
  return script?.endsWith("pnpm.cjs") ? [process.execPath, script] : ["pnpm"];
}

describe.skipIf(helperSkip !== null)(`installed package${helperSkip ? `: skipped, ${helperSkip}` : ""}`, () => {
  it("installs an executable helper that the installed API resolves", async () => {
    const root = temp.make("pcl-pack-");
    const source = path.join(root, "source");
    const output = path.join(root, "out");
    const consumer = path.join(root, "consumer");
    const home = path.join(root, "home");
    for (const dir of [source, output, consumer, home]) mkdirSync(dir, { recursive: true });
    for (const file of ["user.npmrc", "global.npmrc"]) writeFileSync(path.join(home, file), "");
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: root,
      CI: "true",
      npm_config_userconfig: path.join(home, "user.npmrc"),
      npm_config_globalconfig: path.join(home, "global.npmrc"),
      npm_config_cache: path.join(home, "cache"),
      npm_config_ignore_scripts: "true",
      npm_config_offline: "true",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    };
    const run = (command: string, args: string[], cwd: string) =>
      execFileSync(command, args, { cwd, env, encoding: "utf8", timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });

    copyFileSync(path.join(packageRoot, "package.json"), path.join(source, "package.json"));
    const typescriptRoot = path.dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
    run(process.execPath, [path.join(typescriptRoot, "bin", "tsc"), "-p", path.join(packageRoot, "tsconfig.json"), "--outDir", path.join(source, "dist")], packageRoot);
    mkdirSync(path.join(source, "dist", "bin"));
    const staged = path.join(source, "dist", "bin", "paperclip-scope-exec");
    copyFileSync(helper!, staged);
    // Pack from a non-executable file: the installed mode must come from
    // publishConfig.executableFiles, not from the build machine.
    chmodSync(staged, 0o644);

    const pnpm = pnpmCommand();
    run(pnpm[0]!, [...pnpm.slice(1), "pack", "--pack-destination", output], source);
    const archives = readdirSync(output).filter((name) => name.endsWith(".tgz"));
    expect(archives).toHaveLength(1);
    writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true }));
    run("npm", ["install", "--offline", "--ignore-scripts", "--package-lock=false", path.join(output, archives[0]!)], consumer);

    const installedRoot = path.join(consumer, "node_modules", "@paperclipai", "process-launch");
    const installedHelper = path.join(installedRoot, "dist", "bin", "paperclip-scope-exec");
    expect(statSync(installedHelper).isFile()).toBe(true);
    accessSync(installedHelper, constants.X_OK);
    expect(statSync(installedHelper).mode & 0o111).not.toBe(0);

    const api = (await import(pathToFileURL(path.join(installedRoot, "dist", "index.js")).href)) as typeof import("./index.js");
    expect(api.resolveHelperPath()).toBe(installedHelper);
    expect(run(installedHelper, ["--version"], consumer)).toMatch(/^paperclip-scope-exec \d+\.\d+\.\d+\n$/);
  });
});
