import { agents, authUsers, companyMemberships, issueExecutionDecisions, issues, type Db } from "@paperclipai/db";
import { and, asc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type {
  PluginIssueExecutionDecisionsOptions,
  PluginIssueExecutionDecisionsPage,
  PluginIssueExecutionPrincipalLabel,
} from "@paperclipai/plugin-sdk";
import type { IssueExecutionPolicy, IssueExecutionStagePrincipal, IssueExecutionState } from "@paperclipai/shared";
import { PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { badRequest } from "../errors.js";

const uuid = z.string().uuid();
const optionsSchema = z.object({
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1024).optional(),
});
const cursorSchema = z.object({
  version: z.literal(1),
  companyId: uuid,
  issueId: uuid,
  id: uuid,
  createdAt: z.string().datetime({ precision: 6 }),
}).strict();

function validationError(message: string) {
  return Object.assign(badRequest(message), { code: PLUGIN_RPC_ERROR_CODES.VALIDATION_ERROR });
}

export function issueExecutionHistoryService(db: Db) {
  return {
    async list(
      issueId: string,
      companyId: string,
      options?: PluginIssueExecutionDecisionsOptions,
    ): Promise<PluginIssueExecutionDecisionsPage> {
      const parsed = optionsSchema.safeParse(options ?? {});
      if (!parsed.success) throw validationError("Invalid execution decision history options");
      const { limit, cursor } = parsed.data;
      let after: z.infer<typeof cursorSchema> | undefined;
      if (cursor !== undefined) {
        try {
          const bytes = Buffer.from(cursor, "base64url");
          if (bytes.toString("base64url") !== cursor) throw new Error("Invalid encoding");
          after = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
          if (after.companyId !== companyId.toLowerCase()) throw new Error("Foreign company");
        } catch {
          throw validationError("Invalid execution decision history cursor");
        }
      }

      const empty: PluginIssueExecutionDecisionsPage = { items: [], nextCursor: null, principalLabels: {} };
      if (!uuid.safeParse(companyId).success || typeof issueId !== "string") return empty;
      const isUuid = uuid.safeParse(issueId).success;
      const [issue] = await db.select({
        id: issues.id,
        executionPolicy: issues.executionPolicy,
        executionState: issues.executionState,
      }).from(issues).where(and(
        eq(issues.companyId, companyId),
        isUuid ? eq(issues.id, issueId) : eq(issues.identifier, issueId.toUpperCase()),
      )).limit(1);
      if (!issue) return empty;
      if (after && after.issueId !== issue.id) throw validationError("Invalid execution decision history cursor");

      // Keep Postgres microseconds in the cursor. Date.toISOString() would truncate
      // them and could repeat or skip records at the page boundary.
      const rows = await db.select({
        ...getTableColumns(issueExecutionDecisions),
        cursorTimestamp: sql<string>`to_char(${issueExecutionDecisions.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      }).from(issueExecutionDecisions).where(and(
        eq(issueExecutionDecisions.companyId, companyId),
        eq(issueExecutionDecisions.issueId, issue.id),
        after ? sql`(${issueExecutionDecisions.createdAt}, ${issueExecutionDecisions.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)` : undefined,
      )).orderBy(asc(issueExecutionDecisions.createdAt), asc(issueExecutionDecisions.id)).limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({
        version: 1, companyId: companyId.toLowerCase(), issueId: issue.id, id: last.id, createdAt: last.cursorTimestamp,
      })).toString("base64url") : null;

      const principalLabels: Record<string, PluginIssueExecutionPrincipalLabel> = {};
      const add = (type: "agent" | "user", id?: string | null) => {
        if (id) principalLabels[`${type}:${id}`] = { type, id, label: null };
      };
      const addPrincipal = (principal?: IssueExecutionStagePrincipal | null) => {
        if (principal?.type === "agent") add("agent", principal.agentId);
        if (principal?.type === "user") add("user", principal.userId);
      };
      for (const stage of (issue.executionPolicy as IssueExecutionPolicy | null)?.stages ?? []) {
        for (const principal of stage.participants) addPrincipal(principal);
      }
      const state = issue.executionState as IssueExecutionState | null;
      addPrincipal(state?.currentParticipant);
      addPrincipal(state?.returnAssignee);
      for (const decision of page) {
        add("agent", decision.actorAgentId);
        add("user", decision.actorUserId);
      }
      const principals = Object.values(principalLabels);
      const agentIds = principals.filter(p => p.type === "agent" && uuid.safeParse(p.id).success).map(p => p.id);
      const userIds = principals.filter(p => p.type === "user").map(p => p.id);
      if (agentIds.length) {
        const names = await db.select({ id: agents.id, label: agents.name }).from(agents)
          .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds)));
        for (const name of names) principalLabels[`agent:${name.id}`]!.label = name.label;
      }
      if (userIds.length) {
        const names = await db.select({ id: authUsers.id, label: authUsers.name }).from(companyMemberships)
          .innerJoin(authUsers, eq(authUsers.id, companyMemberships.principalId))
          .where(and(
            eq(companyMemberships.companyId, companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
            inArray(companyMemberships.principalId, userIds),
          ));
        for (const name of names) principalLabels[`user:${name.id}`]!.label = name.label;
      }
      return {
        items: page.map(({ cursorTimestamp: _, ...row }) => ({
          ...row,
          stageType: row.stageType as "review" | "approval",
          outcome: row.outcome as "approved" | "changes_requested",
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        nextCursor,
        principalLabels,
      };
    },
  };
}
