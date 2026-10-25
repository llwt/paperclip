// Fork (SX-1745): what finalizing a local CLI run needs once its parent
// process is gone. The snapshot is written before each CLI invocation
// (heartbeat.ts onAdapterMeta); the provenance merge is used by
// run-completion.ts for a result read back from adopted output.
import type {
  AdapterInvocationRecoveryMeta,
  AdapterOutputRecoveryContext,
  AdapterSessionCodec,
} from "@paperclipai/adapter-utils";
import { parseObject } from "../../adapters/utils.js";
import { stripPaperclipSessionMetadataFromSessionParams, type EffectiveRunSessionConfigMetadata } from "./workspaces.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export const LOCAL_RESULT_RECOVERY_CONTEXT_KEY = "localResultRecovery";

/**
 * What finalizing a local CLI run needs once its parent process is gone,
 * recorded in the run's contextSnapshot before each CLI invocation. An
 * allowlist: no runtimeConfig, env, prompt, tools or credentials, and session
 * params only as the adapter's session codec keeps them.
 */
export interface LocalResultRecoverySnapshot {
  version: 1;
  /** Adapter the run started with, not today's agent setting. */
  adapterType: string;
  taskKey: string | null;
  configuredModel: string | null;
  session: {
    previousParams: Record<string, unknown> | null;
    /** The session the adapter was dispatched with. */
    dispatched: {
      sessionId: string | null;
      sessionDisplayId: string | null;
      params: Record<string, unknown> | null;
    };
    taskSessionReused: boolean;
    rotated: boolean;
    rotationReason: string | null;
    config: {
      version: number;
      fingerprint: string;
      categories: string[];
      categoryFingerprints: Record<string, string>;
      aiCredentialIdentity: string | null;
    };
  };
  configFreshness: Record<string, unknown>;
  /** The latest CLI invocation; a fresh-session retry replaces it. */
  invocation: {
    /** 1 for the first invocation of the run, 2 after one retry, and so on. */
    number: number;
    /** First run-log seq that belongs to this invocation. */
    firstSeq: number;
    startedAt: string;
    engine: string | null;
    sessionIdBefore: string | null;
    /** The adapter started this invocation after its resume session proved unusable. */
    freshSessionRetry: boolean;
    sessionParams: Record<string, unknown> | null;
    accounting: {
      provider: string | null;
      biller: string | null;
      model: string | null;
      billingType: AdapterOutputRecoveryContext["accounting"]["billingType"];
    };
  };
}

const RECOVERY_BILLING_TYPES = new Set<string>([
  "api", "subscription", "metered_api", "subscription_included",
  "subscription_overage", "credits", "fixed", "unknown",
]);

// Session params as the codec keeps them, flat values only. Without an
// adapter codec only the session id is kept.
function safeRecoverySessionParams(
  codec: AdapterSessionCodec | null,
  params: Record<string, unknown> | null | undefined,
) {
  const stripped = stripPaperclipSessionMetadataFromSessionParams(params);
  if (!stripped) return null;
  if (!codec) {
    const sessionId = readNonEmptyString(stripped.sessionId);
    return sessionId ? { sessionId } : null;
  }
  const serialized = codec.serialize(stripped);
  if (!serialized) return null;
  const flat = Object.fromEntries(
    Object.entries(serialized).filter(([, value]) =>
      value === null || ["string", "number", "boolean"].includes(typeof value)),
  );
  return Object.keys(flat).length > 0 ? flat : null;
}

const RECOVERY_TEMPLATE_SESSION_ID = "paperclip-recovery-template";

// An adapter's invocation session template carries no session id (the hook
// adds the one it observes), and the CLI codecs keep nothing without one. So
// the template goes through the codec with a stand-in id, which is removed
// again: the codec still decides which fields are kept.
function safeRecoveryTemplateParams(
  codec: AdapterSessionCodec | null,
  params: Record<string, unknown> | null | undefined,
) {
  const stripped = stripPaperclipSessionMetadataFromSessionParams(params);
  if (!stripped) return null;
  if (readNonEmptyString(stripped.sessionId) ?? readNonEmptyString(stripped.session_id)) {
    return safeRecoverySessionParams(codec, stripped);
  }
  const kept = safeRecoverySessionParams(codec, stripped)
    ?? safeRecoverySessionParams(codec, { ...stripped, sessionId: RECOVERY_TEMPLATE_SESSION_ID });
  if (!kept) return null;
  const template = Object.fromEntries(
    Object.entries(kept).filter(([key]) => key !== "sessionId" && key !== "session_id"),
  );
  return Object.keys(template).length > 0 ? template : null;
}

