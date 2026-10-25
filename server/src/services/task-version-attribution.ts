import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

// Differs from upstream (fork, SX-2550). Who made the task change that left a
// queued wake stale. The issue service writes this entry in the transaction
// that raises the task's statusVersion, when the actor is an agent. The
// `issue.updated` audit is written after commit, so "the latest audit entry"
// can name an older change; this entry cannot.
export const TASK_VERSION_CHANGED_BY_AGENT_ACTION = "issue.version_changed_by_agent";

/**
 * True when the task's current statusVersion was made by this agent and the
 * owner and status are still what that change set. One statement, so the task
 * row and the entry come from the same snapshot. A version made by anyone else
 * (board user, other agent, control plane) has no entry from this agent, also
 * while its own audit is not written yet. A later change that did not raise the
 * version (for example a release that keeps the status) no longer matches the
 * recorded owner or status. Either way the answer is false.
 */
export async function staleTaskChangedByAgent(db: Db, input: {
  companyId: string;
  issueId: string;
  agentId: string;
}): Promise<boolean> {
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
    where i.company_id = ${input.companyId} and i.id = ${input.issueId}
  `);
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row || row.actor_type !== "agent" || row.actor_id !== input.agentId) return false;
  const details = (row.details ?? {}) as Record<string, unknown>;
  return details.status === row.status
    && (details.assigneeAgentId ?? null) === (row.assignee_agent_id ?? null)
    && (details.assigneeUserId ?? null) === (row.assignee_user_id ?? null);
}
