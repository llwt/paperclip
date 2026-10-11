import { resolve } from "node:path";
import { stopEmbeddedPostgresIfRunning } from "./services/workspace-instance-cleanup.js";

/** postmaster.pid records the actual listening port, which can differ from the
 * configured port after collision avoidance. Never reuse the configured port. */
export function embeddedPostgresOwnerPort(contents: string, dataDir: string, expectedPid: number): number {
  const [pid, directory, , portText] = contents.split("\n");
  const port = Number(portText);
  if (Number(pid) !== expectedPid || !directory || resolve(directory) !== resolve(dataDir) ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535)
    throw new Error("The running embedded PostgreSQL identity does not match this instance. Startup stopped before connecting.");
  return port;
}

// Fork-only: bind shutdown authority to the postmaster verified during reuse.
// The existing stop helper also verifies the live command and data directory.
export function createReusedEmbeddedPostgresShutdown(
  dataDir: string,
  ownerContents: string,
  expectedPid: number,
): () => Promise<void> {
  const port = embeddedPostgresOwnerPort(ownerContents, dataDir, expectedPid);
  const startedAt = ownerContents.split("\n")[2]?.trim();
  if (!startedAt || !Number.isSafeInteger(Number(startedAt)) || Number(startedAt) <= 0) {
    throw new Error("Refusing to own PostgreSQL shutdown: its postmaster start time is invalid.");
  }
  return async () => {
    await stopEmbeddedPostgresIfRunning(dataDir, undefined, { pid: expectedPid, startedAt, port });
  };
}
