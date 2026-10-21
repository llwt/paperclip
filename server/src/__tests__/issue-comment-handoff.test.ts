import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  approvals,
  companies,
  createDb,
  issueApprovals,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  buildAgentMentionHref,
  issueCommentMetadataSchema,
  parseLeadingAgentMention,
} from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildHandoffReceipt,
  decideCommentHandoff,
  isHandoffTargetAssignable,
  issueLifecycleOwner,
  readCommentHandoffGates,
  recheckCommentHandoff,
  toHandoffCandidate,
  type CommentHandoffDeps,
  type HandoffActor,
  type HandoffDecision,
  type HandoffGateFacts,
  type HandoffIssueState,
} from "../services/issue-comment-handoff.ts";

const COMPANY = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-0000000000a1";
const TARGET = "aaaaaaaa-0000-4000-8000-0000000000b2";
const OTHER = "aaaaaaaa-0000-4000-8000-0000000000c3";
const RUN = "aaaaaaaa-0000-4000-8000-0000000000d4";
const tx = {} as never;

const noGates: HandoffGateFacts = {
  pendingStage: false,
  pendingConfirmation: false,
  pendingInteraction: false,
  pendingApproval: false,
  recoveryHold: false,
  pauseHold: false,
};

function issueState(overrides: Partial<HandoffIssueState> = {}): HandoffIssueState {
  return {
    issueId: "aaaaaaaa-0000-4000-8000-0000000000e5",
    companyId: COMPANY,
    assigneeAgentId: OWNER,
    assigneeUserId: null,
    status: "in_progress",
    statusVersion: 3,
    executionRunId: null,
    executionState: null,
    conversationAgentId: null,
    lifecycleOwner: null,
    ...overrides,
  };
}

const board: HandoffActor = { actorType: "user", actorId: "user-board", agentId: null, runId: null };
const owner: HandoffActor = { actorType: "agent", actorId: OWNER, agentId: OWNER, runId: RUN };
const otherAgent: HandoffActor = { actorType: "agent", actorId: OTHER, agentId: OTHER, runId: null };

function deps(overrides: { assignable?: boolean; gates?: Partial<HandoffGateFacts> } = {}): CommentHandoffDeps {
  return {
    isTargetAssignable: async () => overrides.assignable ?? true,
    readGates: async () => ({ ...noGates, ...overrides.gates }),
  };
}

async function decide(
  options: {
    body?: string;
    issue?: Partial<HandoffIssueState>;
    actor?: HandoffActor;
    explicitMutation?: boolean;
    canAssign?: boolean;
    assignable?: boolean;
    gates?: Partial<HandoffGateFacts>;
  } = {},
): Promise<HandoffDecision> {
  const body = options.body ?? `[@Target](${buildAgentMentionHref(TARGET)}) please take this`;
  return decideCommentHandoff(
    tx,
    {
      companyId: COMPANY,
      issue: issueState(options.issue),
      actor: options.actor ?? board,
      candidate: toHandoffCandidate(parseLeadingAgentMention(body)),
      explicitMutation: options.explicitMutation ?? false,
      canAssign: async () => options.canAssign ?? true,
    },
    deps({ assignable: options.assignable, gates: options.gates }),
  );
}

