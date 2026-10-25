import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { StaleContinuationObservedTask } from "./execution-continuation.js";

// Differs from upstream (fork, SX-2550). Who made the task change that left a
// queued wake stale. The issue service writes this entry in the transaction
// that changes the task's status or owner (and so raises its statusVersion),
// when the actor is an agent. The `issue.updated` audit is written after
// commit, so "the latest audit entry" can name an older change; this entry
// cannot. Internal: the activity lists and the audit feed leave it out.
export const TASK_VERSION_CHANGED_BY_AGENT_ACTION = "issue.version_changed_by_agent";

const TERMINAL = new Set(["cancelled", "done"]);
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);

/**
 * True when this agent's own change made the continuation stale. `observed` is
 * the task row the continuation builder rejected. Fails closed (false) when:
 * - the task changed since that decision (other version, status or owner);
 * - the observed version has no entry by this agent, for example a change by a
 *   board user, another agent or the control plane, also while its own audit
 *   is not written yet, or a version raised without a status or owner change;
 * - the entry's change did not cause what made the wake stale: the owner moved
 *   away from this agent in it, or the status became cancelled or done in it.
 *   A wake that was already stale before (for example the board reassigned
 *   it and then this agent edited it) is not this agent's doing.
 * One statement, so the task row and the entry come from the same snapshot.
 */
export async function staleTaskChangedByAgent(db: Db, input: {
  companyId: string;
  agentId: string;
  observed: StaleContinuationObservedTask | null;
}): Promise<boolean> {
  const { observed, agentId } = input;
  if (!observed) return false;
  const rows = await db.execute(sql`
    select a.actor_type, a.actor_id, a.details,
      i.status, i.assignee_agent_id, i.assignee_user_id
    from issues i
    join lateral (
      select actor_type, actor_id, details from activity_log
      where company_id = i.company_id and entity_type = 'issue' and entity_id = i.id::text
        and action = ${TASK_VERSION_CHANGED_BY_AGENT_ACTION}
        and details->>'statusVersion' = i.status_version::text
      order by created_at desc, id desc
      limit 1
    ) a on true
    where i.company_id = ${input.companyId} and i.id = ${observed.issueId}
      and i.status_version = ${observed.statusVersion}
  `);
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row || row.actor_type !== "agent" || row.actor_id !== agentId) return false;
  if (row.status !== observed.status || !same(row.assignee_agent_id, observed.assigneeAgentId)
    || !same(row.assignee_user_id, observed.assigneeUserId)) return false;
  const details = (row.details ?? {}) as Record<string, unknown>;
  if (details.status !== observed.status || !same(details.assigneeAgentId, observed.assigneeAgentId)
    || !same(details.assigneeUserId, observed.assigneeUserId)) return false;
  const ownerStale = observed.assigneeAgentId !== agentId;
  const statusStale = TERMINAL.has(observed.status);
  if (!ownerStale && !statusStale) return false;
  if (ownerStale && details.previousAssigneeAgentId !== agentId) return false;
  if (statusStale && (typeof details.previousStatus !== "string" || TERMINAL.has(details.previousStatus))) return false;
  return true;
}
