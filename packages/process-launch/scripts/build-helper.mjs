import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperName = "paperclip-scope-exec";

/** Copy to a fresh inode, then rename over the published path, so a running helper is never truncated. */
export async function stageHelper(source, destination) {
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(path.join(directory, ".scope-exec-stage-"));
  const staged = path.join(staging, path.basename(destination));
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
    await chmod(staged, 0o755);
    await rename(staged, destination);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function buildHelper({ stdio = "inherit" } = {}) {
  // The helper is Linux only. Other platforms ship without it and every
  // launch uses the ordinary spawn path.
  if (process.platform !== "linux") {
    console.log(`[process-launch] skipping ${helperName}: unsupported platform ${process.platform}`);
    return null;
  }
  execFileSync(
    "cargo",
    ["build", "--release", "--locked", "--manifest-path", path.join(packageRoot, "helper", "Cargo.toml")],
    { cwd: packageRoot, stdio },
  );
  const destination = path.join(packageRoot, "dist", "bin", helperName);
  await stageHelper(path.join(packageRoot, "helper", "target", "release", helperName), destination);
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildHelper();
}
