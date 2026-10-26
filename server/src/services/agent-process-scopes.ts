// Cancel, shutdown and restart reconciliation of agent process scopes
// (SX-2305 step 5; plan SX-2306, "Ownership, cancellation and restart").
//
// Every launch under process isolation leaves a private record in
// `<instance>/runtime/agent-scopes/`. A launch made by this server process is
// owned by its in-memory handle, which stops its scope when its lifetime ends.
// This module decides the records an earlier server process left behind: it
// keeps those whose owner is still live and authorised, and stops the exact
// scope of every other one. It only ever reads this instance's namespace, and
// it stops a scope only through `terminateOwnedProcessTree`, which signals
// processes whose cgroup is exactly that scope (or, without a scope, the
// recorded root verified by boot id and start time). Nothing here kills by
// process name, by unit prefix, a whole slice, or a PID it cannot verify.
//
// Reading the registry does not depend on the isolation mode: after a rollback
// to `off`, scopes started earlier are still reconciled until none remain.
import { desc, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, workspaceRuntimeServices } from "@paperclipai/db";
import { getAgentProcessIsolation, isAcpWarmProviderOwnerId } from "@paperclipai/adapter-utils/server-utils";
import {
  agentScopeRegistryDir,
  isScopeLaunchedByThisProcess,
  isScopeRootAlive,
  isScopeUnitOfOwner,
  listOwnedScopeRecords,
  listUnmatchedScopeUnits,
  terminateOwnedProcessTree,
  type ProcessOwnerKind,
  type ScopeRecord,
  type TerminateResult,
} from "@paperclipai/process-launch";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger as defaultLogger } from "../middleware/logger.js";

export interface AgentScopeRegistry {
  instanceId: string;
  registryDir: string;
  /** Time between the first signal and SIGKILL. */
  graceMs?: number;
  killWaitMs?: number;
  /** How long one pass waits for an output relay to drain and exit by itself. */
  relayDrainMs?: number;
  /**
   * How long reconciliation keeps waiting, over later passes, for a relay of
   * an ended run that does not drain before it stops it anyway.
   */
  relayDrainDeadlineMs?: number;
  /** Test seams for `terminateOwnedProcessTree` and the unmatched-unit scan. */
  cgroupRoot?: string;
  procRoot?: string;
  managerCgroup?: string | null;
}

type ScopeLogger = Pick<typeof defaultLogger, "info" | "warn">;

let registryOverride: AgentScopeRegistry | null = null;

/** Test hook: point this module at a private registry, or back to the instance's own. */
export function setAgentScopeRegistryForTests(registry: AgentScopeRegistry | null): void {
  registryOverride = registry;
}

function currentRegistry(): AgentScopeRegistry {
  return registryOverride ?? {
    instanceId: resolvePaperclipInstanceId(),
    registryDir: agentScopeRegistryDir(resolvePaperclipInstanceRoot()),
  };
}

// Run statuses after which no process of the run may remain. Any other
// status, including one this module does not know, keeps the run's scopes.
const TERMINAL_RUN_STATUSES = new Set(["succeeded", "interrupted", "failed", "cancelled", "timed_out"]);
// Runtime service rows whose process is meant to be running.
const LIVE_SERVICE_STATUSES = new Set(["provisioning", "starting", "running"]);
const DEFAULT_RELAY_DRAIN_MS = 5_000;
const DEFAULT_RELAY_DRAIN_DEADLINE_MS = 10 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ScopeOwnerFacts {
  /** The run row of a `run` or `relay` owner; null when there is none. */
  run: { status: string; companyId: string; runtimeMode: string | null } | null;
  /**
   * For a native `runner` or `warm_provider` owner: the latest run bound to
   * that runner instance, as native restart recovery left it; null when no
   * run names it.
   */
  nativeRun?: { status: string; companyId: string } | null;
  /** The runtime service row of a `managed_service` owner; null when there is none. */
  service: { status: string; companyId: string } | null;
  /** Whether the record's root process still runs (same boot, PID and start time). */
  rootAlive: boolean;
}