// The adapter's recovery facts, or null (no recovery context) when the
// version is not 1 or a field is missing.
function readInvocationRecoveryMeta(
  value: AdapterInvocationRecoveryMeta | null | undefined,
): AdapterInvocationRecoveryMeta | null {
  if (!value || typeof value !== "object" || value.version !== 1) return null;
  const accounting = value.accounting as Partial<AdapterInvocationRecoveryMeta["accounting"]> | null | undefined;
  if (
    !("engine" in value) || !("sessionIdBefore" in value) || !("sessionParams" in value) ||
    !accounting || typeof accounting !== "object" ||
    !(["provider", "biller", "model", "billingType"] as const).every((key) => key in accounting)
  ) return null;
  return value;
}

export function buildLocalResultRecoverySnapshot(input: {
  adapterType: string;
  /** The adapter's own session codec, or null when it has none. */
  codec: AdapterSessionCodec | null;
  taskKey: string | null;
  configuredModel: string | null;
  previousSessionParams: Record<string, unknown> | null;
  dispatched: {
    sessionId: string | null;
    sessionDisplayId: string | null;
    sessionParams: Record<string, unknown> | null;
  };
  taskSessionReused: boolean;
  rotated: boolean;
  rotationReason: string | null;
  sessionConfig: EffectiveRunSessionConfigMetadata;
  configFreshness: Record<string, unknown>;
  invocationNumber: number;
  firstSeq: number;
  startedAt: Date;
  recovery: AdapterInvocationRecoveryMeta | null | undefined;
}): LocalResultRecoverySnapshot {
  const recovery = readInvocationRecoveryMeta(input.recovery);
  const billingType = readNonEmptyString(recovery?.accounting.billingType);
  return {
    version: 1,
    adapterType: input.adapterType,
    taskKey: input.taskKey,
    configuredModel: input.configuredModel,
    session: {
      previousParams: safeRecoverySessionParams(input.codec, input.previousSessionParams),
      dispatched: {
        sessionId: input.dispatched.sessionId,
        sessionDisplayId: input.dispatched.sessionDisplayId,
        params: safeRecoverySessionParams(input.codec, input.dispatched.sessionParams),
      },
      taskSessionReused: input.taskSessionReused,
      rotated: input.rotated,
      rotationReason: input.rotationReason,
      config: {
        version: input.sessionConfig.version,
        fingerprint: input.sessionConfig.fingerprint,
        categories: [...input.sessionConfig.categories],
        categoryFingerprints: { ...input.sessionConfig.categoryFingerprints },
        aiCredentialIdentity: input.sessionConfig.aiCredentialIdentity ?? null,
      },
    },
    configFreshness: input.configFreshness,
    invocation: {
      number: input.invocationNumber,
      firstSeq: input.firstSeq,
      startedAt: input.startedAt.toISOString(),
      engine: readNonEmptyString(recovery?.engine),
      sessionIdBefore: readNonEmptyString(recovery?.sessionIdBefore),
      freshSessionRetry: recovery?.freshSessionRetry === true,
      sessionParams: safeRecoveryTemplateParams(input.codec, recovery?.sessionParams),
      accounting: {
        provider: readNonEmptyString(recovery?.accounting.provider),
        biller: readNonEmptyString(recovery?.accounting.biller),
        model: readNonEmptyString(recovery?.accounting.model),
        billingType: billingType && RECOVERY_BILLING_TYPES.has(billingType)
          ? (billingType as NonNullable<AdapterOutputRecoveryContext["accounting"]["billingType"]>)
          : null,
      },
    },
  };
}

