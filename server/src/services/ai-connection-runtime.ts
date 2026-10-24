import { createHash } from "node:crypto";
import { HttpError, unprocessable } from "../errors.js";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { type Db, companySecrets, connectionGrants, toolConnections } from "@paperclipai/db";
import {
  AI_CONNECTION_CAPABILITIES,
  aiConnectionMetadataSchema, aiRoutingHarness,
  type AiConnectionBinding,
} from "@paperclipai/shared";
import { managedProviderRouting } from "./ai-provider-routing.js";
import { aiConnectionService } from "./ai-connections.js";
import { subscriptionService } from "./subscriptions.js";
import { refreshSubscriptionConnection } from "./subscription-refresh.js";
import { secretService } from "./secrets.js";
import { MANAGED_AI_WRITEBACK_PENDING, writeRunTempDirMarker } from "./run-temp-dirs.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { decideCodexAuthMerge, withAccountHomeSecretMutationLock } from "@paperclipai/adapter-codex-local/server";
import { WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE } from "@paperclipai/adapter-utils/workspace-restore-merge";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { decideGrokAuthMerge } from "@paperclipai/adapter-grok-local/server";

export function isAiConnectionBusy(error: unknown): error is HttpError {
  return error instanceof HttpError && error.status === 422 &&
    (error.details as { code?: unknown } | undefined)?.code === "ai_connection_busy";
}

// Blank values intentionally override inherited credentials in CLI child environments.
export const AI_AUTH_ENV_KEYS = [
  "PAPERCLIP_AI_PROVIDER_KEY", "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI",
  "HERMES_HOME", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",

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
    HERMES_HOME: providerHome,
  };
}

/**
 * Tool installs and caches shared by all managed AI runs. A run's HOME and XDG dirs
 * point at its temp home, so without these mise looks for tools in the empty
 * `data/mise` there and reinstalls each one on every run (SX-1444). New
 * installs and the download cache go to a Paperclip-owned dir that outlives
 * the run; the host user's own installs are only read, through
 * MISE_SHARED_INSTALL_DIRS. mise state (config trust, incomplete installs)
 * stays in the run's home. pnpm, rustup and Cargo use separate shared dirs,
 * without writing to the host user's stores or toolchains.
 */