export interface ScopeDecision {
  /** `hold`: the owner cannot be resolved; the scope is left running and reported as pending. */
  action: "keep" | "stop" | "hold";
  reason: string;
}

function companyMatches(record: ScopeRecord, companyId: string): boolean {
  const recorded = record.manifest.owner.companyId;
  return recorded === null || recorded === companyId;
}

/**
 * What to do with a scope an earlier server process left behind. Pure, so the
 * restart matrix can be tested case by case.
 *
 * - `run`: kept while its run is not terminal and the launch got past its
 *   intent, so existing run recovery (hot-restart adoption, the orphan
 *   reaper) stays the owner. A run's scope ends with the run. A partial
 *   launch (intent only) can never be adopted: no server knows its process.
 *   A native run's own provider lives in its runner's scope, so a `run`
 *   scope of a native run is a server-side tool command, which no later
 *   server can adopt.
 * - `relay`: kept while its run is not terminal, so adopted output still
 *   drains; once the run has ended it is stopped only after it drained (see
 *   `stopRelayAfterDrain`).
 * - `runner` and native `warm_provider` (owned by the runner instance id):
 *   once the root is gone, what remains is leftovers. A live root is
 *   resolved against the latest run bound to that runner, after native
 *   restart recovery classified it: kept while that run is active (native
 *   recovery reattaches it, or holds it while ownership is unproven) or
 *   succeeded (a warm runner is retained only after a successful turn);
 *   stopped when recovery or the run ended it otherwise, or the company does
 *   not match. A live root that no run names is held and reported, never
 *   stopped on a guess.
 * - legacy ACP `warm_provider` and `auxiliary`: their owner was the earlier
 *   server process itself (ACP talks over the server's stdio), so they end
 *   with it.
 * - `managed_service`: kept while its runtime service row says the service
 *   should run; the workspace runtime decides that, as before.
 */
export function decideInheritedScope(record: ScopeRecord, facts: ScopeOwnerFacts): ScopeDecision {
  const { owner, state } = record.manifest;
  switch (owner.kind) {
    case "run":
    case "relay": {
      const run = facts.run;
      if (!run || !companyMatches(record, run.companyId)) return { action: "stop", reason: "owner_run_missing" };
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { action: "stop", reason: `owner_run_${run.status}` };
      if (owner.kind === "run" && state !== "spawned") return { action: "stop", reason: "partial_launch" };
      if (owner.kind === "run" && run.runtimeMode === "native") return { action: "stop", reason: "server_tool_unadoptable" };
      return { action: "keep", reason: "owner_run_active" };
    }
    case "runner":
    case "warm_provider":
      if (owner.kind === "warm_provider" && isAcpWarmProviderOwnerId(owner.id)) {
        return { action: "stop", reason: "server_stdio_provider" };
      }
      return decideNativeScope(record, facts);
    case "auxiliary":
      return { action: "stop", reason: "auxiliary_owner_ended" };
    case "managed_service": {
      const service = facts.service;
      if (!service || !companyMatches(record, service.companyId)) return { action: "stop", reason: "owner_service_missing" };
      if (!LIVE_SERVICE_STATUSES.has(service.status)) return { action: "stop", reason: `owner_service_${service.status}` };
      return { action: "keep", reason: "owner_service_active" };
    }
    default:
      return { action: "stop", reason: "unknown_owner_kind" };
  }
}

function decideNativeScope(record: ScopeRecord, facts: ScopeOwnerFacts): ScopeDecision {
  if (!facts.rootAlive) return { action: "stop", reason: "native_root_gone" };
  const run = facts.nativeRun ?? null;
  if (!run) return { action: "hold", reason: "native_owner_unresolved" };
  if (!companyMatches(record, run.companyId)) return { action: "stop", reason: "native_owner_company_mismatch" };
  if (run.status === "succeeded") return { action: "keep", reason: "native_runner_retained" };
  if (TERMINAL_RUN_STATUSES.has(run.status)) return { action: "stop", reason: `native_owner_run_${run.status}` };
  return { action: "keep", reason: "native_owner_run_active" };
}

