import { configureAgentProcessIsolation } from "@paperclipai/adapter-utils/server-utils";
import {
  IsolationHealth,
  OFF_ISOLATION_POLICY,
  agentScopeRegistryDir,
  createSystemdIsolationPolicy,
  resolveUserBusAddress,
  type IsolationLogger,
} from "@paperclipai/process-launch";
import type { Config } from "./config.js";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "./home-paths.js";

/**
 * Build the host's agent process isolation policy from trusted server
 * configuration and publish it once for the common process runner. Nothing
 * from provider or agent configuration reaches this policy. When isolation is
 * on, the capability check runs here but never blocks startup: if it fails,
 * the server warns once and runs agents normally, then retries in the
 * background with a bounded backoff.
 */
export async function startAgentProcessIsolation(
  config: Pick<Config, "agentProcessIsolation">,
  logger: IsolationLogger,
): Promise<IsolationHealth | null> {
  const { mode, slice } = config.agentProcessIsolation;
  if (mode === "off") {
    configureAgentProcessIsolation({ policy: OFF_ISOLATION_POLICY, health: null });
    return null;
  }

  const policy = createSystemdIsolationPolicy({
    slice,
    instanceId: resolvePaperclipInstanceId(),
    registryDir: agentScopeRegistryDir(resolvePaperclipInstanceRoot()),
    userBusAddress: resolveUserBusAddress(),
  });
  const health = new IsolationHealth(policy, { logger });
  configureAgentProcessIsolation({ policy, health });
  await health.start();
  return health;
}