describe("decideCommentHandoff", () => {
  it("assigns for the board from in_progress and todo", async () => {
    expect(await decide()).toEqual({ outcome: "assigned", targetAgentId: TARGET });
    expect(await decide({ issue: { status: "todo" } })).toEqual({ outcome: "assigned", targetAgentId: TARGET });
  });

  it("assigns for the current agent assignee", async () => {
    expect(await decide({ actor: owner })).toEqual({ outcome: "assigned", targetAgentId: TARGET });
  });

  it("is unchanged with no leading candidate", async () => {
    expect(await decide({ body: `Context first [@Target](${buildAgentMentionHref(TARGET)})` })).toEqual({ outcome: "unchanged" });
    expect(await decide({ body: "plain text" })).toEqual({ outcome: "unchanged" });
  });

  it("is unchanged when the target already owns the issue", async () => {
    expect(await decide({ issue: { assigneeAgentId: TARGET } })).toEqual({ outcome: "unchanged" });
  });

  it("refuses an ambiguous prefix without naming a target", async () => {
    const body = `[@Target](${buildAgentMentionHref(TARGET)}) [@Other](${buildAgentMentionHref(OTHER)}) go`;
    expect(await decide({ body })).toEqual({ outcome: "context_only", reasonCode: "ambiguous_prefix", targetAgentId: null });
  });

  it("refuses when PATCH carries an explicit workflow mutation", async () => {
    expect(await decide({ explicitMutation: true })).toMatchObject({ outcome: "context_only", reasonCode: "explicit_mutation" });
  });

  it.each([
    ["another agent", otherAgent],
    ["an agent acting on behalf of a user", { ...otherAgent, actorId: "user-board" }],
  ])("refuses %s that is not the assignee", async (_name, actor) => {
    expect(await decide({ actor })).toEqual({ outcome: "context_only", reasonCode: "author_not_assignee", targetAgentId: null });
  });

  it("refuses the former assignee once ownership moved", async () => {
    expect(await decide({ actor: owner, issue: { assigneeAgentId: OTHER } })).toMatchObject({ reasonCode: "author_not_assignee" });
  });

  it("refuses an agent when a user owns the issue", async () => {
    expect(await decide({ actor: owner, issue: { assigneeAgentId: null, assigneeUserId: "user-board" } })).toMatchObject({
      reasonCode: "author_not_assignee",
    });
  });

  it("refuses an unknown, foreign or ineligible target without echoing its id", async () => {
    expect(await decide({ assignable: false })).toEqual({ outcome: "context_only", reasonCode: "target_unavailable", targetAgentId: null });
  });

  it("refuses a company mismatch between the issue and the request", async () => {
    expect(await decide({ issue: { companyId: "bbbbbbbb-0000-4000-8000-000000000001" } })).toMatchObject({
      reasonCode: "target_unavailable",
      targetAgentId: null,
    });
  });

  it.each(["backlog", "blocked", "in_review", "done", "cancelled"] as const)("refuses from %s", async (status) => {
    expect(await decide({ issue: { status } })).toEqual({
      outcome: "context_only",
      reasonCode: "status_requires_explicit_action",
      targetAgentId: TARGET,
    });
  });

  it.each([
    ["Agent Chat", { conversationAgentId: OWNER }],
    ["plugin lifecycle", { lifecycleOwner: "plugin:acme:operation" }],
  ])("refuses a %s issue", async (_name, issue) => {
    expect(await decide({ issue })).toMatchObject({ reasonCode: "lifecycle_owned" });
  });

  it.each([
    ["pause hold", { pauseHold: true }, "lifecycle_owned"],
    ["recovery hold", { recoveryHold: true }, "lifecycle_owned"],
    ["pending stage", { pendingStage: true }, "review_pending"],
    ["pending confirmation", { pendingConfirmation: true }, "confirmation_pending"],
    ["pending question", { pendingInteraction: true }, "interaction_pending"],
    ["pending approval", { pendingApproval: true }, "interaction_pending"],
  ] as const)("refuses with a %s", async (_name, gates, reasonCode) => {
    expect(await decide({ gates })).toEqual({ outcome: "context_only", reasonCode, targetAgentId: TARGET });
  });

  it("refuses when tasks:assign denies the destination", async () => {
    expect(await decide({ canAssign: false })).toMatchObject({ reasonCode: "assignment_not_allowed" });
  });

  it("does not read gates or permissions for a refused author", async () => {
    let calls = 0;
    const decision = await decideCommentHandoff(
      tx,
      {
        companyId: COMPANY,
        issue: issueState(),
        actor: otherAgent,
        candidate: { targetAgentId: TARGET },
        explicitMutation: false,
        canAssign: async () => { calls += 1; return true; },
      },
      {
        isTargetAssignable: async () => { calls += 1; return true; },
        readGates: async () => { calls += 1; return noGates; },
      },
    );
    expect(decision).toMatchObject({ reasonCode: "author_not_assignee" });
    expect(calls).toBe(0);
  });
});