export interface ScopeOutcome {
  unit: string;
  ownerKind: ProcessOwnerKind | null;
  reason: string;
  /** For stops: how the termination ended. */
  outcome?: TerminateResult["outcome"];
}

export interface AgentScopeReconciliation {
  kept: ScopeOutcome[];
  stopped: ScopeOutcome[];
  /** Records left in place because cleanup was not confirmed, or could not be read. */
  pending: ScopeOutcome[];
  /** Live units in this instance's namespace with no record: reported, never stopped. */
  unmatchedUnits: string[];
}

function emptyReconciliation(): AgentScopeReconciliation {
  return { kept: [], stopped: [], pending: [], unmatchedUnits: [] };
}

function terminationSettled(outcome: TerminateResult["outcome"]): boolean {
  return outcome === "terminated" || outcome === "already_empty" || outcome === "missing_record";
}

async function stopRecord(
  registry: AgentScopeRegistry,
  record: ScopeRecord,
  reason: string,
  report: AgentScopeReconciliation,
  options: { graceMs?: number; signal?: NodeJS.Signals } = {},
): Promise<TerminateResult> {
  let result: TerminateResult;
  try {
    result = await terminateOwnedProcessTree(record.ref, {
      instanceId: registry.instanceId,
      graceMs: options.graceMs ?? registry.graceMs,
      killWaitMs: registry.killWaitMs,
      signal: options.signal,
      cgroupRoot: registry.cgroupRoot,
      procRoot: registry.procRoot,
    });
  } catch (error) {
    result = {
      outcome: "unconfirmed",
      containment: "none",
      signalled: 0,
      reason: error instanceof Error ? error.message : "terminate_failed",
    };
  }
  const entry = { unit: record.manifest.unit, ownerKind: record.manifest.owner.kind, reason, outcome: result.outcome };
  if (terminationSettled(result.outcome)) report.stopped.push(entry);
  else report.pending.push({ ...entry, reason: `${reason}:${result.reason ?? result.outcome}` });
  return result;
}

// Relays that did not drain, by unit, with the time this process first found one so.
const relayDrainSince = new Map<string, number>();

