// Test fixture: stands in for an earlier server process at a hot restart. It
// launches one run's provider with piped output under the isolation policy,
// hands the read ends to a real output relay (its own scope, owned by the
// run), prints the launch facts and exits, leaving provider, relay and both
// launch records behind exactly as a server that handed its runs over would.
import { configureAgentProcessIsolation } from "@paperclipai/adapter-utils/process-isolation";
import { spawnRunOutputRelay } from "@paperclipai/adapter-utils/run-output-relay";
import {
  createSystemdIsolationPolicy,
  listOwnedScopeRecords,
  readScopeStatus,
  spawnIsolated,
  type ScopeRecordRef,
} from "@paperclipai/process-launch";

interface Input {
  registryDir: string;
  instanceId: string;
  slice: string;
  userBusAddress: string | null;
  helperPath: string;
  runId: string;
  companyId: string;
  relayDir: string;
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
configureAgentProcessIsolation({ policy, health: null });

async function settled(ref: ScopeRecordRef | null) {
  const deadline = Date.now() + 10_000;
  while (ref && !readScopeStatus(ref) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return ref ? readScopeStatus(ref) : null;
}

const { child, launch } = spawnIsolated(
  { command: "/bin/sh", args: ["-c", input.script], options: { detached: true, stdio: ["ignore", "pipe", "pipe"] } },
  { policy, owner: { kind: "run", id: input.runId, companyId: input.companyId } },
);
child.on("error", () => {});
for (const readable of [child.stdout, child.stderr]) readable?.pause();
const { relayPid } = await spawnRunOutputRelay({
  dir: input.relayDir,
  stdout: child.stdout,
  stderr: child.stderr,
  owner: { runId: input.runId, companyId: input.companyId },
});
for (const readable of [child.stdout, child.stderr]) readable?.destroy();

const providerStatus = launch.isolation.state === "requested" ? await settled(launch.isolation.record) : null;
const relayRecord = listOwnedScopeRecords(input.registryDir, input.instanceId).records
  .find((record) => record.manifest.owner.kind === "relay" && record.manifest.owner.id === input.runId) ?? null;
// The relay launches under the same policy, so it is enrolled only when the provider was.
const relayStatus = launch.isolation.state === "requested" ? await settled(relayRecord?.ref ?? null) : null;
process.stdout.write(`${JSON.stringify({
  pid: child.pid ?? null,
  unit: launch.record?.unit ?? null,
  outcome: providerStatus?.outcome ?? launch.isolation.state,
  relayPid,
  relayUnit: relayRecord?.manifest.unit ?? null,
  relayOutcome: relayStatus?.outcome ?? (relayRecord ? "degraded" : null),
})}\n`);
child.unref();
process.exit(0);
