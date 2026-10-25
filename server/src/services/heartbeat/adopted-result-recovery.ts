// Fork (SX-1746): finalizes an adopted local CLI run from its persisted output.
// The orphan reaper calls this once the child and its process group are gone
// and the output tail has stopped; everything else about the run is the
// shared completeRun finalizer, with the provider's verdict given explicitly.
import type { Db, agents, heartbeatRuns } from "@paperclipai/db";
import type { ServerAdapterModule } from "../../adapters/types.js";
import { parseObject } from "../../adapters/utils.js";
import { logger } from "../../middleware/logger.js";
import type { CurrentUserRedactionOptions } from "../../log-redaction.js";
import {
  decideAdoptedRunResult,
  type AdoptedResultFallbackReason,
} from "../adopted-run-result.js";
import type { RunLogStore } from "../run-log-store.js";
import type {
  CompleteHeartbeatRunInput,
  CompleteHeartbeatRunResult,
  CompleteHeartbeatRunSource,
} from "./run-completion.js";
import type { EffectiveRunSessionConfigMetadata } from "./workspaces.js";
import type { LocalResultRecoverySnapshot } from "./local-result-recovery.js";
import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;
type IssueContext = CompleteHeartbeatRunInput["issueContext"];

export interface AdoptedResultRecoveryDependencies {
  /**
   * Runs whose output is being read or finalized right now. Shared with the
   * recovery service, whose process-gone backstop leaves these to the reaper.
   */
  pending: Set<string>;
  runLogStore: RunLogStore;
  getRun: (runId: string) => Promise<Run | null>;
  getAgent: (agentId: string) => Promise<Agent | null>;
  getIssueExecutionContext: (companyId: string, issueId: string) => Promise<NonNullable<IssueContext>>;
  getCurrentUserRedactionOptions: () => Promise<CurrentUserRedactionOptions>;
  resolveLedgerScopeForRun: (db: Db, companyId: string, run: Run) => Promise<Record<string, unknown>>;
  getSessionCodec: (adapterType: string) => CompleteHeartbeatRunInput["sessionCodec"];
  findAdapter: (adapterType: string) => ServerAdapterModule | null;
  /** Resolved when called: the finalizer is created after the recovery service. */
  completeRun: (
    input: CompleteHeartbeatRunInput & CompleteHeartbeatRunSource,
  ) => Promise<CompleteHeartbeatRunResult>;
}

export type AdoptedResultRecoveryOutcome =
  /** This caller wrote the terminal state; the reaper runs the cleanup. */
  | { kind: "finalized"; run: Run; outcome: "succeeded" | "failed" }
  /** The run left running before our write (Stop, the backstop, an earlier sweep). Nothing was done. */
  | { kind: "lost" }
  /** Our write landed and a later step threw. Logged; the run stays finalized. */
  | { kind: "finalization_error"; run: Run; error: unknown }
  /** Not finalized from output; the reaper continues with process_lost. */
  | { kind: "fallback"; reason: AdoptedResultFallbackReason; resultRecovery: Record<string, unknown> };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function sessionConfigMetadataFromSnapshot(
  snapshot: LocalResultRecoverySnapshot,
): EffectiveRunSessionConfigMetadata {
  const { config } = snapshot.session;
  // `fingerprints` is only read when a run is dispatched; finalization keeps
  // the persisted category fingerprints.
  return {
    ...(config.aiCredentialIdentity ? { aiCredentialIdentity: config.aiCredentialIdentity } : {}),
    version: config.version,
    fingerprint: config.fingerprint,
    categories: config.categories,
    categoryFingerprints: config.categoryFingerprints,
    fingerprints: {},
  } as unknown as EffectiveRunSessionConfigMetadata;
}