async function waitForRootExit(record: ScopeRecord, procRoot: string | undefined, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isScopeRootAlive(record, procRoot)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

/**
 * Stop an output relay whose run has ended. A relay outlives its provider on
 * purpose: bytes the provider wrote can still be in its pipes when the
 * provider exits. It ignores SIGTERM and exits by itself, after it wrote its
 * end marker, once both pipes reach EOF, which is when every process of the
 * run's scope that held them is gone. So the run's own scopes are stopped
 * first, and the relay is given time to drain and exit; only then is its
 * (empty) scope closed and its record removed. A relay that has not drained
 * stays running and is reported as pending (`relay_draining`). Only
 * reconciliation, after `relayDrainDeadlineMs`, stops a relay that never
 * drains, and reports that its output may be incomplete (`relay_undrained`).
 */
async function stopRelayAfterDrain(
  registry: AgentScopeRegistry,
  record: ScopeRecord,
  reason: string,
  report: AgentScopeReconciliation,
  options: { drainMs?: number; abandonUndrained?: boolean; logger?: ScopeLogger } = {},
): Promise<void> {
  const { unit } = record.manifest;
  const drainMs = options.drainMs ?? registry.relayDrainMs ?? DEFAULT_RELAY_DRAIN_MS;
  if (await waitForRootExit(record, registry.procRoot, drainMs)) {
    relayDrainSince.delete(unit);
    await stopRecord(registry, record, reason, report);
    return;
  }
  const since = relayDrainSince.get(unit) ?? Date.now();
  relayDrainSince.set(unit, since);
  const deadlineMs = registry.relayDrainDeadlineMs ?? DEFAULT_RELAY_DRAIN_DEADLINE_MS;
  if (options.abandonUndrained && Date.now() - since >= deadlineMs) {
    relayDrainSince.delete(unit);
    (options.logger ?? defaultLogger).warn(
      { unit, ownerId: record.manifest.owner.id, drainingSince: new Date(since).toISOString() },
      "run output relay did not drain after its run ended; stopping it, its output may be incomplete",
    );
    await stopRecord(registry, record, `${reason}:relay_undrained`, report);
    return;
  }
  report.pending.push({ unit, ownerKind: "relay", reason: `${reason}:relay_draining` });
}

/** Stop the given records: every other kind first, then relays once they drained. */
async function stopRecordsRelaysLast(
  registry: AgentScopeRegistry,
  stops: Array<{ record: ScopeRecord; reason: string }>,
  report: AgentScopeReconciliation,
  options: { graceMs?: number; signal?: NodeJS.Signals; relayDrainMs?: number; abandonUndrained?: boolean; logger?: ScopeLogger } = {},
): Promise<void> {
  const isRelay = (entry: { record: ScopeRecord }) => entry.record.manifest.owner.kind === "relay";
  await Promise.all(stops.filter((entry) => !isRelay(entry)).map(({ record, reason }) =>
    stopRecord(registry, record, reason, report, { graceMs: options.graceMs, signal: options.signal })));
  await Promise.all(stops.filter(isRelay).map(({ record, reason }) =>
    stopRelayAfterDrain(registry, record, reason, report, {
      drainMs: options.relayDrainMs,
      abandonUndrained: options.abandonUndrained,
      logger: options.logger,
    })));
}

async function loadOwnerFacts(db: Db, records: ScopeRecord[]) {
  const runIds = new Set<string>();
  const serviceIds = new Set<string>();
  const runnerIds = new Set<string>();
  for (const { manifest } of records) {
    const { kind, id } = manifest.owner;
    if (!UUID.test(id)) continue;
    if (kind === "run" || kind === "relay") runIds.add(id);
    else if (kind === "managed_service") serviceIds.add(id);
    else if (kind === "runner" || (kind === "warm_provider" && !isAcpWarmProviderOwnerId(id))) runnerIds.add(id);
  }
  const runs = runIds.size === 0
    ? []
    : await db
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          companyId: heartbeatRuns.companyId,
          runtimeMode: heartbeatRuns.runtimeMode,
        })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.id, [...runIds]));
  const services = serviceIds.size === 0
    ? []
    : await db
        .select({
          id: workspaceRuntimeServices.id,
          status: workspaceRuntimeServices.status,
          companyId: workspaceRuntimeServices.companyId,
        })
        .from(workspaceRuntimeServices)
        .where(inArray(workspaceRuntimeServices.id, [...serviceIds]));
  const runnerRuns = runnerIds.size === 0
    ? []
    : await db
        .select({
          runnerInstanceId: heartbeatRuns.runnerInstanceId,
          status: heartbeatRuns.status,
          companyId: heartbeatRuns.companyId,
        })
        .from(heartbeatRuns)
        // Not narrowed by the company the manifest names: the run that owns
        // the runner decides, and a company that differs from the manifest's
        // stops the scope. The runner instance id has no index; this query
        // runs only while inherited native scopes exist.
        .where(inArray(heartbeatRuns.runnerInstanceId, [...runnerIds]))
        .orderBy(desc(heartbeatRuns.createdAt));
  // Newest first: a retained runner is bound to the latest run that used it.
  const nativeRuns = new Map<string, { status: string; companyId: string }>();
  for (const run of runnerRuns) {
    if (run.runnerInstanceId && !nativeRuns.has(run.runnerInstanceId)) nativeRuns.set(run.runnerInstanceId, run);
  }
  return {
    runs: new Map(runs.map((run) => [run.id, run])),
    services: new Map(services.map((service) => [service.id, service])),
    nativeRuns,
  };
}

