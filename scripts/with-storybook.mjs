#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { constants } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const uiDir = fileURLToPath(new URL("../ui/", import.meta.url));

async function assertPortFree(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", (error) => {
      reject(new Error(`Cannot use 127.0.0.1:${port}: ${error.code === "EADDRINUSE" ? "port is already in use" : error.message}`));
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => probe.close(resolve));
  });
}

function start(command, args, options) {
  const child = spawn(command, args, { stdio: "inherit", detached: true, ...options });
  const done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function stop(job, graceMs) {
  if (!job?.child.pid || !signalGroup(job.child.pid, "SIGTERM")) return;
  const deadline = Date.now() + graceMs;
  // The leader can exit before its descendants. Check the whole group.
  while (signalGroup(job.child.pid, 0)) {
    if (Date.now() >= deadline) {
      signalGroup(job.child.pid, "SIGKILL");
      break;
    }
    await delay(100);
  }
  await job.done;
}

async function waitUntilReady(url, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`${url}/index.json`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(1000, deadline - Date.now()))]),
        redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok) return;
    } catch {
      signal.throwIfAborted();
    }
    await delay(200, undefined, { signal });
  }
  throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for ${url}/index.json`);
}

function exitCode(result) {
  if (result.error) throw result.error;
  return result.code ?? (128 + (constants.signals[result.signal] ?? 0));
}

export async function withStorybook(port, command, {
  cwd = uiDir,
  storybookBin,
  timeoutMs = 180_000,
  graceMs = 5000,
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !command.length) {
    throw new Error("Usage: node scripts/with-storybook.mjs <port> -- <command...> (port: 1-65535)");
  }
  await assertPortFree(port);
  const bin = storybookBin ?? createRequire(new URL("../ui/package.json", import.meta.url))
    .resolve("storybook/internal/bin/dispatcher");
  const url = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  let interruptedCode;
  let code;
  let server;
  let inner;
  const onSignal = (signal) => {
    interruptedCode ??= 128 + constants.signals[signal];
    controller.abort(new Error(`Received ${signal}`));
  };
  const interrupted = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);
  try {
    server = start(process.execPath, [bin, "dev", "--exact-port", "--ci", "--no-open",
      "--host", "127.0.0.1", "-c", "storybook/.storybook", "-p", String(port)], { cwd });
    const serverStopped = server.done.then((result) => {
      throw new Error(`Storybook exited unexpectedly (${result.error?.message ?? result.signal ?? result.code})`);
    });
    await Promise.race([waitUntilReady(url, controller.signal, timeoutMs), serverStopped, interrupted]);
    console.log(`[with-storybook] Ready at ${url}`);
    inner = start(command[0], command.slice(1), { env: { ...process.env, STORYBOOK_URL: url } });
    code = exitCode(await Promise.race([inner.done, serverStopped, interrupted]));
  } catch (error) {
    if (!interruptedCode) throw error;
  } finally {
    controller.abort();
    try {
      const stopped = await Promise.allSettled([stop(inner, graceMs), stop(server, graceMs)]);
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    }
  }
  return interruptedCode ?? code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [port, separator, ...command] = process.argv.slice(2);
    if (separator !== "--") throw new Error("Usage: node scripts/with-storybook.mjs <port> -- <command...>");
    process.exitCode = await withStorybook(Number(port), command);
  } catch (error) {
    console.error(`[with-storybook] ${error.message}`);
    process.exitCode = 1;
  }
}
