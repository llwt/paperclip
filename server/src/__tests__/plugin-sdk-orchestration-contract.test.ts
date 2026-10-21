import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Issue, PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-orchestration",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test Orchestration",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

function issue(input: Partial<Issue> & Pick<Issue, "id" | "companyId" | "title">): Issue {
  const now = new Date();
  return {
    id: input.id,
    companyId: input.companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

describe("plugin SDK orchestration contract", () => {
  it("supports expanded issue create fields and relation helpers", async () => {
    const companyId = randomUUID();
    const blockerIssueId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.create", "issue.relations.read", "issue.relations.write", "issue.subtree.read"]),
    });
    harness.seed({
      issues: [issue({ id: blockerIssueId, companyId, title: "Blocker" })],
    });

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Generated issue",
      status: "todo",
      assigneeUserId: "board-user",
      billingCode: "mission:alpha",
      originId: "mission-alpha",
      blockedByIssueIds: [blockerIssueId],
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration");
    expect(created.originId).toBe("mission-alpha");
    expect(created.billingCode).toBe("mission:alpha");
    expect(created.assigneeUserId).toBe("board-user");

    await expect(harness.ctx.issues.relations.get(created.id, companyId)).resolves.toEqual({
      blockedBy: [
        expect.objectContaining({
          id: blockerIssueId,
          title: "Blocker",
        }),
      ],
      blocks: [],
    });

    await expect(harness.ctx.issues.relations.removeBlockers(created.id, [blockerIssueId], companyId)).resolves.toEqual({
      blockedBy: [],
      blocks: [],
    });

    await expect(harness.ctx.issues.relations.addBlockers(created.id, [blockerIssueId], companyId)).resolves.toEqual({
      blockedBy: [expect.objectContaining({ id: blockerIssueId })],
      blocks: [],
    });

    await expect(
      harness.ctx.issues.getSubtree(created.id, companyId, { includeRelations: true }),
    ).resolves.toMatchObject({
      rootIssueId: created.id,
      issueIds: [created.id],
      relations: {
        [created.id]: {
          blockedBy: [expect.objectContaining({ id: blockerIssueId })],
        },
      },
    });
  });

  it("enforces plugin origin namespaces in the test harness", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.create", "issues.update", "issues.read"]),
    });

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Generated issue",
      originKind: "plugin:paperclip.test-orchestration:feature",
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration:feature");
    await expect(
      harness.ctx.issues.list({
        companyId,
        originKind: "plugin:paperclip.test-orchestration:feature",
      }),
    ).resolves.toHaveLength(1);
    await expect(
      harness.ctx.issues.create({
        companyId,
        title: "Spoofed issue",
        originKind: "plugin:other.plugin:feature",
      }),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.test-orchestration");
    await expect(
      harness.ctx.issues.update(
        created.id,
        { originKind: "plugin:other.plugin:feature" },
        companyId,
      ),
    ).rejects.toThrow("Plugin may only use originKind values under plugin:paperclip.test-orchestration");
  });

  it("supports generic plugin operation issue visibility in the test harness", async () => {
    const companyId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.create"]),
    });

    const created = await harness.ctx.issues.create({
      companyId,
      title: "Background operation",
      surfaceVisibility: "plugin_operation",
      originId: "operation-1",
    });

    expect(created.originKind).toBe("plugin:paperclip.test-orchestration:operation");
    expect(created.originId).toBe("operation-1");
  });

  it("enforces checkout and wakeup capabilities in the test harness", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const checkedOutIssueId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.checkout", "issues.wakeup", "issues.read"]),
    });
    harness.seed({
      issues: [
        issue({
          id: checkedOutIssueId,
          companyId,
          title: "Checked out",
          status: "in_progress",
          assigneeAgentId: agentId,
          checkoutRunId: runId,
        }),
      ],
    });

    await expect(
      harness.ctx.issues.assertCheckoutOwner({
        issueId: checkedOutIssueId,
        companyId,
        actorAgentId: agentId,
        actorRunId: runId,
      }),
    ).resolves.toMatchObject({
      issueId: checkedOutIssueId,
      checkoutRunId: runId,
    });

    await expect(
      harness.ctx.issues.requestWakeup(checkedOutIssueId, companyId, {
        reason: "mission_advance",
      }),
    ).resolves.toMatchObject({ queued: true });

    await expect(
      harness.ctx.issues.requestWakeups([checkedOutIssueId], companyId, {
        reason: "mission_advance",
        idempotencyKeyPrefix: "mission:alpha",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        issueId: checkedOutIssueId,
        queued: true,
      }),
    ]);
  });

  it("rejects wakeups when blockers are unresolved", async () => {
    const companyId = randomUUID();
    const blockerIssueId = randomUUID();
    const blockedIssueId = randomUUID();
    const harness = createTestHarness({
      manifest: manifest(["issues.wakeup", "issues.read"]),
    });
    harness.seed({
      issues: [
        issue({ id: blockerIssueId, companyId, title: "Unresolved blocker", status: "todo" }),
        issue({
          id: blockedIssueId,
          companyId,
          title: "Blocked work",
          status: "todo",
          assigneeAgentId: randomUUID(),
          blockedBy: [
            {
              id: blockerIssueId,
              identifier: null,
              title: "Unresolved blocker",
              status: "todo",
              priority: "medium",
              assigneeAgentId: null,
              assigneeUserId: null,
            },
          ],
        }),
      ],
    });

    await expect(
      harness.ctx.issues.requestWakeup(blockedIssueId, companyId),
    ).rejects.toThrow("Issue is blocked by unresolved blockers");
  });
});


