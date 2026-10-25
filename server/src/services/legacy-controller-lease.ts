import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// A boot UUID has meaning across containers; a numeric PID does not.
export const legacyControllerBootId = randomUUID();
export const LEGACY_CONTROLLER_LEASE_MS = 60_000;
export const LEGACY_CONTROLLER_RENEW_MS = 10_000;
/** Bound on the last renewal attempt when the lease deadline timer fires. */
export const LEGACY_CONTROLLER_DEADLINE_RENEW_MS = 10_000;
export const LEGACY_CONTROLLER_LEASE_LOST_CODE = "legacy_controller_lease_lost";

/** Abort reason when another controller revoked this run or it stopped running. */
export class LegacyControllerLeaseLostError extends Error {
  readonly code = LEGACY_CONTROLLER_LEASE_LOST_CODE;
  constructor() { super("Legacy controller lease lost"); this.name = "LegacyControllerLeaseLostError"; }
}

export function isLegacyControllerLeaseLost(reason: unknown): reason is LegacyControllerLeaseLostError {
  return reason instanceof LegacyControllerLeaseLostError;
}

type Run = typeof heartbeatRuns.$inferSelect;

/** Commit these fields in the same UPDATE that claims a queued run. */
export function legacyControllerClaim(runtimeMode: string) {
  if (runtimeMode === "native") return {};
  return {
    controllerBootId: legacyControllerBootId,
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    executionStage: "preparing",
  };
}

/** A late renewal is not a lost lease. Revocation replaces the boot id on the
 * same row, so a matching boot id on a running row proves nobody took it.
 * Differs from upstream (master `50797ea03`), which also requires an unexpired
 * lease, so an event-loop stall past the lease aborts every live run (SX-2390). */
export async function renewLegacyControllerLease(
  db: Db,
  run: Pick<Run, "id" | "companyId" | "controllerBootId">,
  stage?: "dispatching",
): Promise<boolean> {
  const [renewed] = await db.update(heartbeatRuns).set({
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
    ...(stage ? { executionStage: stage } : {}),
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.runtimeMode, "legacy"), eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, legacyControllerBootId),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(renewed);
}

export async function hasLiveLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return false;
  const [owner] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    gt(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  ));
  return Boolean(owner);
}

/** Atomically revoke an expired controller. Renewal and revocation serialize on
 * the run row. Expiry permits cleanup, never dispatch of a replacement agent. */
export async function revokeExpiredLegacyController(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode === "native" || !run.controllerBootId) return true;
  const [revoked] = await db.update(heartbeatRuns).set({
    controllerBootId: randomUUID(),
    controllerLeaseExpiresAt: sql`clock_timestamp() + interval '60 seconds'`,
  }).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
    eq(heartbeatRuns.status, "running"),
    eq(heartbeatRuns.controllerBootId, run.controllerBootId),
    lte(heartbeatRuns.controllerLeaseExpiresAt, sql`clock_timestamp()`),
  )).returning({ id: heartbeatRuns.id });
  return Boolean(revoked);
}

/** Abort the adapter only when the lease is revoked or the row stopped running.
 * When the deadline passes (for example after an event-loop stall), try one
 * bounded renewal first; a renewal that does not settle in time counts as lost. */
export function watchLegacyControllerLease(db: Db, run: Run, controller: AbortController) {
  if (run.runtimeMode === "native" || !run.controllerBootId) {
    return { stop() {}, async assertOwned(_stage?: "dispatching") {} };
  }
  let stopped = false;
  let pending = false;
  const lost = () => {
    if (stopped || controller.signal.aborted) return;
    const reason = new LegacyControllerLeaseLostError();
    logger.warn({ runId: run.id, reason: reason.message }, "legacy controller lease lost; aborting run");
    controller.abort(reason);
  };
  let deadline!: ReturnType<typeof setTimeout>;
  const armDeadline = (ms: number) => {
    clearTimeout(deadline);
    deadline = setTimeout(onDeadline, Math.max(0, ms));
    deadline.unref();
  };
  const onDeadline = () => {
    if (stopped) return;
    const startedAt = Date.now();
    let bound!: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<boolean>(resolve => {
      bound = setTimeout(() => resolve(false), LEGACY_CONTROLLER_DEADLINE_RENEW_MS);
      bound.unref();
    });
    void Promise.race([renewLegacyControllerLease(db, run), timedOut])
      .catch(() => false)
      .then(renewed => {
        clearTimeout(bound);
        if (stopped) return;
        if (!renewed) return lost();
        armDeadline(LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt));
      });
  };
  armDeadline((run.controllerLeaseExpiresAt?.getTime() ?? 0) - Date.now());
  const assertOwned = async (stage?: "dispatching") => {
    if (stopped) return;
    controller.signal.throwIfAborted();
    const startedAt = Date.now();
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let renewed: boolean;
    try {
      renewed = await Promise.race([renewLegacyControllerLease(db, run, stage), aborted]);
    } finally {
      controller.signal.removeEventListener("abort", onAbort);
    }
    if (stopped) return;
    if (!renewed) {
      lost();
      controller.signal.throwIfAborted();
    }
    controller.signal.throwIfAborted();
    if (!stopped) armDeadline(LEGACY_CONTROLLER_LEASE_MS - (Date.now() - startedAt));
  };
  const timer = setInterval(() => {
    if (pending || stopped) return;
    pending = true;
    void assertOwned().catch(lost).finally(() => { pending = false; });
  }, LEGACY_CONTROLLER_RENEW_MS);
  timer.unref();
  return { assertOwned, stop() { stopped = true; clearInterval(timer); clearTimeout(deadline); } };
}

/** Ownership check for a run that is already terminal. `hasLiveLegacyController`
 * only matches a running row, so it cannot protect a controller that still
 * finalizes a terminal run. A missing row or an unreadable expiry stays held. */
export async function terminalLegacyControllerMayOwn(
  db: Db,
  run: Pick<Run, "id" | "companyId">,
): Promise<boolean> {
  const [row] = await db.select({
    controllerBootId: heartbeatRuns.controllerBootId,
    expired: sql<boolean | null>`${heartbeatRuns.controllerLeaseExpiresAt} <= clock_timestamp()`,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId),
  ));
  if (!row) return true;
  if (!row.controllerBootId) return false;
  return row.expired !== true;
}