// Run admission waits for the first classification of inherited scopes (plan
// SX-2306: "New admission waits for a classification of owned scopes"). The
// server holds admission at startup, before restart recovery; the first
// reconciliation pass that completes opens it, and a pass that throws leaves
// it held until a later pass completes. Records left pending (cleanup not
// confirmed, unreadable, owner unresolved) are classified and reported; they
// do not hold admission. Admission is open unless held, so code that never
// holds it (tests, tools) is unaffected.
type AdmissionState =
  | { state: "open" }
  | { state: "held"; waiters: Array<(admitted: boolean) => void> }
  | { state: "abandoned" };

let admission: AdmissionState = { state: "open" };

/** Hold run admission until the next reconciliation pass completes. */
export function holdAgentRunAdmission(): void {
  if (admission.state !== "held") admission = { state: "held", waiters: [] };
}

export function isAgentRunAdmissionOpen(): boolean {
  return admission.state === "open";
}

function settleAdmission(next: { state: "open" } | { state: "abandoned" }): void {
  if (admission.state !== "held") return;
  const { waiters } = admission;
  admission = next;
  for (const resolve of waiters) resolve(next.state === "open");
}

/**
 * Resolves true once admission is open, or false when the server stops
 * before it opened; the caller then starts nothing.
 */
export function waitForAgentRunAdmission(): Promise<boolean> {
  if (admission.state === "open") return Promise.resolve(true);
  if (admission.state === "abandoned") return Promise.resolve(false);
  const { waiters } = admission;
  return new Promise((resolve) => waiters.push(resolve));
}

/** Shutdown: release waiters without admitting them, so the run drain cannot hang. */
export function abandonHeldAgentRunAdmission(): void {
  settleAdmission({ state: "abandoned" });
}

/** Test hook. */
export function resetAgentRunAdmissionForTests(): void {
  settleAdmission({ state: "abandoned" });
  admission = { state: "open" };
}

let inFlight: { pass: Promise<AgentScopeReconciliation>; admission: AdmissionState } | null = null;
let lastPendingSignature = "";

/**
 * Decide every record an earlier server process left in this instance's
 * registry, keeping live authorised owners and stopping the rest. Run it at
 * startup after native recovery, hot-restart adoption and the orphan reaper,
 * before queued runs are admitted, and again on the periodic reaper tick so a
 * run that ends later does not leave its scope behind. Concurrent calls share
 * one pass. A pass that completes opens held run admission, if it was held
 * when the pass started.
 */
export function reconcileAgentScopes(input: {
  db: Db;
  logger?: ScopeLogger;
  /** Also report live namespace units that have no record (startup). */
  reportUnmatched?: boolean;
}): Promise<AgentScopeReconciliation> {
  if (inFlight?.admission === admission) return inFlight.pass;
  // A pass that started before admission was held cannot open it; run a new one after it.
  const previous = inFlight?.pass.catch(() => undefined) ?? Promise.resolve();
  const admissionAtStart = admission;
  const pass = previous
    .then(() => reconcileOnce(input))
    .then((report) => {
      if (admission === admissionAtStart) settleAdmission({ state: "open" });
      return report;
    })
    .finally(() => {
      if (inFlight?.pass === pass) inFlight = null;
    });
  inFlight = { pass, admission };
  return pass;
}

