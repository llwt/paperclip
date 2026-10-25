import type { heartbeatService } from "./services/index.js";

type HeartbeatService = ReturnType<typeof heartbeatService>;

export type StartupHeartbeatRecoveryService = Pick<
  HeartbeatService,
  | "promoteDueScheduledRetries"
  | "resumeQueuedRuns"
  | "recoverPendingSessionGoalActions"
  | "recoverActiveSessionGoals"
  | "reconcileStrandedAssignedIssues"
  | "reconcileResolvedDependencyWakes"
  | "reconcileTaskWatchdogs"
  | "scanSilentActiveRuns"
  | "sweepStaleIssueLocks"
  | "sweepEndedTerminalRunLeases"
>;

export interface StartupHeartbeatRecoveryLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

// Fork (SX-2485): each step runs on its own. One failed step logs and the
// next ones still run, so a single bad row cannot keep the server from starting.
export async function runStartupHeartbeatRecoverySteps(
  heartbeat: StartupHeartbeatRecoveryService,
  logger: StartupHeartbeatRecoveryLogger,
): Promise<void> {
  async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (err) {
      logger.error({ err, step: name }, "startup heartbeat recovery step failed");
      return null;
    }
  }

  const promotion = await step("promoteDueScheduledRetries", () => heartbeat.promoteDueScheduledRetries());
  await step("resumeQueuedRuns", () => heartbeat.resumeQueuedRuns());

  const recoveredGoalActions = await step("recoverPendingSessionGoalActions", () =>
    heartbeat.recoverPendingSessionGoalActions(),
  );
  if (recoveredGoalActions && (recoveredGoalActions.enqueued > 0 || recoveredGoalActions.invalid > 0)) {
    logger.warn(
      recoveredGoalActions,
      "startup session-goal action outbox recovery reconciled pending controls",
    );
  }

  const recoveredGoals = await step("recoverActiveSessionGoals", () => heartbeat.recoverActiveSessionGoals());
  if (recoveredGoals && recoveredGoals.enqueued > 0) {
    logger.warn(recoveredGoals, "startup session-goal recovery resumed durable agent goals");
  }

  const reconciled = await step("reconcileStrandedAssignedIssues", () =>
    heartbeat.reconcileStrandedAssignedIssues(),
  );
  if (
    (promotion && promotion.promoted > 0) ||
    (reconciled &&
      (reconciled.assignmentDispatched > 0 ||
        reconciled.dispatchRequeued > 0 ||
        reconciled.continuationRequeued > 0 ||
        reconciled.successfulRunHandoffEscalated > 0 ||
        reconciled.successfulRunHandoffRetried > 0 ||
        reconciled.escalated > 0))
  ) {
    logger.warn(
      {
        promotedScheduledRetries: promotion?.promoted ?? 0,
        promotedScheduledRetryRunIds: promotion?.runIds ?? [],
        ...reconciled,
      },
      "startup heartbeat recovery changed assigned issue state",
    );
  }

  const dependencyWakesReconciled = await step("reconcileResolvedDependencyWakes", () =>
    heartbeat.reconcileResolvedDependencyWakes(),
  );
  if (dependencyWakesReconciled && dependencyWakesReconciled.healed > 0) {
    logger.warn(
      { ...dependencyWakesReconciled },
      "startup dependency-wake reconciliation restored task execution paths",
    );
  }

  const taskWatchdogsReconciled = await step("reconcileTaskWatchdogs", () => heartbeat.reconcileTaskWatchdogs());
  if (taskWatchdogsReconciled && taskWatchdogsReconciled.triggered > 0) {
    logger.warn(
      { ...taskWatchdogsReconciled },
      "startup task-watchdog reconciliation triggered watchdog work",
    );
  }

  const scanned = await step("scanSilentActiveRuns", () => heartbeat.scanSilentActiveRuns());
  if (scanned && (scanned.created > 0 || scanned.escalated > 0)) {
    logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
  }

  const swept = await step("sweepStaleIssueLocks", () => heartbeat.sweepStaleIssueLocks());
  if (swept && swept.cleared > 0) {
    logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
  }

  const healed = await step("sweepEndedTerminalRunLeases", () => heartbeat.sweepEndedTerminalRunLeases());
  if (healed && healed.released > 0) {
    logger.warn({ ...healed }, "startup sweep released environment leases of ended terminal runs");
  }
}