describe("recheckCommentHandoff", () => {
  const assigned: HandoffDecision = { outcome: "assigned", targetAgentId: TARGET };

  it("keeps an unchanged assignment", () => {
    expect(recheckCommentHandoff(assigned, assigned)).toEqual(assigned);
  });

  it("turns any change under the lock into state_changed", () => {
    for (const locked of [
      { outcome: "context_only", reasonCode: "confirmation_pending", targetAgentId: TARGET },
      { outcome: "assigned", targetAgentId: OTHER },
      { outcome: "unchanged" },
    ] as HandoffDecision[]) {
      expect(recheckCommentHandoff(assigned, locked)).toEqual({
        outcome: "context_only",
        reasonCode: "state_changed",
        targetAgentId: TARGET,
      });
    }
  });

  it("never upgrades a preflight refusal", () => {
    const refused: HandoffDecision = { outcome: "context_only", reasonCode: "review_pending", targetAgentId: TARGET };
    expect(recheckCommentHandoff(refused, assigned)).toEqual(refused);
  });
});

describe("buildHandoffReceipt", () => {
  it("builds a valid assigned receipt with the stopped run", () => {
    const { metadata, summary } = buildHandoffReceipt({
      decision: { outcome: "assigned", targetAgentId: TARGET },
      committed: { statusVersion: 4, interruptedRunId: RUN },
    });
    expect(issueCommentMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(metadata.handoff).toEqual({ version: 1, outcome: "assigned", targetAgentId: TARGET, statusVersion: 4, interruptedRunId: RUN });
    expect(summary).toMatch(/Stopped the current run/);
  });

  it("requires the committed assignment for success", () => {
    expect(() => buildHandoffReceipt({ decision: { outcome: "assigned", targetAgentId: TARGET } })).toThrow();
  });

  it("explains a refusal in plain words", () => {
    const { metadata, summary } = buildHandoffReceipt({
      decision: { outcome: "context_only", reasonCode: "confirmation_pending", targetAgentId: TARGET },
    });
    expect(issueCommentMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(summary).toBe("Comment saved. No handoff: a confirmation is waiting on this task.");
    expect(metadata.sections[0]?.rows[0]).toEqual({ type: "text", text: summary });
  });

  it("omits the target when it was not resolved", () => {
    const { metadata } = buildHandoffReceipt({
      decision: { outcome: "context_only", reasonCode: "target_unavailable", targetAgentId: null },
    });
    expect(metadata.handoff).toEqual({ version: 1, outcome: "context_only", reasonCode: "target_unavailable" });
  });

  it("builds a valid unchanged receipt", () => {
    const { metadata } = buildHandoffReceipt({ decision: { outcome: "unchanged" } });
    expect(issueCommentMetadataSchema.parse(metadata).handoff).toEqual({ version: 1, outcome: "unchanged" });
  });
});

describe("issueLifecycleOwner", () => {
  it("marks plugin-created issues only", () => {
    expect(issueLifecycleOwner({ originKind: "plugin:acme:operation" })).toBe("plugin:acme:operation");
    expect(issueLifecycleOwner({ originKind: "manual" })).toBeNull();
    expect(issueLifecycleOwner({ originKind: null })).toBeNull();
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres comment handoff gate tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("comment handoff gate reads", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-handoff-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const ids = { active: randomUUID(), terminated: randomUUID(), pending: randomUUID(), foreign: randomUUID() };
    await db.insert(companies).values([
      { id: companyId, name: "Handoff", issuePrefix: `H${companyId.slice(0, 6).toUpperCase()}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 6).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: ids.active, companyId, name: "Active", role: "engineer", status: "idle", adapterType: "codex_local" },
      { id: ids.terminated, companyId, name: "Gone", role: "engineer", status: "terminated", adapterType: "codex_local" },
      { id: ids.pending, companyId, name: "New", role: "engineer", status: "pending_approval", adapterType: "codex_local" },
      { id: ids.foreign, companyId: otherCompanyId, name: "Foreign", role: "engineer", status: "idle", adapterType: "codex_local" },
    ]);
    const [issue] = await db.insert(issues).values({ companyId, title: "Handoff gates", status: "in_progress" }).returning();
    return { companyId, otherCompanyId, ids, issue: issue! };
  }

  it("resolves only assignable same-company targets", async () => {
    const { companyId, ids } = await seed();
    expect(await isHandoffTargetAssignable(db, companyId, ids.active)).toBe(true);
    expect(await isHandoffTargetAssignable(db, companyId, ids.terminated)).toBe(false);
    expect(await isHandoffTargetAssignable(db, companyId, ids.pending)).toBe(false);
    expect(await isHandoffTargetAssignable(db, companyId, ids.foreign)).toBe(false);
    expect(await isHandoffTargetAssignable(db, companyId, randomUUID())).toBe(false);
  });

  it("reports no gates on a clean issue", async () => {
    const { companyId, issue } = await seed();
    expect(await readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState: null })).toEqual(noGates);
  });

  it("separates pending confirmations from other pending interactions", async () => {
    const { companyId, issue } = await seed();
    const base = { companyId, issueId: issue.id, payload: {} as never };
    await db.insert(issueThreadInteractions).values({ ...base, kind: "request_confirmation" });
    let gates = await readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState: null });
    expect(gates).toMatchObject({ pendingConfirmation: true, pendingInteraction: false });

    await db.delete(issueThreadInteractions);
    await db.insert(issueThreadInteractions).values([
      { ...base, kind: "ask_user_questions" },
      { ...base, kind: "request_confirmation", status: "accepted" },
    ]);
    gates = await readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState: null });
    expect(gates).toMatchObject({ pendingConfirmation: false, pendingInteraction: true });
  });

  it("ignores another company's interactions on the same issue id", async () => {
    const { companyId, otherCompanyId, issue } = await seed();
    await db.insert(issueThreadInteractions).values({ companyId, issueId: issue.id, kind: "request_confirmation", payload: {} as never });
    const gates = await readCommentHandoffGates(db, { companyId: otherCompanyId, issueId: issue.id, executionState: null });
    expect(gates.pendingConfirmation).toBe(false);
  });

  it("sees a linked pending approval but not a decided one", async () => {
    const { companyId, issue } = await seed();
    const [pending] = await db.insert(approvals).values({ companyId, type: "hire_agent", payload: {} }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId: issue.id, approvalId: pending!.id });
    expect((await readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState: null })).pendingApproval).toBe(true);

    await db.update(approvals).set({ status: "approved" });
    expect((await readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState: null })).pendingApproval).toBe(false);
  });

  it("sees an active execution recovery hold", async () => {
    const { companyId, issue } = await seed();
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issue.id,
      kind: "execution_reconciliation",
      cause: "uncertain_provider_action",
      fingerprint: `fp-${issue.id}`,
      nextAction: "reconcile",
    });
    expect((await readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState: null })).recoveryHold).toBe(true);
  });

  it("treats a pending or unreadable execution state as a pending stage", async () => {
    const { companyId, issue } = await seed();
    const read = (executionState: unknown) => readCommentHandoffGates(db, { companyId, issueId: issue.id, executionState });
    const idle = {
      status: "completed",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    expect((await read(idle)).pendingStage).toBe(false);
    expect((await read({
      ...idle,
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: randomUUID() },
    })).pendingStage).toBe(true);
    expect((await read({ broken: true })).pendingStage).toBe(true);
  });
});
