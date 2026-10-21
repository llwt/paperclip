import { createHash } from "node:crypto";
import { HttpError, unprocessable } from "../errors.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { type Db, companySecrets, connectionGrants, toolConnections } from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { secretService } from "./secrets.js";
import { MANAGED_AI_WRITEBACK_PENDING, writeRunTempDirMarker } from "./run-temp-dirs.js";
import { decideCodexAuthMerge } from "@paperclipai/adapter-codex-local/server";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";

export function isAiConnectionBusy(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === "ai_connection_busy";
}

// Blank values intentionally override inherited credentials in CLI child environments.
export const AI_AUTH_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "CODEX_HOME",
  "GROK_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_AUTH_JSON",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "XAI_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;
export function stripAiAuthBindings(env: unknown): Record<string, unknown> {
  const result = {
    ...(env && typeof env === "object" ? (env as Record<string, unknown>) : {}),
  };
  for (const key of AI_AUTH_ENV_KEYS)
    if (
      ![
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "XAI_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "PAPERCLIP_OPENCODE_PROVIDERS",
      ].includes(key)
    )
      delete result[key];
  return result;
}
export async function assertManagedAiProjectAuth(
  config: Record<string, unknown>,
  provider: AiConnectionBinding["provider"],
  target?: AdapterExecutionTarget | null,
) {
  const extraArgs = [
    ...(Array.isArray(config.extraArgs) ? config.extraArgs : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ];
  if (
    extraArgs.some(
      (arg) =>
        typeof arg === "string" &&
        /^(--config|-c|--settings|--setting-sources|--api-key|--auth-token)(=|$)/.test(
          arg,
        ),
    )
  ) {
    throw unprocessable(
      "Remove authentication/configuration overrides before selecting a managed AI connection",
      { code: "ai_connection_incompatible" },
    );
  }
  const files =
    provider === "anthropic"
      ? [".claude/settings.json", ".claude/settings.local.json"]
      : provider === "openai"
        ? [".codex/config.toml"]
        : [];
  const pattern =
    "apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider[[:space:]]*=|env_key[[:space:]]*=|experimental_bearer_token|cli_auth_credentials_store";
  if (target?.kind === "remote" && files.length) {
    // Only inspect for conflicting keys; never return configuration or credential values.
    const result = await runAdapterExecutionTargetProcess(
      `ai-auth-check-${Date.now()}`,
      target,
      "sh",
      [
        "-c",
        `
directory=$1; pattern=$2; shift 2
while :; do
  for relative in "$@"; do
    file="$directory/$relative"
    if test -f "$file"; then
      grep -Eq "$pattern" "$file"
      result=$?
      if test "$result" -eq 0; then exit 42; fi
      if test "$result" -ne 1; then exit 43; fi
    fi
  done
  parent=$(dirname "$directory")
  if test "$parent" = "$directory"; then break; fi
  directory=$parent
done`,
        "ai-auth-check",
        target.remoteCwd,
        pattern,
        ...files,
      ],
      {
        cwd: target.remoteCwd,
        env: {},
        timeoutSec: 15,
        graceSec: 1,
        onLog: async () => {},
      },
    );
    if (result.exitCode !== 0)
      throw unprocessable(
        "The environment's project authentication settings must be checked before using this AI connection",
        { code: "ai_connection_incompatible" },
      );
    return;
  }
  let directory =
    typeof config.cwd === "string" ? path.resolve(config.cwd) : process.cwd();
  for (;;) {
    for (const relative of files) {
      try {
        const content = await readFile(path.join(directory, relative), "utf8");
        if (
          /apiKeyHelper|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|model_provider\s*=|env_key\s*=|experimental_bearer_token|cli_auth_credentials_store/.test(
            content,
          )
        ) {
          throw unprocessable(
            "Project authentication settings conflict with the selected AI connection",
            { code: "ai_connection_incompatible" },
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function managedAiHomeEnvironment(home: string): Record<string, string> {
  const providerHome = path.join(home, "provider");
  return {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    CODEX_HOME: providerHome,
    GROK_HOME: providerHome,
    CLAUDE_CONFIG_DIR: providerHome,
  };
}

/** Only the server-created credential home is volatile; retain all other config. */
export function managedAiSessionFingerprintConfig(
  config: Record<string, unknown>,
  managedHome: string | undefined,
): Record<string, unknown> {
  if (!managedHome) return config;
  const env = { ...(config.env as Record<string, unknown> | undefined) };
  const stable = managedAiHomeEnvironment("<managed-ai-home>");
  for (const [key, value] of Object.entries(managedAiHomeEnvironment(managedHome))) {
    if (env[key] === value) env[key] = stable[key];
  }
  const managed = config.managedAiConnection as Record<string, unknown> | undefined;
  if (managed?.sessionIdentity) {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "OPENROUTER_API_KEY", "XAI_API_KEY", "GROK_API_KEY", "OPENCODE_AUTH_JSON", "OPENCODE_CONFIG_CONTENT"]) {
      if (env[key]) env[key] = "<managed-ai-credential>";
    }
  }
  return { ...config, env, ...(managed?.sessionIdentity ? { managedAiConnection: { ...managed, identity: managed.sessionIdentity } } : {}) };
}

interface ManagedAiWriteBackPending {
  version: 1;
  companyId: string;
  connectionId: string;
  grantId: string;
  provider: string;
  credentialSha256: string;
}

async function readManagedAiWriteBackPending(home: string): Promise<ManagedAiWriteBackPending | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(home, MANAGED_AI_WRITEBACK_PENDING), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const rec = JSON.parse(raw) as Partial<ManagedAiWriteBackPending>;
  for (const key of ["companyId", "connectionId", "grantId", "provider", "credentialSha256"] as const) {
    if (typeof rec[key] !== "string") throw new Error(`Invalid managed AI write-back record in ${home}`);
  }
  return rec as ManagedAiWriteBackPending;
}

/**
 * Save a credential the provider refreshed during the run back to its secret,
 * then drop the pending record. Called by the run's own cleanup and, for a
 * home whose cleanup never ran (server crash), by the run temp folder sweep
 * before it removes the home. Throws, and keeps the record, when the write-back
 * could not be decided, so the home is kept for a later retry.
 */
export async function writeBackManagedAiCredential(db: Db, home: string): Promise<void> {
  const pending = await readManagedAiWriteBackPending(home);
  if (!pending) return;
  const providerHome = path.join(home, "provider");
  const authFile = path.join(providerHome, "auth.json");
  let refreshed: string | null = null;
  try {
    refreshed = await readFile(authFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (refreshed !== null && createHash("sha256").update(refreshed).digest("hex") !== pending.credentialSha256) {
    const value = refreshed;
    await db.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.id, pending.grantId),
            eq(connectionGrants.companyId, pending.companyId),
          ),
        )
        .for("update");
      // A missing or revoked grant blocks the write-back. Among
      // active copies, the merge decision below keeps the
      // credential with the newest provider freshness field.
      if (!grant || grant.status !== "active") return;
      const ref = grant.credentialSecretRefs.find(
        (r) => r.configPath === "ai.credential",
      );
      if (!ref) return;
      // Lock the referenced secret row for the rest of this
      // transaction. The grant-row lock above does not cover it,
      // so an authorized rotation of this secret could otherwise
      // land between the read and the write below and be
      // overwritten by this stale write-back.
      await tx
        .select({ id: companySecrets.id })
        .from(companySecrets)
        .where(
          and(
            eq(companySecrets.id, ref.secretId),
            eq(companySecrets.companyId, pending.companyId),
          ),
        )
        .for("update");
      const [connection] = await tx
        .select()
        .from(toolConnections)
        .where(
          and(
            eq(toolConnections.id, pending.connectionId),
            eq(toolConnections.companyId, pending.companyId),
          ),
        );
      if (!connection) return;
      const current = await aiConnectionService(
        tx as unknown as Db,
      ).credential({ connection, grant });
      const destination = path.join(
        providerHome,
        "current-auth.json",
      );
      await writeFile(destination, current, { mode: 0o600 });
      const decision =
        pending.provider === "openai"
          ? await decideCodexAuthMerge(authFile, destination, {
              errorLabel: "AI account refresh",
            })
          : await decideGrokAuthMerge(authFile, destination, {
              errorLabel: "AI account refresh",
            });
      if (decision !== 10) return;
      await secretService(tx).rotate(
        ref.secretId,
        { value, preserveAiSessionEpoch: true },
        { userId: grant.subjectUserId },
      );
      await tx
        .update(connectionGrants)
        .set({ updatedAt: new Date() })
        .where(eq(connectionGrants.id, grant.id));
    });
  }
  await rm(path.join(home, MANAGED_AI_WRITEBACK_PENDING), { force: true });
}

export async function prepareManagedAiRuntime(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    /** The heartbeat run that owns the home; null for adapter test routes. */
    runId?: string | null;
    responsibleUserId: string | null;
    adapterType: string;
    binding: AiConnectionBinding;
    allowUninstalledPersonal?: boolean;
    allowUninstalledShared?: boolean;
    allowLegacyValidation?: boolean;
    config: Record<string, unknown>;
  },
) {
  const configuredEnv =
    input.config.env && typeof input.config.env === "object"
      ? (input.config.env as Record<string, unknown>)
      : {};
  for (const key of [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "XAI_BASE_URL",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "PAPERCLIP_OPENCODE_PROVIDERS",
  ]) {
    if (configuredEnv[key])
      throw unprocessable(
        "The configured provider routing is incompatible with this AI connection",
        { code: "ai_connection_incompatible" },
      );
  }
  await assertManagedAiProjectAuth(input.config, input.binding.provider);
  const service = aiConnectionService(db);
  let selection = await service.select({
    ...input,
    userId: input.responsibleUserId,
    model: input.config.model,
    runnerProvider: input.config.provider,
    acpxAgent: input.config.acpxAgent,
  });
  const subscriptionFile =
    selection.attribution.method === "subscription" &&
    input.binding.provider !== "anthropic";
  let home: string | undefined;
  try {
    const selectedGrantId = selection.grant.id;
    selection = await service.select({
      ...input,
      userId: input.responsibleUserId,
      model: input.config.model,
      runnerProvider: input.config.provider,
      acpxAgent: input.config.acpxAgent,
    });
    if (selection.grant.id !== selectedGrantId)
      throw unprocessable(
        "The selected default changed. Retry this execution.",
      );
    const credentialRef = selection.grant.credentialSecretRefs.find((ref) => ref.configPath === "ai.credential");
    if (!credentialRef) throw unprocessable("The selected AI credential is unavailable");
    const readFreshness = async () => (await db.select({ epoch: companySecrets.aiSessionEpoch, version: companySecrets.latestVersion })
      .from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, credentialRef.secretId))).limit(1))[0];
    const freshness = await readFreshness();
    const value = await service.credential(selection);
    const afterRead = await readFreshness();
    if (!freshness || freshness.version !== afterRead?.version || freshness.epoch !== afterRead.epoch) throw unprocessable("The AI credential changed during preparation; retry this execution");
    home = await mkdtemp(
      path.join(
        os.tmpdir(),
        `paperclip-ai-${input.companyId}-${selection.grant.id}-`,
      ),
    );
    await writeRunTempDirMarker(home, { companyId: input.companyId, agentId: input.agentId, runId: input.runId ?? null });
    const providerHome = path.join(home, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    const env: Record<string, unknown> = {
      ...stripAiAuthBindings(input.config.env),
      ...Object.fromEntries(AI_AUTH_ENV_KEYS.map((key) => [key, ""])),
      ...managedAiHomeEnvironment(home),
    };
    const capability =
      AI_CONNECTION_CAPABILITIES[input.binding.provider].methods[
        selection.attribution.method
      ]!;
    const authFile = path.join(providerHome, "auth.json");
    if (input.binding.provider === "openai")
      await writeFile(
        path.join(providerHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    if (subscriptionFile) {
      await writeFile(authFile, value, { mode: 0o600 });
      // Read back by `writeBackManagedAiCredential`: by this run's cleanup, or
      // by the run temp folder sweep when a crash skipped that cleanup.
      const pending: ManagedAiWriteBackPending = {
        version: 1,
        companyId: input.companyId,
        connectionId: selection.connection.id,
        grantId: selection.grant.id,
        provider: input.binding.provider,
        credentialSha256: createHash("sha256").update(value).digest("hex"),
      };
      await writeFile(path.join(home, MANAGED_AI_WRITEBACK_PENDING), `${JSON.stringify(pending)}\n`, { mode: 0o600 });
    } else env[capability.envKey] = value;
    if (
      input.binding.provider === "openai" &&
      selection.attribution.method === "api_key"
    ) {
      env.CODEX_API_KEY = value;
      await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: value }), {
        mode: 0o600,
      });
    }
    if (input.binding.provider === "openrouter") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { openrouter: { options: { apiKey: value } } },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    const generation = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    const identity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${generation}`;
    const sessionIdentity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${credentialRef.secretId}:${freshness.epoch}`;
    return {
      sessionIdentity,
      config: {
        ...input.config,
        env,
        managedAiConnection: { ...selection.attribution, identity, sessionIdentity },
      },
      attribution: selection.attribution,
      accountName: selection.connection.name,
      accountOwnerUserId: selection.grant.subjectUserId,
      identity,
      home,
      providerHome,
      /**
       * Write back a refreshed credential, then remove the home. A heartbeat
       * passes `keepHome` and removes the home itself once the run's process
       * group is gone; see `removeRunTempDir`.
       */
      cleanup: async (options: { keepHome?: boolean } = {}) => {
        try {
          if (home) await writeBackManagedAiCredential(db, home);
        } finally {
          if (home && !options.keepHome) await rm(home, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (home) await rm(home, { recursive: true, force: true });
    throw error;
  }
}
