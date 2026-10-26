// The verified ACPX guardian in its own agent process scope (SX-2305 step 3):
// the same guardian, leases and credential fences, launched through the scope
// helper by a server-built launcher.
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createSystemdIsolationPolicy,
  readProcCgroup,
  readProcStat,
  sliceCgroupPath,
  spawnIsolated,
  terminateOwnedProcessTree,
  type ScopeRecordRef,
} from "@paperclipai/process-launch";
import { prepareSystemdTestEnv } from "@paperclipai/process-launch/systemd-test-env";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { stageManagedCodexCredential } from "./codex-credentials.js";
import { awaitVerifiedAcpxProviderOwnership, verifyQualifiedAcpxInstallation } from "./installation-integrity.js";
import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import type { ProcessIsolationRequest } from "../../process-isolation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

async function persistentFixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-scope-"));
  roots.push(root);
  const serverDirectory = join(root, "pi-acp");
  const runtimeDirectory = join(root, "pi-runtime");
  await mkdir(join(serverDirectory, "bin"), { recursive: true });
  await mkdir(runtimeDirectory, { recursive: true });
  const serverPackageJsonPath = join(serverDirectory, "package.json");
  const runtimePackageJsonPath = join(runtimeDirectory, "package.json");
  const commandPath = join(serverDirectory, "bin", "server.js");
  const command = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "fs.writeFileSync(process.env.PAPERCLIP_PROVIDER_PID_FILE, String(process.pid));",
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  await writeFile(serverPackageJsonPath, JSON.stringify({ version: "0.0.33", bin: "bin/server.js" }));
  await writeFile(runtimePackageJsonPath, JSON.stringify({ version: "1.0.0" }));
  await writeFile(commandPath, command);
  await chmod(commandPath, 0o755);
  const profile = {
    ...resolveQualifiedAcpxProfile("pi", "openrouter/deepseek/deepseek-v4-flash-0731"),
    commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
  };
  const paths = new Map([
    ["pi-acp", serverPackageJsonPath],
    ["@earendil-works/pi-coding-agent", runtimePackageJsonPath],
  ]);
  return { root, profile, resolve: (name: string) => paths.get(name)! };
}

const systemd = prepareSystemdTestEnv();
afterAll(() => systemd.stop(), 30_000);

describe.skipIf(process.platform !== "linux" || systemd.skipReason !== null)(
  `native verified guardian in a real scope${systemd.skipReason ? ` (skipped: ${systemd.skipReason})` : ""}`,
  () => {
    it("keeps the guardian, its fences and its process group, inside its own scope", async () => {
      const fixture = await persistentFixture();
      const pidFile = join(fixture.root, "provider.pid");
      const credentialHome = join(fixture.root, "codex-home");
      await mkdir(credentialHome, { mode: 0o700 });
      const policy = createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId: "guardianscopetest",
        registryDir: join(fixture.root, "registry"),
        userBusAddress: systemd.userBusAddress,
        helperPath: systemd.helper,
      });
      let record: ScopeRecordRef | null = null;
      const launcher: ProcessIsolationRequest = {
        spawn(command, args, options) {
          const launched = spawnIsolated(
            { command, args: [...args], options },
            { policy, owner: { kind: "warm_provider", id: "guardian-scope-test", companyId: "company" } },
          );
          record = launched.launch.record;
          return launched.child;
        },
      };

      const credential = await stageManagedCodexCredential({
        agentHomeDirectory: credentialHome,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"original"}' },
      });
      const installation = await verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve);
      const lease = await installation.openCommand();
      let guardian: ChildProcess | null = null;
      try {
        guardian = lease.spawn(
          [],
          { env: { ...process.env, PAPERCLIP_PROVIDER_PID_FILE: pidFile } },
          {
            credentialFenceFds: credential.lifetimeFenceFds,
            activateCredentialFenceOwner: (pid) => credential.activateLifetimeOwner(pid),
          },
          launcher,
        );
        await awaitVerifiedAcpxProviderOwnership(guardian);
        expect(await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).length > 0)).toBe(true);
        const providerPid = Number(await readFile(pidFile, "utf8"));
        const guardianPid = guardian.pid!;

        // Same PID, still the leader of its own new process group.
        expect(readProcStat(guardianPid)?.pgrp).toBe(guardianPid);
        // Guardian and provider are in the guardian's own scope.
        const scope = readProcCgroup(guardianPid);
        expect(scope).toMatch(new RegExp(`${sliceCgroupPath(systemd.slice)}/pcagent-[0-9a-f-]+\\.scope$`));
        expect(readProcCgroup(providerPid)).toBe(scope);
        // The credential fence descriptors reached the guardian at their
        // numbers: a second owner is still refused.
        await expect(
          stageManagedCodexCredential({
            agentHomeDirectory: credentialHome,
            environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}' },
          }),
        ).rejects.toThrow("already has an active lease");
        // The lease stays single-use.
        expect(() => lease.spawn([], {}, undefined, launcher)).toThrow("Verified ACPX command lease is closed");

        // Stopping the owned scope stops the guardian and its provider.
        const result = await terminateOwnedProcessTree(record!, { instanceId: "guardianscopetest", graceMs: 2_000 });
        expect(result.containment).toBe("scope");
        expect(result.outcome).toBe("terminated");
        expect(await waitFor(() => !alive(providerPid) && !alive(guardianPid))).toBe(true);
      } finally {
        if (guardian && guardian.exitCode === null && guardian.signalCode === null) guardian.kill("SIGKILL");
        await lease.close().catch(() => undefined);
        await credential.close().catch(() => undefined);
      }
    }, 30_000);
  },
);