/** The parser-only view of a snapshot handed to an adapter's recovery hook. */
export function adapterOutputRecoveryContextFromSnapshot(
  snapshot: LocalResultRecoverySnapshot,
): AdapterOutputRecoveryContext | null {
  if (!snapshot.invocation.engine) return null;
  return {
    version: 1,
    adapterType: snapshot.adapterType,
    engine: snapshot.invocation.engine,
    invocation: {
      firstSeq: snapshot.invocation.firstSeq,
      sessionIdBefore: snapshot.invocation.sessionIdBefore,
      freshSessionRetry: snapshot.invocation.freshSessionRetry === true,
      sessionParams: snapshot.invocation.sessionParams,
    },
    accounting: { ...snapshot.invocation.accounting },
    runStart: {
      sessionIdBefore: snapshot.session.dispatched.sessionId,
      sessionDisplayId: snapshot.session.dispatched.sessionDisplayId,
      sessionParams: snapshot.session.dispatched.params,
    },
  };
}

// The server-owned records of an adopted run, for a result read back from its
// output: the adoption and output-capture provenance and the leftover process
// sweep (SX-1851) stay, the adapter's result JSON cannot replace them, and
// recovery diagnostics go next to the hotRestart record.
export function recoveredHotRestartResultJson(
  existingResultJson: Record<string, unknown> | null | undefined,
  resultRecovery: Record<string, unknown> | undefined,
) {
  const existingResult = parseObject(existingResultJson);
  const existing = parseObject(existingResult.hotRestart);
  const leftoverProcessSweep = parseObject(existingResult.leftoverProcessSweep);
  return {
    ...(Object.keys(existing).length > 0 || resultRecovery
      ? {
          hotRestart: {
            ...existing,
            ...(resultRecovery ? { resultRecovery } : {}),
          },
        }
      : {}),
    ...(leftoverProcessSweep.kind === "leftover_process_sweep"
      ? { leftoverProcessSweep }
      : {}),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isParamsOrNull(value: unknown): value is Record<string, unknown> | null {
  return value === null || isObject(value);
}

/**
 * The recovery snapshot persisted in a run's contextSnapshot, or null when the
 * run has none (it started before the snapshot existed) or it does not have the
 * shape this version writes. Nothing is guessed for a missing or damaged field.
 */
export function readLocalResultRecoverySnapshot(
  contextSnapshot: Record<string, unknown> | null | undefined,
): LocalResultRecoverySnapshot | null {
  const value = parseObject(contextSnapshot)[LOCAL_RESULT_RECOVERY_CONTEXT_KEY];
  if (!isObject(value) || value.version !== 1) return null;
  const { session, invocation } = value;
  if (typeof value.adapterType !== "string" || value.adapterType.length === 0) return null;
  if (!isStringOrNull(value.taskKey) || !isStringOrNull(value.configuredModel)) return null;
  if (!isObject(value.configFreshness)) return null;
  if (!isObject(session) || !isObject(invocation)) return null;
  const dispatched = session.dispatched;
  const config = session.config;
  if (
    !isParamsOrNull(session.previousParams) ||
    !isObject(dispatched) ||
    !isStringOrNull(dispatched.sessionId) ||
    !isStringOrNull(dispatched.sessionDisplayId) ||
    !isParamsOrNull(dispatched.params) ||
    typeof session.taskSessionReused !== "boolean" ||
    typeof session.rotated !== "boolean" ||
    !isStringOrNull(session.rotationReason) ||
    !isObject(config) ||
    typeof config.version !== "number" ||
    typeof config.fingerprint !== "string" ||
    !Array.isArray(config.categories) ||
    !isObject(config.categoryFingerprints) ||
    !isStringOrNull(config.aiCredentialIdentity)
  ) return null;
  const accounting = invocation.accounting;
  if (
    !Number.isSafeInteger(invocation.number) ||
    !Number.isSafeInteger(invocation.firstSeq) ||
    (invocation.firstSeq as number) < 0 ||
    typeof invocation.startedAt !== "string" ||
    !isStringOrNull(invocation.engine) ||
    !isStringOrNull(invocation.sessionIdBefore) ||
    !isParamsOrNull(invocation.sessionParams) ||
    !isObject(accounting)
  ) return null;
  return value as unknown as LocalResultRecoverySnapshot;
}