async function reconcileOnce(input: {
  db: Db;
  logger?: ScopeLogger;
  reportUnmatched?: boolean;
}): Promise<AgentScopeReconciliation> {
  const log = input.logger ?? defaultLogger;
  const registry = currentRegistry();
  const report = emptyReconciliation();
  const { records, unreadable } = listOwnedScopeRecords(registry.registryDir, registry.instanceId);
  for (const ref of unreadable) report.pending.push({ unit: ref.unit, ownerKind: null, reason: "record_unreadable" });

  const inherited = records.filter((record) => !isScopeLaunchedByThisProcess(record.ref));
  if (inherited.length > 0) {
    const facts = await loadOwnerFacts(input.db, inherited);
    const stops: Array<{ record: ScopeRecord; reason: string }> = [];
    for (const record of inherited) {
      const { owner } = record.manifest;
      const run = owner.kind === "run" || owner.kind === "relay" ? facts.runs.get(owner.id) ?? null : null;
      const service = owner.kind === "managed_service" ? facts.services.get(owner.id) ?? null : null;
      const decision = decideInheritedScope(record, {
        run,
        service,
        nativeRun: owner.kind === "runner" || owner.kind === "warm_provider" ? facts.nativeRuns.get(owner.id) ?? null : null,
        rootAlive: isScopeRootAlive(record, registry.procRoot),
      });
      if (decision.action === "keep") {
        report.kept.push({ unit: record.manifest.unit, ownerKind: owner.kind, reason: decision.reason });
      } else if (decision.action === "hold") {
        report.pending.push({ unit: record.manifest.unit, ownerKind: owner.kind, reason: decision.reason });
      } else {
        stops.push({ record, reason: decision.reason });
      }
    }
    await stopRecordsRelaysLast(registry, stops, report, { abandonUndrained: true, logger: log });
  }

  if (input.reportUnmatched) {
    const { policy } = getAgentProcessIsolation();
    const slices = new Set(records.map((record) => record.manifest.slice));
    if (policy.mode === "systemd") slices.add(policy.slice);
    report.unmatchedUnits = listUnmatchedScopeUnits({
      registryDir: registry.registryDir,
      instanceId: registry.instanceId,
      slices: [...slices],
      cgroupRoot: registry.cgroupRoot,
      managerCgroup: registry.managerCgroup,
    });
  }

  if (report.stopped.length > 0) {
    log.info({ stopped: report.stopped }, "stopped agent process scopes whose owner has ended");
  }
  const pendingSignature = report.pending.map((entry) => `${entry.unit}:${entry.reason}`).sort().join(",");
  if (report.pending.length > 0 && pendingSignature !== lastPendingSignature) {
    log.warn(
      { pending: report.pending },
      "agent process scope cleanup not confirmed; records kept for the next reconciliation",
    );
  }
  lastPendingSignature = pendingSignature;
  if (report.unmatchedUnits.length > 0) {
    log.warn(
      { unmatchedUnits: report.unmatchedUnits },
      "agent process scopes of this instance have no launch record; left running and not stopped",
    );
  }
  return report;
}

export interface OwnerScopeTermination {
  /** Records found for the owner that an earlier server process launched. */
  found: number;
  /** True when every found scope is confirmed stopped (or none was found). */
  settled: boolean;
  results: ScopeOutcome[];
}

/**
 * Stop the scopes an earlier server process launched for one owner, such as
 * a run adopted after a hot restart. Scopes this process launched are left
 * to their in-memory owners. An unconfirmed stop keeps its record, and the
 * result says so; it is never reported as settled. A record whose manifest
 * cannot be read but whose unit name was built for this owner is reported
 * as pending too: its scope cannot be checked.
 */
export async function terminateInheritedOwnerScopes(input: {
  ownerKinds: readonly ProcessOwnerKind[];
  ownerId: string;
  /** The owner's company, as its launches recorded it. */
  companyId: string | null;
  reason: string;
  graceMs?: number;
  signal?: NodeJS.Signals;
  /** How long to wait for the owner's output relay to drain once its run scopes stopped. */
  relayDrainMs?: number;
}): Promise<OwnerScopeTermination> {
  const registry = currentRegistry();
  const report = emptyReconciliation();
  let listing: ReturnType<typeof listOwnedScopeRecords>;
  try {
    listing = listOwnedScopeRecords(registry.registryDir, registry.instanceId);
  } catch {
    return { found: 0, settled: false, results: [{ unit: "", ownerKind: null, reason: "registry_unreadable" }] };
  }
  const owned = listing.records.filter((record) =>
    input.ownerKinds.includes(record.manifest.owner.kind)
    && record.manifest.owner.id === input.ownerId
    && !isScopeLaunchedByThisProcess(record.ref));
  // Launches record the company or none; either name may be the owner's.
  const unreadable = listing.unreadable.filter((ref) => input.ownerKinds.some((ownerKind) =>
    [input.companyId, null].some((companyId) => isScopeUnitOfOwner(ref.unit, {
      instanceId: registry.instanceId,
      ownerKind,
      ownerId: input.ownerId,
      companyId,
    }))));
  for (const ref of unreadable) report.pending.push({ unit: ref.unit, ownerKind: null, reason: "record_unreadable" });
  await stopRecordsRelaysLast(
    registry,
    owned.map((record) => ({ record, reason: input.reason })),
    report,
    { graceMs: input.graceMs, signal: input.signal, relayDrainMs: input.relayDrainMs },
  );
  return {
    found: owned.length + unreadable.length,
    settled: report.pending.length === 0,
    results: [...report.stopped, ...report.pending],
  };
}

