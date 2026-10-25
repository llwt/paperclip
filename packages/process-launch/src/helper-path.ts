import { accessSync, constants, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SCOPE_HELPER_NAME = "paperclip-scope-exec";

/**
 * The packaged helper. Both `src/` (workspace) and `dist/` (installed) sit
 * one level below the package root, and the build stages the helper in
 * `dist/bin/`.
 */
export function packagedHelperPath(): string {
  return fileURLToPath(new URL(`../dist/bin/${SCOPE_HELPER_NAME}`, import.meta.url));
}

/** The helper path when it is a regular executable file, otherwise null. */
export function resolveHelperPath(configured: string | null = null): string | null {
  const candidate = configured ?? packagedHelperPath();
  try {
    if (!statSync(candidate).isFile()) return null;
    accessSync(candidate, constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}
