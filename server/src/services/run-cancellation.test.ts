import { describe, expect, it } from "vitest";
import { cancellationResultJson, canContinueCancelledRun, isUnexpectedRunCancellation, requestedRunCancellation } from "./run-cancellation.js";

describe("cancellation provenance", () => {
  const run = { status: "cancelled", runtimeMode: "legacy" as const, startedAt: new Date(0), finishedAt: new Date(1),
    error: "Cancelled", errorCode: "cancelled", resultJson: null };
  it("preserves operator intent over adapter completion metadata", () => {
    const cancellation = requestedRunCancellation({ cancelledByUserId: "board", cancelledByActorType: "user" }, "Stop");
    const resultJson = cancellationResultJson({ ...run, resultJson: { cancellation } }, "cancelled", { status: "cancelled" });
    expect(resultJson?.cancellation).toEqual(cancellation);
    expect(isUnexpectedRunCancellation({ ...run, resultJson })).toBe(false);
    expect(canContinueCancelledRun({ ...run, resultJson })).toBe(false);
  });
  it("records queue interruption and shutdown as expected system actions", () => {
    expect(requestedRunCancellation({ queuedCommentInterruptQueueId: "queue", cancelledByUserId: "board" }, "Send messages"))
      .toMatchObject({ source: "queued_message", expected: true, initiator: { type: "user", id: "board" } });
    expect(cancellationResultJson(run, "interrupted", {}, "server_shutdown_interrupted")?.cancellation)
      .toMatchObject({ source: "shutdown", expected: true });
    expect(requestedRunCancellation({ queuedCommentInterruptQueueId: "queue", interruptedByActorType: "user", interruptedByActorId: "board" }, "Send messages"))
      .toMatchObject({ source: "queued_message", initiator: { type: "user", id: "board" } });
  });
  it("requires positive provider evidence and a complete empty tool inventory for saved input", () => {
    const resultJson = cancellationResultJson(run, "cancelled", { status: "cancelled", acpToolInventoryComplete: true, acpPendingToolCount: 0 });
    expect(resultJson?.cancellation).toMatchObject({ source: "provider", expected: false });
    expect(canContinueCancelledRun({ ...run, resultJson })).toBe(true);
    expect(canContinueCancelledRun({ ...run, resultJson: { ...resultJson, acpPendingToolCount: 1 } })).toBe(false);
    expect(canContinueCancelledRun({ ...run, resultJson: { ...resultJson, acpToolInventoryComplete: false } })).toBe(false);
    expect(canContinueCancelledRun({ ...run, resultJson: {} })).toBe(false);
    expect(isUnexpectedRunCancellation(run)).toBe(true);
    expect(isUnexpectedRunCancellation({ ...run, resultJson: {
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
    } })).toBe(false);
  });
  it("labels a lease-lost cancel control_plane with its own description, never unknown", () => {
    const resultJson = cancellationResultJson({ ...run, error: "Legacy controller lease lost" }, "cancelled", {}, "legacy_controller_lease_lost");
    expect(resultJson?.cancellation).toMatchObject({ source: "control_plane", expected: false, initiator: { type: "system" },
      reason: "Legacy controller lease lost" });
    expect(isUnexpectedRunCancellation({ ...run, resultJson })).toBe(true);
    expect(canContinueCancelledRun({ ...run, resultJson })).toBe(false);
    // An ACP provider that honoured the abort does not turn it into a provider cancel.
    const honoured = cancellationResultJson(run, "cancelled", { status: "cancelled" }, "legacy_controller_lease_lost");
    expect(honoured?.cancellation).toMatchObject({ source: "control_plane", initiator: { type: "system" } });
    expect(canContinueCancelledRun({ ...run, resultJson: { ...honoured,
      acpToolInventoryComplete: true, acpPendingToolCount: 0 } })).toBe(false);
  });
});