export function createAdoptedResultRecovery(db: Db, deps: AdoptedResultRecoveryDependencies) {
  const { pending } = deps;

  async function recover(run: Run): Promise<AdoptedResultRecoveryOutcome> {
    if (pending.has(run.id)) {
      return { kind: "lost" };
    }
    pending.add(run.id);
    try {
      return await recoverUnguarded(run);
    } finally {
      pending.delete(run.id);
    }
  }

  async function recoverUnguarded(run: Run): Promise<AdoptedResultRecoveryOutcome> {
    const agent = await deps.getAgent(run.agentId);
    const decision = await decideAdoptedRunResult({
      db,
      runLogStore: deps.runLogStore,
      run,
      agentAdapterType: agent && agent.companyId === run.companyId ? agent.adapterType : "",
      findAdapter: deps.findAdapter,
    });
    if (decision.kind === "fallback") {
      return { kind: "fallback", reason: decision.reason, resultRecovery: decision.resultRecovery };
    }
    if (!agent) {
      return { kind: "lost" };
    }

    // Recheck the row we are about to finalize: Stop, the backstop or an
    // earlier sweep may have ended it while the log was being read.
    const latest = await deps.getRun(run.id);
    if (!latest || isHeartbeatRunTerminalStatus(latest.status)) return { kind: "lost" };

    const { snapshot } = decision;
    try {
      const context = parseObject(latest.contextSnapshot);
      const issueId = readNonEmptyString(context.issueId);
      const issueContext = issueId ? await deps.getIssueExecutionContext(agent.companyId, issueId) : null;
      const storedLedgerScope = parseObject(parseObject(latest.usageJson).ledgerScope);
      const runLedgerScope = Object.keys(storedLedgerScope).length > 0
        ? storedLedgerScope
        : await deps.resolveLedgerScopeForRun(db, agent.companyId, latest);
      const currentUserRedactionOptions = await deps.getCurrentUserRedactionOptions();
      const stdoutExcerpt = latest.stdoutExcerpt ?? "";
      const stderrExcerpt = latest.stderrExcerpt ?? "";
      const completed = await deps.completeRun({
        source: "adopted_output",
        recoveredOutcome: decision.outcome,
        resultRecovery: decision.resultRecovery,
        run: latest,
        agent,
        issueId,
        issueRef: issueContext
          ? { workMode: issueContext.workMode, identifier: issueContext.identifier, title: issueContext.title }
          : null,
        signal: new AbortController().signal,
        output: {
          handle: null,
          outputProgressState: { pending: null },
          flushOutputProgress: async () => {},
          stdoutExcerpt,
          stderrExcerpt,
        },
        session: {
          runtimeForAdapter: {
            sessionId: snapshot.session.dispatched.sessionId,
            sessionDisplayId: snapshot.session.dispatched.sessionDisplayId,
          },
          previousSessionParams: snapshot.session.previousParams,
          taskKey: snapshot.taskKey,
          configuredModel: snapshot.configuredModel,
          sessionConfigMetadata: sessionConfigMetadataFromSnapshot(snapshot),
        },
        readFailureReportSecrets: () => [],
        adapterResult: decision.result,
        sessionCodec: deps.getSessionCodec(snapshot.adapterType),
        taskSessionForRun: snapshot.session.taskSessionReused
          ? ({} as NonNullable<CompleteHeartbeatRunInput["taskSessionForRun"]>)
          : null,
        sessionCompaction: { rotate: snapshot.session.rotated, reason: snapshot.session.rotationReason },
        configFreshnessResultMetadata: snapshot.configFreshness,
        runLedgerScope,
        currentUserRedactionOptions,
        providerTraceCapture: false,
        onProviderTraceFinalized: () => {},
        issueContext,
        onLog: async () => {},
      });
      if (!completed.won || !completed.run) return { kind: "lost" };
      return { kind: "finalized", run: completed.run, outcome: decision.outcome };
    } catch (error) {
      // The terminal write is the boundary. Before it, the run is still
      // running and the reaper falls back to process_lost; after it, the run
      // keeps the recovered result and the error is only logged.
      const after = await deps.getRun(run.id).catch(() => null);
      const recoveredRow = readRecoveredProvenance(after);
      if (after && recoveredRow) {
        logger.error(
          { err: error, runId: run.id },
          "adopted run finalization failed after the terminal write; the recovered result is kept",
        );
        return { kind: "finalization_error", run: after, error };
      }
      if (after && isHeartbeatRunTerminalStatus(after.status)) return { kind: "lost" };
      logger.warn(
        { err: error, runId: run.id },
        "adopted run result could not be finalized from output; falling back to process loss",
      );
      return {
        kind: "fallback",
        reason: "finalization_error",
        resultRecovery: {
          version: 1,
          source: "run_log",
          exitCodeKnown: false,
          decision: "inconclusive",
          reason: "finalization_error",
          invocation: decision.resultRecovery.invocation,
        },
      };
    }
  }

  return { recover };
}

// True when the row's terminal state was written by recovery from output.
function readRecoveredProvenance(run: Run | null) {
  if (!run || !isHeartbeatRunTerminalStatus(run.status)) return false;
  const hotRestart = parseObject(parseObject(run.resultJson).hotRestart);
  const recovery = parseObject(hotRestart.resultRecovery);
  return recovery.source === "run_log" && recovery.decision === "recovered";
}
