import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_MANIFEST_VERSION,
  MANAGED_SHIM_MARKER,
  addManagedPathBlock,
  buildNextManifest,
  flipCurrentAtomic,
  isManagedExecutable,
  isInstallPayloadInUse,
  payloadPathFor,
  pruneInstallPayloads,
  readInstallManifest,
  removeManagedPathBlock,
  removeManagedShim,
  resolveInstallStorePaths,
  withInstallStoreLock,
  writeInstallManifestAtomic,
  writeManagedShim,
  type InstallManifest,
  type InstallRecord,
} from "../install-store.js";

function record(payloadPath: string, version: string): InstallRecord {
  return {
    source: "npm",
    version,
    channel: "latest",
    payloadPath,
    installedAt: `2026-07-${version.padStart(2, "0")}T00:00:00.000Z`,
  };
}

describe("managed install store", () => {
  let root: string;
  let paths: ReturnType<typeof resolveInstallStorePaths>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-install-store-"));
    paths = resolveInstallStorePaths({
      homeDir: path.join(root, "home"),
      paperclipHome: path.join(root, "home", ".paperclip"),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves the documented npm and git payload layout", () => {
    expect(payloadPathFor(paths, "npm", "2026.720.0")).toBe(
      path.join(paths.cliRoot, "installs", "npm", "2026.720.0"),
    );
    expect(payloadPathFor(paths, "git", "ab12cd34ef56")).toBe(
      path.join(paths.cliRoot, "installs", "git", "ab12cd34ef56"),
    );
  });

  it("writes and reads the manifest atomically with private permissions", () => {
    const payloadPath = payloadPathFor(paths, "npm", "1.2.3");
    const manifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(payloadPath, "1.2.3"),
      previous: [],
    };
    writeInstallManifestAtomic(manifest, paths);
    expect(readInstallManifest(paths)).toEqual(manifest);
    expect(fs.statSync(paths.manifestPath).mode & 0o777).toBe(0o600);
  });

  it("leaves the old current payload working when interrupted before rename", () => {
    const oldPayload = payloadPathFor(paths, "npm", "1.0.0");
    const newPayload = payloadPathFor(paths, "npm", "2.0.0");
    fs.mkdirSync(oldPayload, { recursive: true });
    fs.mkdirSync(newPayload, { recursive: true });
    flipCurrentAtomic(oldPayload, paths);

    expect(() =>
      flipCurrentAtomic(newPayload, paths, {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).toThrow("simulated crash");

    expect(fs.realpathSync(paths.currentPath)).toBe(fs.realpathSync(oldPayload));
    expect(fs.readdirSync(paths.cliRoot).filter((entry) => entry.startsWith(".current-"))).toEqual([]);
  });

  it("retains current plus two previous payloads and prunes older entries", () => {
    const payloads = ["1", "2", "3", "4"].map((version) => payloadPathFor(paths, "npm", version));
    for (const payload of payloads) fs.mkdirSync(payload, { recursive: true });
    const previousManifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(payloads[2], "3"),
      previous: [record(payloads[1], "2"), record(payloads[0], "1")],
    };
    const next = buildNextManifest(record(payloads[3], "4"), previousManifest);

    expect(next.previous.map((entry) => entry.version)).toEqual(["3", "2"]);
    expect(pruneInstallPayloads(next, paths, { checkPayloadInUse: () => false })).toEqual([payloads[0]]);
    expect(fs.existsSync(payloads[0])).toBe(false);
    expect(payloads.slice(1).every((payload) => fs.existsSync(payload))).toBe(true);
  });

  function pruningFixture() {
    const current = payloadPathFor(paths, "npm", "4");
    const old = payloadPathFor(paths, "git", "old-sha");
    fs.mkdirSync(current, { recursive: true });
    fs.mkdirSync(old, { recursive: true });
    const procRoot = path.join(root, "proc");
    const processRoot = path.join(procRoot, "123");
    fs.mkdirSync(processRoot, { recursive: true });
    const manifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(current, "4"),
      previous: [],
    };
    return { old, procRoot, processRoot, manifest };
  }

  it.each(["exe", "cwd"])("keeps a payload with a live %s and prunes it once free", (link) => {
    const { old, procRoot, processRoot, manifest } = pruningFixture();
    const nested = path.join(old, "node_modules", "postgres");
    fs.mkdirSync(nested, { recursive: true });
    fs.symlinkSync(link === "exe" ? nested : root, path.join(processRoot, "exe"));
    fs.symlinkSync(link === "cwd" ? nested : root, path.join(processRoot, "cwd"));
    const report = vi.fn();
    const hooks = {
      checkPayloadInUse: (payload: string) => isInstallPayloadInUse(payload, { platform: "linux", procRoot }),
      report,
    };
    expect(pruneInstallPayloads(manifest, paths, hooks)).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
    expect(report).toHaveBeenCalledWith(`Kept install payload ${old}: a live process runs from this payload.`);

    fs.rmSync(processRoot, { recursive: true });
    fs.mkdirSync(path.join(procRoot, "456"));
    fs.symlinkSync(root, path.join(procRoot, "456", "exe"));
    fs.symlinkSync(root, path.join(procRoot, "456", "cwd"));
    expect(pruneInstallPayloads(manifest, paths, hooks)).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("matches canonical payload paths without matching sibling prefixes", () => {
    const { old, procRoot, processRoot } = pruningFixture();
    const alias = path.join(root, "payload-alias");
    fs.symlinkSync(old, alias, "dir");
    fs.symlinkSync(`${old}-other`, path.join(processRoot, "exe"));
    fs.symlinkSync(old, path.join(processRoot, "cwd"));
    expect(isInstallPayloadInUse(alias, { platform: "linux", procRoot })).toBe(true);
    fs.rmSync(path.join(processRoot, "cwd"));
    fs.symlinkSync(`${old}-other`, path.join(processRoot, "cwd"));
    expect(isInstallPayloadInUse(old, { platform: "linux", procRoot })).toBe(false);
  });

  it("keeps and reports a payload when process inspection fails", () => {
    const { old, procRoot, manifest } = pruningFixture();
    vi.spyOn(fs, "readlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    const report = vi.fn();
    expect(pruneInstallPayloads(manifest, paths, {
      checkPayloadInUse: (payload) => isInstallPayloadInUse(payload, { platform: "linux", procRoot }),
      report,
    })).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
    expect(report).toHaveBeenCalledWith(`Kept install payload ${old}: live-process check failed: permission denied`);
  });

  it.each(["darwin", "win32"] as const)("keeps and reports older payloads on %s", (platform) => {
    const { old, manifest } = pruningFixture();
    const report = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(pruneInstallPayloads(manifest, paths, {
      checkPayloadInUse: (payload) => isInstallPayloadInUse(payload, { platform }),
    })).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
    expect(report).toHaveBeenCalledWith(
      `Kept install payload ${old}: live-process check failed: Live-process checks are not supported on ${platform}.`,
    );
  });

  it("keeps payloads if the process table cannot be listed", () => {
    const { old, procRoot, manifest } = pruningFixture();
    fs.rmSync(procRoot, { recursive: true });
    const report = vi.fn();
    expect(pruneInstallPayloads(manifest, paths, {
      checkPayloadInUse: (payload) => isInstallPayloadInUse(payload, { platform: "linux", procRoot }),
      report,
    })).toEqual([]);
    expect(fs.existsSync(old)).toBe(true);
    expect(report.mock.calls[0][0]).toContain("live-process check failed");
  });

  it("fails safe if no processes are visible", () => {
    const { old, procRoot, processRoot } = pruningFixture();
    fs.rmSync(processRoot, { recursive: true });
    expect(() => isInstallPayloadInUse(old, { platform: "linux", procRoot })).toThrow("No processes are visible");
  });

  it.each([
    ["Z", 0, false],
    ["S", 0x00200000, false],
    ["S", 0, true],
  ])("handles missing process links for state %s and flags %i", (state, flags, fails) => {
    const { old, procRoot, processRoot } = pruningFixture();
    fs.writeFileSync(path.join(processRoot, "stat"), `123 (process (name)) ${state} 1 1 1 0 -1 ${flags} 0\n`);
    const check = () => isInstallPayloadInUse(old, { platform: "linux", procRoot });
    if (fails) expect(check).toThrow();
    else expect(check()).toBe(false);
  });

  it("ignores a process that exits during inspection", () => {
    const { old, procRoot } = pruningFixture();
    expect(isInstallPayloadInUse(old, { platform: "linux", procRoot })).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("protects a real child process working in an old payload", async () => {
    const { old, manifest } = pruningFixture();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: old, stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      const report = vi.fn();
      expect(pruneInstallPayloads(manifest, paths, { report })).toEqual([]);
      expect(fs.existsSync(old)).toBe(true);
      expect(report).toHaveBeenCalledWith(`Kept install payload ${old}: a live process runs from this payload.`);
    } finally {
      child.kill();
      await exited;
    }
  });

  it("writes a stable shim with the validated runtime and custom store path", () => {
    writeManagedShim(paths);
    const shim = fs.readFileSync(paths.shimPath, "utf8");
    expect(shim).toContain(process.execPath);
    expect(shim).toContain(paths.currentPath);
    expect(shim).not.toContain("PAPERCLIP_HOME");
    expect(fs.statSync(paths.shimPath).mode & 0o777).toBe(0o755);

    const rcPath = path.join(root, "home", ".bashrc");
    expect(addManagedPathBlock(rcPath)).toBe(true);
    expect(addManagedPathBlock(rcPath)).toBe(false);
    fs.chmodSync(rcPath, 0o640);
    expect(removeManagedPathBlock(rcPath)).toBe(true);
    expect(fs.readFileSync(rcPath, "utf8")).not.toContain("paperclipai managed PATH");
    expect(fs.statSync(rcPath).mode & 0o777).toBe(0o640);
  });

  it("uses the pinned Node for child tools even with an older node first on the service PATH", () => {
    const entrypoint = path.join(paths.currentPath, "node_modules", "paperclipai", "dist", "index.js");
    fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
    fs.writeFileSync(entrypoint, `console.log(require("node:child_process").execFileSync("node", ["-p", "process.execPath"], {encoding: "utf8"}).trim())`);
    const oldBin = path.join(root, "old-bin");
    fs.mkdirSync(oldBin);
    fs.writeFileSync(path.join(oldBin, "node"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
    writeManagedShim(paths);
    const output = execFileSync(paths.shimPath, [], { env: { ...process.env, PATH: oldBin }, encoding: "utf8" });
    expect(fs.realpathSync(output.trim())).toBe(fs.realpathSync(process.execPath));
    expect(removeManagedShim(paths)).toBe(true);
  });

  it("upgrades and removes the original managed shim format", () => {
    writeManagedShim(paths);
    const original = fs.readFileSync(paths.shimPath, "utf8").split("\n").filter((line) => !line.startsWith("export PATH=")).join("\n");
    fs.writeFileSync(paths.shimPath, original);
    writeManagedShim(paths);
    expect(fs.readFileSync(paths.shimPath, "utf8")).toContain("export PATH=");
    fs.writeFileSync(paths.shimPath, original);
    expect(removeManagedShim(paths)).toBe(true);
  });

  it("rejects marker substrings that are not the exact managed shim format", () => {
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, `#!/bin/sh\necho '${MANAGED_SHIM_MARKER}'\n`);

    expect(removeManagedShim(paths)).toBe(false);
    expect(fs.existsSync(paths.shimPath)).toBe(true);
    expect(() => writeManagedShim(paths)).toThrow("non-managed command");
  });

  it("serializes install-store mutations with an exclusive lock", async () => {
    await expect(
      withInstallStoreLock(
        () => withInstallStoreLock(async () => undefined, paths),
        paths,
      ),
    ).rejects.toThrow("already running");
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it("recovers a lock owned by a process that no longer exists", async () => {
    const staleToken = "2147483647:stale";
    await withInstallStoreLock(async () => undefined, paths);
    fs.writeFileSync(paths.lockPath, `${staleToken}\n`, { mode: 0o600 });

    await expect(withInstallStoreLock(async () => undefined, paths)).resolves.toBeUndefined();
    expect(fs.existsSync(paths.lockPath)).toBe(false);
  });

  it("reports managed provenance only for the payload selected by current", () => {
    const manifestPayload = payloadPathFor(paths, "npm", "1.0.0");
    const currentPayload = payloadPathFor(paths, "npm", "2.0.0");
    const executable = path.join(manifestPayload, "node_modules", "paperclipai", "dist", "index.js");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "");
    fs.mkdirSync(currentPayload, { recursive: true });
    flipCurrentAtomic(currentPayload, paths);
    const manifest: InstallManifest = {
      schemaVersion: INSTALL_MANIFEST_VERSION,
      ...record(manifestPayload, "1.0.0"),
      previous: [],
    };

    expect(isManagedExecutable(executable, manifest, paths)).toBe(false);
  });

  it("refuses symlinked payload roots and pre-existing non-managed shims", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(paths.installsRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(paths.installsRoot, "npm"), "dir");
    const escapedPayload = path.join(paths.installsRoot, "npm", "1.2.3");
    fs.mkdirSync(path.join(outside, "1.2.3"));
    expect(() => flipCurrentAtomic(escapedPayload, paths)).toThrow("resolves outside");

    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, "#!/bin/sh\necho other-command\n");
    expect(() => writeManagedShim(paths)).toThrow("non-managed command");
  });

  it("refuses symlinked rc files, unsafe shim parents, and multiply linked shims", () => {
    const outsideRc = path.join(root, "outside-rc");
    fs.writeFileSync(outsideRc, "keep\n");
    const rcPath = path.join(root, "home", ".bashrc");
    fs.mkdirSync(path.dirname(rcPath), { recursive: true });
    fs.symlinkSync(outsideRc, rcPath);
    expect(() => addManagedPathBlock(rcPath)).toThrow("non-regular shell rc file");
    expect(() => removeManagedPathBlock(rcPath)).toThrow("non-regular shell rc file");
    expect(fs.readFileSync(outsideRc, "utf8")).toBe("keep\n");

    fs.rmSync(rcPath);
    const localDir = path.join(root, "home", ".local");
    const outsideBin = path.join(root, "outside-bin");
    fs.mkdirSync(outsideBin);
    fs.symlinkSync(outsideBin, localDir, "dir");
    expect(() => writeManagedShim(paths)).toThrow("unsafe shim directory");

    fs.rmSync(localDir);
    fs.mkdirSync(path.dirname(paths.shimPath), { recursive: true });
    fs.writeFileSync(paths.shimPath, `# ${MANAGED_SHIM_MARKER}\n`);
    fs.linkSync(paths.shimPath, path.join(root, "linked-shim"));
    expect(() => writeManagedShim(paths)).toThrow("multiply linked shim");
  });
});
