import { describe, expect, it, vi } from "vitest";
import {
  runStartupHeartbeatRecoverySteps,
  type StartupHeartbeatRecoveryService,
} from "../startup-heartbeat-recovery.js";

const STEP_NAMES = [
  "promoteDueScheduledRetries",
  "resumeQueuedRuns",
  "recoverPendingSessionGoalActions",
  "recoverActiveSessionGoals",
  "reconcileStrandedAssignedIssues",
  "reconcileResolvedDependencyWakes",
  "reconcileTaskWatchdogs",
  "scanSilentActiveRuns",
  "sweepStaleIssueLocks",
  "sweepEndedTerminalRunLeases",
] as const;

function buildHeartbeat() {
  const calls: string[] = [];
  const results: Record<(typeof STEP_NAMES)[number], unknown> = {
    promoteDueScheduledRetries: { promoted: 0, runIds: [] },
    resumeQueuedRuns: undefined,
    recoverPendingSessionGoalActions: { enqueued: 0, invalid: 0 },
    recoverActiveSessionGoals: { enqueued: 0 },
    reconcileStrandedAssignedIssues: {
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      successfulRunHandoffRetried: 0,
      escalated: 0,
    },
    reconcileResolvedDependencyWakes: { healed: 0 },
    reconcileTaskWatchdogs: { triggered: 0 },
    scanSilentActiveRuns: { created: 0, escalated: 0 },
    sweepStaleIssueLocks: { cleared: 0 },
    sweepEndedTerminalRunLeases: { released: 0 },
  };
  const heartbeat = Object.fromEntries(
    STEP_NAMES.map((name) => [
      name,
      vi.fn(async () => {
        calls.push(name);
        return results[name];
      }),
    ]),
  ) as unknown as Record<(typeof STEP_NAMES)[number], ReturnType<typeof vi.fn>>;
  return { heartbeat, calls };
}

describe("runStartupHeartbeatRecoverySteps", () => {
  it("runs every step in order and logs nothing when all succeed", async () => {
    const { heartbeat, calls } = buildHeartbeat();
    const logger = { warn: vi.fn(), error: vi.fn() };

    await runStartupHeartbeatRecoverySteps(heartbeat as unknown as StartupHeartbeatRecoveryService, logger);

    expect(calls).toEqual([...STEP_NAMES]);
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(STEP_NAMES)("keeps going and resolves when %s throws", async (failing) => {
    const { heartbeat, calls } = buildHeartbeat();
    const err = new Error(`${failing} exploded`);
    heartbeat[failing].mockImplementation(async () => {
      calls.push(failing);
      throw err;
    });
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(
      runStartupHeartbeatRecoverySteps(heartbeat as unknown as StartupHeartbeatRecoveryService, logger),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([...STEP_NAMES]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      { err, step: failing },
      "startup heartbeat recovery step failed",
    );
  });

  it("still logs the assigned-issue summary when the promotion step failed but reconcile changed state", async () => {
    const { heartbeat } = buildHeartbeat();
    heartbeat.promoteDueScheduledRetries.mockRejectedValue(new Error("boom"));
    heartbeat.reconcileStrandedAssignedIssues.mockResolvedValue({
      assignmentDispatched: 2,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      successfulRunHandoffRetried: 0,
      escalated: 0,
    });
    const logger = { warn: vi.fn(), error: vi.fn() };

    await runStartupHeartbeatRecoverySteps(heartbeat as unknown as StartupHeartbeatRecoveryService, logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ promotedScheduledRetries: 0, assignmentDispatched: 2 }),
      "startup heartbeat recovery changed assigned issue state",
    );
  });
});