describe("execution history test harness", () => {
  it("preserves policy/state and pages retained decisions with bounded labels", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const agentId = randomUUID();
    const executionPolicy = {
      mode: "normal" as const, commentRequired: true,
      stages: [{ id: stageId, type: "review" as const, approvalsNeeded: 1 as const,
        participants: [{ id: randomUUID(), type: "agent" as const, agentId }] }],
    };
    const executionState = {
      status: "pending" as const, currentStageId: stageId, currentStageIndex: 0, currentStageType: "review" as const,
      currentParticipant: { type: "user" as const, userId: "member" },
      returnAssignee: { type: "agent" as const, agentId },
      reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
    };
    const harness = createTestHarness({ manifest: manifest(["issues.read", "issue.execution.read"]) });
    const decisions = Array.from({ length: 3 }, () => randomUUID()).sort().map((id, index) => ({
      id, companyId, issueId, stageId: index === 0 ? randomUUID() : stageId,
      stageType: "review" as const, outcome: "approved" as const, body: "Retained round",
      actorAgentId: null, actorUserId: index === 2 ? "page-only" : null, createdByRunId: null,
      createdAt: "2026-10-21T08:00:00.000Z", updatedAt: "2026-10-21T08:00:00.000Z",
    }));
    harness.seed({
      issues: [issue({ id: issueId, companyId, title: "History", executionPolicy, executionState })],
      issueExecutionDecisions: decisions,
      issueExecutionPrincipalLabels: [
        { companyId, type: "user", id: "member", label: "Member name" },
        { companyId, type: "user", id: "unrelated", label: "Do not expose" },
      ],
    });
    expect(await harness.ctx.issues.get(issueId, companyId)).toMatchObject({ executionPolicy, executionState });
    const first = await harness.ctx.issues.listExecutionDecisions(issueId, companyId, { limit: 2 });
    expect(first.items).toEqual(decisions.slice(0, 2));
    expect(first.principalLabels).toEqual({
      [`agent:${agentId}`]: { type: "agent", id: agentId, label: null },
      "user:member": { type: "user", id: "member", label: "Member name" },
    });
    const last = await harness.ctx.issues.listExecutionDecisions(issueId, companyId, { cursor: first.nextCursor!, limit: 2 });
    expect(last.items).toEqual(decisions.slice(2));
    expect(last.nextCursor).toBeNull();
    expect(last.principalLabels["user:page-only"]).toEqual({ type: "user", id: "page-only", label: null });
    expect(await harness.ctx.issues.listExecutionDecisions(issueId, randomUUID())).toEqual({ items: [], nextCursor: null, principalLabels: {} });
    await expect(harness.ctx.issues.listExecutionDecisions(issueId, companyId, { limit: 101 })).rejects.toThrow("Invalid execution decision history options");
    await expect(harness.ctx.issues.listExecutionDecisions(issueId, companyId, { cursor: "bad" })).rejects.toThrow("Invalid execution decision history cursor");
    const denied = createTestHarness({ manifest: manifest(["issues.read"]) });
    await expect(denied.ctx.issues.listExecutionDecisions(issueId, companyId)).rejects.toThrow("issue.execution.read");
  });
});
