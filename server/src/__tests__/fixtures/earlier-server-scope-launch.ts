// Test fixture: stands in for an earlier server process. It launches one
// workload under the isolation policy, waits for the helper's enrollment
// status, prints the launch facts and exits, leaving the workload and its
// launch record behind exactly as a server that stopped would.
import { createSystemdIsolationPolicy, readScopeStatus, spawnIsolated, type ProcessOwnerKind } from "@paperclipai/process-launch";

interface Input {
  registryDir: string;
  instanceId: string;
  slice: string;
  userBusAddress: string | null;
  helperPath: string;
  owner: { kind: ProcessOwnerKind; id: string; companyId: string | null };
  script: string;
}

const input = JSON.parse(process.argv[2]!) as Input;
const policy = createSystemdIsolationPolicy({
  slice: input.slice,
  instanceId: input.instanceId,
  registryDir: input.registryDir,
  userBusAddress: input.userBusAddress,
  helperPath: input.helperPath,
});
const { child, launch } = spawnIsolated(
  { command: "/bin/sh", args: ["-c", input.script], options: { detached: true, stdio: "ignore" } },
  { policy, owner: input.owner },
);
child.on("error", () => {});
const deadline = Date.now() + 10_000;
while (launch.isolation.state === "requested" && !readScopeStatus(launch.isolation.record) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
const status = launch.isolation.state === "requested" ? readScopeStatus(launch.isolation.record) : null;
process.stdout.write(
  `${JSON.stringify({ pid: child.pid ?? null, unit: launch.record?.unit ?? null, outcome: status?.outcome ?? launch.isolation.state })}\n`,
);
child.unref();
process.exit(0);
