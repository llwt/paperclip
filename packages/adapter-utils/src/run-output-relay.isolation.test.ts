import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { resetAgentProcessIsolation } from "./process-isolation.js";
import {
  readRunOutputRelayState,
  runOutputRelayLogPath,
  spawnRunOutputRelay,
} from "./run-output-relay.js";
import { spawnScoped } from "./scoped-process.js";
import {
  configureTestIsolation,
  prepareLiveIsolation,
  type ConfiguredIsolation,
  type LiveIsolation,
} from "./test-support/isolation-fixture.js";

const temp: string[] = [];

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

async function cgroupOf(pid: number): Promise<string> {
  return (await fs.readFile(`/proc/${pid}/cgroup`, "utf8")).trim();
}

afterEach(async () => {
  resetAgentProcessIsolation();
  await Promise.all(temp.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("run output relay under a live user manager", () => {
  let live: LiveIsolation;
  let configured: ConfiguredIsolation | null = null;

  beforeAll(async () => {
    live = await prepareLiveIsolation();
  });
  afterAll(() => live?.cleanup());
  afterEach(() => configured?.health.stop());

  it("runs in its own relay scope, keeps descriptors 3 and 4, and outlives the provider's scope", async (ctx) => {
    if (live.skip) ctx.skip(`skipped, ${live.skip}`);
    const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-reg-"));
    const relayDir = await fs.mkdtemp(path.join(os.tmpdir(), "relay-out-"));
    temp.push(registryDir, relayDir);
    configured = configureTestIsolation({ registryDir, helperPath: live.helper, slice: live.slice });

    const provider = spawnScoped({
      command: "/bin/sh",
      args: [
        "-c",
        `echo out-before; echo err-before >&2; while [ ! -e "${path.join(relayDir, "go")}" ]; do sleep 0.02; done; echo out-after; echo err-after >&2; sleep 300 & wait`,
      ],
      options: { stdio: ["ignore", "pipe", "pipe"] },
      owner: { kind: "run", id: "relay-test-run" },
    });
    const seen = { stdout: "", stderr: "" };
    provider.child.stdout!.on("data", (chunk) => (seen.stdout += String(chunk)));
    provider.child.stderr!.on("data", (chunk) => (seen.stderr += String(chunk)));
    expect(await waitFor(() => seen.stdout.includes("out-before") && seen.stderr.includes("err-before"))).toBe(true);

    provider.child.stdout!.pause();
    provider.child.stderr!.pause();
    const { relayPid } = await spawnRunOutputRelay({
      dir: relayDir,
      stdout: provider.child.stdout,
      stderr: provider.child.stderr,
    });
    provider.child.stdout!.destroy();
    provider.child.stderr!.destroy();

    const ownerKinds = async () => {
      const kinds: string[] = [];
      for (const name of await fs.readdir(registryDir)) {
        const parsed = JSON.parse(await fs.readFile(path.join(registryDir, name), "utf8").catch(() => "{}")) as {
          owner?: { kind: string };
        };
        if (parsed.owner) kinds.push(parsed.owner.kind);
      }
      return kinds.sort();
    };
    expect(await waitFor(async () => (await ownerKinds()).length === 2)).toBe(true);
    expect(await ownerKinds()).toEqual(["relay", "run"]);

    expect(await waitFor(async () => (await cgroupOf(relayPid)).includes(`/${live.slice}/`))).toBe(true);
    const relayCgroup = await cgroupOf(relayPid);
    expect(relayCgroup).not.toBe(await cgroupOf(provider.child.pid!));
    for (const fd of [3, 4]) {
      expect(await fs.readlink(`/proc/${relayPid}/fd/${fd}`)).toMatch(/^(pipe|socket):/);
    }

    await fs.writeFile(path.join(relayDir, "go"), "go");
    expect(
      await waitFor(async () => (await fs.readFile(runOutputRelayLogPath(relayDir, "stderr"), "utf8")) === "err-after\n"),
    ).toBe(true);

    await provider.terminateScope({ graceMs: 200 });
    await provider.settled;
    expect(await waitFor(async () => (await readRunOutputRelayState(relayDir))?.status === "ended")).toBe(true);
    expect(await fs.readFile(runOutputRelayLogPath(relayDir, "stdout"), "utf8")).toBe("out-after\n");
    expect(await fs.readFile(runOutputRelayLogPath(relayDir, "stderr"), "utf8")).toBe("err-after\n");
  });
});
