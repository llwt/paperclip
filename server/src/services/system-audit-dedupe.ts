// The health sweep re-checks each connection about every 15 minutes and reads its
// credentials with no run id. One audit row per hour per connection and config path
// still shows the credential is in use, without a row per sweep.
export const TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS = 60 * 60_000;

export function systemAuditDedupe(
  actor: { actorType?: string | null } | undefined,
  heartbeatRunId?: string | null,
): { auditDedupeWindowMs?: number } {
  return (actor?.actorType ?? "system") === "system" && !heartbeatRunId
    ? { auditDedupeWindowMs: TOOL_CONNECTION_SYSTEM_AUDIT_WINDOW_MS }
    : {};
}
