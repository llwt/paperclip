type RecoveryLogger = {
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
};

type StartupRecoveryHeartbeat = {
  promoteDueScheduledRetries: () => Promise<{ promoted: number; runIds: string[] }>;
  resumeQueuedRuns: () => Promise<unknown>;
  recoverPendingSessionGoalActions: () => Promise<{ enqueued: number; invalid: number }>;
  recoverActiveSessionGoals: () => Promise<{ enqueued: number }>;
  reconcileStrandedAssignedIssues: () => Promise<{
    assignmentDispatched: number;
    dispatchRequeued: number;
    continuationRequeued: number;
    successfulRunHandoffEscalated: number;
    successfulRunHandoffRetried: number;
    escalated: number;
  }>;
  reconcileResolvedDependencyWakes: () => Promise<{ healed: number }>;
  reconcileTaskWatchdogs: () => Promise<{ triggered: number }>;
  scanSilentActiveRuns: () => Promise<{ created: number; escalated: number }>;
  sweepStaleIssueLocks: () => Promise<{ cleared: number }>;
  sweepEndedTerminalRunLeases: () => Promise<{ released: number }>;
};

// Each step after the orphan reap is isolated: a step that throws is logged
// with its name and the next step still runs, so one bad row cannot stop the
// server from starting.
export async function runStartupHeartbeatRecoverySteps(
  heartbeat: StartupRecoveryHeartbeat,
  logger: RecoveryLogger,
): Promise<void> {
  async function step<T>(name: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (err) {
      logger.error({ err, step: name }, "startup heartbeat recovery step failed; continuing with the next step");
      return undefined;
    }
  }

  const promotion = await step("promoteDueScheduledRetries", () => heartbeat.promoteDueScheduledRetries());
  await step("resumeQueuedRuns", () => heartbeat.resumeQueuedRuns());

  await step("recoverPendingSessionGoalActions", async () => {
    const recoveredGoalActions = await heartbeat.recoverPendingSessionGoalActions();
    if (recoveredGoalActions.enqueued > 0 || recoveredGoalActions.invalid > 0) {
      logger.warn(
        recoveredGoalActions,
        "startup session-goal action outbox recovery reconciled pending controls",
      );
    }
  });

  await step("recoverActiveSessionGoals", async () => {
    const recoveredGoals = await heartbeat.recoverActiveSessionGoals();
    if (recoveredGoals.enqueued > 0) {
      logger.warn(recoveredGoals, "startup session-goal recovery resumed durable agent goals");
    }
  });

  await step("reconcileStrandedAssignedIssues", async () => {
    const reconciled = await heartbeat.reconcileStrandedAssignedIssues();
    if (
      (promotion?.promoted ?? 0) > 0 ||
      reconciled.assignmentDispatched > 0 ||
      reconciled.dispatchRequeued > 0 ||
      reconciled.continuationRequeued > 0 ||
      reconciled.successfulRunHandoffEscalated > 0 ||
      reconciled.successfulRunHandoffRetried > 0 ||
      reconciled.escalated > 0
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
  });

  await step("reconcileResolvedDependencyWakes", async () => {
    const dependencyWakesReconciled = await heartbeat.reconcileResolvedDependencyWakes();
    if (dependencyWakesReconciled.healed > 0) {
      logger.warn(
        { ...dependencyWakesReconciled },
        "startup dependency-wake reconciliation restored task execution paths",
      );
    }
  });

  await step("reconcileTaskWatchdogs", async () => {
    const taskWatchdogsReconciled = await heartbeat.reconcileTaskWatchdogs();
    if (taskWatchdogsReconciled.triggered > 0) {
      logger.warn(
        { ...taskWatchdogsReconciled },
        "startup task-watchdog reconciliation triggered watchdog work",
      );
    }
  });

  await step("scanSilentActiveRuns", async () => {
    const scanned = await heartbeat.scanSilentActiveRuns();
    if (scanned.created > 0 || scanned.escalated > 0) {
      logger.warn({ ...scanned }, "startup active-run output watchdog created review work");
    }
  });

  await step("sweepStaleIssueLocks", async () => {
    const swept = await heartbeat.sweepStaleIssueLocks();
    if (swept.cleared > 0) {
      logger.warn({ ...swept }, "startup stale-lock sweeper cleared issue locks");
    }
  });

  await step("sweepEndedTerminalRunLeases", async () => {
    const healed = await heartbeat.sweepEndedTerminalRunLeases();
    if (healed.released > 0) {
      logger.warn({ ...healed }, "startup sweep released environment leases of ended terminal runs");
    }
  });
}