export function managedAiToolEnvironment(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  instanceRoot: string = resolvePaperclipInstanceRoot(),
): Record<string, string> {
  const shared = path.join(instanceRoot, "runtime", "mise");
  const dataDir = path.join(shared, "data");
  const hostHome = sourceEnv.HOME?.trim() || os.homedir();
  const hostDataDir =
    sourceEnv.MISE_DATA_DIR?.trim() ||
    path.join(sourceEnv.XDG_DATA_HOME?.trim() || path.join(hostHome, ".local", "share"), "mise");
  const installDirs = [
    ...(sourceEnv.MISE_SHARED_INSTALL_DIRS ?? "").split(path.delimiter),
    path.join(hostDataDir, "installs"),
  ]
    .map((entry) => entry.trim())
    .filter((entry) => path.isAbsolute(entry) && path.resolve(entry) !== path.join(dataDir, "installs"));
  return {
    npm_config_store_dir: path.join(instanceRoot, "runtime", "pnpm", "store"),
    pnpm_config_store_dir: path.join(instanceRoot, "runtime", "pnpm", "store"),
    RUSTUP_HOME: path.join(instanceRoot, "runtime", "rustup"),
    CARGO_HOME: path.join(instanceRoot, "runtime", "cargo"),
    MISE_DATA_DIR: dataDir,
    MISE_CACHE_DIR: path.join(shared, "cache"),
    MISE_SHARED_INSTALL_DIRS: Array.from(new Set(installDirs.map((entry) => path.resolve(entry)))).join(path.delimiter),
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
  // Server-set and the same for every run; left out so adding them did not
  // change the fingerprint of existing sessions.
  for (const [key, value] of Object.entries(managedAiToolEnvironment())) {
    if (env[key] === value) delete env[key];
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
 *
 * With `keepPending` the record stays, now naming the credential just saved,
 * because the provider may still be running and refresh it again. The final
 * write-back then runs in `removeRunTempDir`, after the provider has stopped.
 */
export async function writeBackManagedAiCredential(
  db: Db,
  home: string,
  options: { keepPending?: boolean } = {},
): Promise<void> {
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
    // A quota exchange can hold this company lock for 60 seconds.
    // Retry its 30-second acquisition timeout without discarding the
    // provider's only copy of a rotated, single-use refresh token.
    const writeBack = () => withAccountHomeSecretMutationLock(undefined, pending.companyId, () => db.transaction(async (tx) => {
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
      // Keep grant.updatedAt for explicit account/access changes.
      // The rotated secret revision invalidates quota caches without
      // rejecting an otherwise valid in-flight reconnect.
    }));
    for (let attempt = 0; ; attempt++) {
      try { await writeBack(); break; }
      catch (error) {
        if (attempt >= 2 || (error as NodeJS.ErrnoException)?.code !== WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) throw error;
      }
    }
  }
  if (!options.keepPending) {
    await rm(path.join(home, MANAGED_AI_WRITEBACK_PENDING), { force: true });
  } else if (refreshed !== null) {
    const credentialSha256 = createHash("sha256").update(refreshed).digest("hex");
    if (credentialSha256 !== pending.credentialSha256) {
      await writeFile(
        path.join(home, MANAGED_AI_WRITEBACK_PENDING),
        `${JSON.stringify({ ...pending, credentialSha256 })}\n`,
        { mode: 0o600 },
      );
    }
  }
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
    "PAPERCLIP_AI_PROVIDER_URL", "PAPERCLIP_CODEX_PROVIDERS", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "GOOGLE_GEMINI_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL",
  ]) {
    if (configuredEnv[key])
      throw unprocessable(
        "The configured provider routing is incompatible with this AI connection",
        { code: "ai_connection_incompatible" },
      );
  }
  const harness = aiRoutingHarness(input.adapterType, input.config.provider, input.config.acpxAgent);
  await assertManagedAiProjectAuth(input.config, harness === "claude_local" ? "anthropic" : harness === "codex_local" ? "openai" : input.binding.provider);
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
    const routing = aiConnectionMetadataSchema.parse(selection.connection.config.ai).routing;
    const noAuth = routing?.auth === "none";
    if (!noAuth && !credentialRef) throw unprocessable("The selected AI credential is unavailable");
    const readFreshness = async () => {
      if (!credentialRef) return undefined;
      const [currentGrant] = await db.select({ refs: connectionGrants.credentialSecretRefs, status: connectionGrants.status })
        .from(connectionGrants).where(and(eq(connectionGrants.companyId, input.companyId), eq(connectionGrants.id, selection.grant.id)));
      const currentRef = currentGrant?.refs.find(ref => ref.configPath === "ai.credential");
      if (currentGrant?.status !== "active" || currentRef?.secretId !== credentialRef.secretId || currentRef.versionSelector !== credentialRef.versionSelector) return undefined;
      return (await db.select({ epoch: companySecrets.aiSessionEpoch, version: companySecrets.latestVersion })
        .from(companySecrets).where(and(eq(companySecrets.companyId, input.companyId), eq(companySecrets.id, credentialRef.secretId))).limit(1))[0];
    };
    const { value, freshness } = await (async () => {
      if (noAuth) return { value: "", freshness: undefined };
      // Recovering a rotated quota token can advance the secret version during
      // the first read. Re-read the saved credential, retaining the epoch guard
      // against a concurrent reconnect or explicit rotation.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await readFreshness();
        const value = await service.runtimeCredential(selection);
        const after = await readFreshness();
        if (before && after && before.version === after.version && before.epoch === after.epoch) {
          return { value, freshness: after };
        }
        if (!before || before.epoch !== after?.epoch) break;
      }
      throw unprocessable("The AI credential changed during preparation; retry this execution");
    })();
    home = await mkdtemp(
      path.join(
        os.tmpdir(),
        `paperclip-ai-${input.companyId}-${selection.grant.id}-`,
      ),
    );
    await writeRunTempDirMarker(home, { companyId: input.companyId, agentId: input.agentId, runId: input.runId ?? null });
    const providerHome = path.join(home, "provider");
    await mkdir(providerHome, { mode: 0o700 });
    const toolEnv = managedAiToolEnvironment();
    await mkdir(toolEnv.MISE_DATA_DIR, { recursive: true, mode: 0o700 });
    await mkdir(toolEnv.MISE_CACHE_DIR, { recursive: true, mode: 0o700 });
    for (const key of ["npm_config_store_dir", "pnpm_config_store_dir", "RUSTUP_HOME", "CARGO_HOME"]) {
      await mkdir(toolEnv[key], { recursive: true, mode: 0o700 });
    }
    const env: Record<string, unknown> = {
      // An agent's own tool settings win over the shared defaults.
      ...toolEnv,
      ...stripAiAuthBindings(input.config.env),
      ...Object.fromEntries(AI_AUTH_ENV_KEYS.map((key) => [key, ""])),
      ...managedAiHomeEnvironment(home),
    };
    const capability =
      AI_CONNECTION_CAPABILITIES[input.binding.provider].methods[
        selection.attribution.method
      ]!;
    const authFile = path.join(providerHome, "auth.json");
    if (harness === "codex_local")
      await writeFile(
        path.join(providerHome, "config.toml"),
        'cli_auth_credentials_store = "file"\n',
        { mode: 0o600 },
      );
    if (!routing && subscriptionFile) {
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
    } else if (!routing) env[capability.envKey] = value;
    if (
      !routing && input.binding.provider === "openai" &&
      selection.attribution.method === "api_key"
    ) {
      env.CODEX_API_KEY = value;
      await writeFile(authFile, JSON.stringify({ OPENAI_API_KEY: value }), {
        mode: 0o600,
      });
    }
    if (!routing && input.binding.provider === "openrouter") {
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
        provider: { openrouter: { options: { apiKey: value } } },
      });
      env.OPENCODE_DISABLE_PROJECT_CONFIG = "true";
    }
    if (!routing && input.binding.provider === "google") {
      // Gemini headless CLI requires an explicit auth choice even with an API key.
      // Seed only the disposable connection home, never the operator's settings.
      const geminiHome = path.join(home, ".gemini");
      await mkdir(geminiHome, { mode: 0o700 });
      await writeFile(path.join(geminiHome, "settings.json"), JSON.stringify({
        selectedAuthType: "gemini-api-key",
        security: { auth: { selectedType: "gemini-api-key" } },
      }), { mode: 0o600 });
    }
    const projected = routing ? managedProviderRouting(routing, harness, value, typeof input.config.model === "string" ? input.config.model : "") : undefined;
    if (projected) {
      Object.assign(env, projected.env);
      if (projected.hermesConfig) await writeFile(path.join(providerHome, "config.yaml"), projected.hermesConfig, { mode: 0o600 });
      if (projected.codexConfig) await writeFile(path.join(providerHome, "config.toml"), 'cli_auth_credentials_store = "file"\n' + projected.codexConfig, { mode: 0o600 });
    }
    const attribution = { ...selection.attribution } as typeof selection.attribution & { subscriptionId?: string };
    if (attribution.method === "subscription") {
      const subscription = {
        companyId: input.companyId, connectionId: selection.connection.id, grantId: selection.grant.id,
        provider: selection.attribution.provider, name: selection.connection.name,
        ownerUserId: selection.grant.subjectUserId, credential: value,
      };
      attribution.subscriptionId = await subscriptionService(db).register(subscription);
      void refreshSubscriptionConnection(db, subscription, attribution.subscriptionId);
    }
    const generation = createHash("sha256")
      .update(value)
      .digest("hex")
      .slice(0, 16);
    const identity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${generation}`;
    const sessionIdentity = `${selection.grant.id}:${input.responsibleUserId ?? "shared"}:${noAuth ? "no-auth" : `${credentialRef!.secretId}:${freshness!.epoch}`}`;
    return {
      sessionIdentity,
      config: {
        ...input.config,
        ...projected?.config,
        ...(routing ? { managedAiRouting: routing } : {}),
        env,
        managedAiConnection: { ...attribution, identity, sessionIdentity },
      },
      attribution,
      accountName: selection.connection.name,
      accountOwnerUserId: selection.grant.subjectUserId,
      identity,
      home,
      providerHome,
      /**
       * Write back a refreshed credential, then remove the home. A heartbeat
       * passes `keepHome` and removes the home itself once the run's provider
       * has stopped; see `removeRunTempDir`. The pending write-back record
       * stays with the home until then, so a credential the provider refreshes
       * after this call is still saved before the home goes.
       */
      cleanup: async (options: { keepHome?: boolean } = {}) => {
        if (home) await writeBackManagedAiCredential(db, home, { keepPending: options.keepHome });
        // Preserve the private home on any failed write-back, including an
        // exhausted lock retry or database failure. The caller can retry the
        // same cleanup; only a committed save or an intentional discard
        // (revoked grant, older/different identity) permits deletion.
        if (home && !options.keepHome) await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (home) await rm(home, { recursive: true, force: true });
    throw error;
  }
}

/** Manual tests/adoption have no heartbeat row for quota's active-run guard.
 * Hold the shared credential lock from resolution through the provider probe
 * and write-back. Nested credential writes reuse this lock's async ownership. */
export async function withManagedAiProbe<T>(
  db: Db,
  input: Parameters<typeof prepareManagedAiRuntime>[1],
  probe: (runtime: Awaited<ReturnType<typeof prepareManagedAiRuntime>>) => Promise<T>,
): Promise<T> {
  const run = async () => {
    const runtime = await prepareManagedAiRuntime(db, input);
    try { return await probe(runtime); }
    finally { await runtime.cleanup(); }
  };
  return input.binding.provider === "openai"
    ? withAccountHomeSecretMutationLock(undefined, input.companyId, run).catch(error => {
      if ((error as NodeJS.ErrnoException)?.code === WORKSPACE_RESTORE_LOCK_TIMEOUT_CODE) {
        throw unprocessable("AI credentials are being updated. Retry shortly.", { code: "ai_connection_busy" });
      }
      throw error;
    })
    : run();
}