/** Units of the scopes recorded for one run (any origin), for the hot-restart handoff. */
export function listRunScopeUnits(runId: string): string[] {
  const registry = currentRegistry();
  try {
    return listOwnedScopeRecords(registry.registryDir, registry.instanceId).records
      .filter((record) => record.manifest.owner.kind === "run" && record.manifest.owner.id === runId)
      .map((record) => record.manifest.unit);
  } catch {
    return [];
  }
}

/** Whether a unit named by a hot-restart handoff is still recorded for that run. */
export function isRunScopeRecorded(runId: string, unit: string): boolean {
  return listRunScopeUnits(runId).includes(unit);
}

/**
 * The last step of a server shutdown, after the run drain and the
 * application services stopped. Auxiliary helpers and legacy ACP warm
 * providers end with this process in every case. On an ordinary shutdown,
 * run scopes end too, as the drain has already settled what it could, and
 * then their relays once they drained.
 * When runs are handed to the next server (hot restart), their scopes and
 * relays stay for adoption. Native runner scopes follow native restart
 * ownership and managed services their keep-running policy, so neither is
 * touched here.
 */
export async function closeAgentScopesForShutdown(input: {
  handOff: boolean;
  graceMs?: number;
  logger?: ScopeLogger;
}): Promise<AgentScopeReconciliation> {
  const log = input.logger ?? defaultLogger;
  const registry = currentRegistry();
  const report = emptyReconciliation();
  let listing: ReturnType<typeof listOwnedScopeRecords>;
  try {
    listing = listOwnedScopeRecords(registry.registryDir, registry.instanceId);
  } catch (error) {
    log.warn({ err: error }, "agent process scope registry unreadable at shutdown; scopes left for startup reconciliation");
    report.pending.push({ unit: "", ownerKind: null, reason: "registry_unreadable" });
    return report;
  }
  // Their owner is unknown, so whether this shutdown ends them is too.
  for (const ref of listing.unreadable) report.pending.push({ unit: ref.unit, ownerKind: null, reason: "record_unreadable" });
  const ends = (record: ScopeRecord): string | null => {
    const { kind, id } = record.manifest.owner;
    if (kind === "auxiliary") return "server_shutdown_auxiliary";
    if (kind === "warm_provider" && isAcpWarmProviderOwnerId(id)) return "server_shutdown_server_stdio_provider";
    if (!input.handOff && (kind === "run" || kind === "relay")) return "server_shutdown";
    return null;
  };
  const stops: Array<{ record: ScopeRecord; reason: string }> = [];
  for (const record of listing.records) {
    const reason = ends(record);
    if (reason) stops.push({ record, reason });
    else report.kept.push({ unit: record.manifest.unit, ownerKind: record.manifest.owner.kind, reason: "retained_owner" });
  }
  // A relay that has not drained by then stays for startup reconciliation.
  const graceMs = input.graceMs ?? 2_000;
  await stopRecordsRelaysLast(registry, stops, report, { graceMs, relayDrainMs: graceMs, logger: log });
  if (report.stopped.length > 0) log.info({ stopped: report.stopped }, "stopped agent process scopes at shutdown");
  if (report.pending.length > 0) {
    log.warn({ pending: report.pending }, "agent process scope cleanup at shutdown not confirmed; left for startup reconciliation");
  }
  return report;
}
