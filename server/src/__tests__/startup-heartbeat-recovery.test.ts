import { describe, expect, it, vi } from "vitest";
import { runStartupHeartbeatRecoverySteps } from "../startup-heartbeat-recovery.js";

function heartbeat() {
  return {
    promoteDueScheduledRetries: vi.fn(async () => ({ promoted: 0, runIds: [] as string[] })),
    resumeQueuedRuns: vi.fn(async () => undefined),
    recoverPendingSessionGoalActions: vi.fn(async () => ({ enqueued: 0, invalid: 0 })),
    recoverActiveSessionGoals: vi.fn(async () => ({ enqueued: 0 })),
    reconcileStrandedAssignedIssues: vi.fn(async () => ({
      assignmentDispatched: 0,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      successfulRunHandoffRetried: 0,
      escalated: 0,
    })),
    reconcileResolvedDependencyWakes: vi.fn(async () => ({ healed: 0 })),
    reconcileTaskWatchdogs: vi.fn(async () => ({ triggered: 0 })),
    scanSilentActiveRuns: vi.fn(async () => ({ created: 0, escalated: 0 })),
    sweepStaleIssueLocks: vi.fn(async () => ({ cleared: 0 })),
    sweepEndedTerminalRunLeases: vi.fn(async () => ({ released: 0 })),
  };
}

describe("runStartupHeartbeatRecoverySteps", () => {
  it("runs every step in order when none fail", async () => {
    const hb = heartbeat();
    const logger = { warn: vi.fn(), error: vi.fn() };
    await runStartupHeartbeatRecoverySteps(hb, logger);
    for (const fn of Object.values(hb)) expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each(Object.keys(heartbeat()) as Array<keyof ReturnType<typeof heartbeat>>)(
    "logs the step name and runs the later steps when %s throws",
    async (failing) => {
      const hb = heartbeat();
      const boom = new Error("boom");
      (hb[failing] as ReturnType<typeof vi.fn>).mockRejectedValue(boom);
      const logger = { warn: vi.fn(), error: vi.fn() };

      await expect(runStartupHeartbeatRecoverySteps(hb, logger)).resolves.toBeUndefined();

      for (const fn of Object.values(hb)) expect(fn).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: boom, step: failing }),
        expect.any(String),
      );
    },
  );

  it("keeps reporting reconciled state when the retry promotion step failed", async () => {
    const hb = heartbeat();
    hb.promoteDueScheduledRetries.mockRejectedValue(new Error("boom"));
    hb.reconcileStrandedAssignedIssues.mockResolvedValue({
      assignmentDispatched: 1,
      dispatchRequeued: 0,
      continuationRequeued: 0,
      successfulRunHandoffEscalated: 0,
      successfulRunHandoffRetried: 0,
      escalated: 0,
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    await runStartupHeartbeatRecoverySteps(hb, logger);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentDispatched: 1, promotedScheduledRetries: 0 }),
      "startup heartbeat recovery changed assigned issue state",
    );
  });
});
