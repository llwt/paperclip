import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin, { DATA_KEY } from "../src/worker.js";
import type { ExecutionFlowResponse } from "../src/model.js";
import { card, decision, hostIssue, page } from "./fixtures.js";

const params = { companyId: "company", issueId: "issue" };

async function strictWorker() {
  const get = vi.fn().mockResolvedValue(hostIssue());
  const listExecutionDecisions = vi.fn().mockResolvedValue(page([decision()]));
  const listInteractions = vi.fn().mockResolvedValue([card()]);
  const reads = { get, listExecutionDecisions, listInteractions };
  let handler: ((params: Record<string, unknown>) => Promise<unknown>) | undefined;
  const register = vi.fn((key, callback) => {
    expect(key).toBe(DATA_KEY);
    handler = callback;
  });
  // Fail on access to any undeclared host surface, including write registration.
  const ctx = new Proxy({}, {
    get(_target, key) {
      if (key === "data") return { register };
      if (key === "issues") return new Proxy(reads, {
        get(target, method) {
          if (!(method in target)) throw new Error(`Unexpected issue operation: ${String(method)}`);
          return target[method as keyof typeof reads];
        },
      });
      throw new Error(`Unexpected host surface: ${String(key)}`);
    },
  }) as PluginContext;
  await plugin.definition.setup(ctx);
  expect(register).toHaveBeenCalledTimes(1);
  return { ...reads, read: (input: Record<string, unknown> = params) => handler!(input) as Promise<ExecutionFlowResponse> };
}

describe("read-only worker", () => {
  it("declares exactly the four allowed capabilities and the issue slot", () => {
    expect(manifest.id).toBe("somnex.execution-flow");
    expect(manifest.capabilities).toEqual(["issues.read", "issue.execution.read", "issue.interactions.read", "ui.detailTab.register"]);
    expect(manifest.ui?.slots).toEqual([{ type: "taskDetailView", id: "execution-flow", displayName: "Execution flow", entityTypes: ["issue"], exportName: "ExecutionFlow" }]);
    expect(Object.keys(plugin.definition)).toEqual(["setup"]);
    expect(Object.keys(manifest).sort()).toEqual(["id", "apiVersion", "version", "displayName", "description", "author", "categories", "capabilities", "entrypoints", "ui"].sort());
  });

  it("makes only three host reads and returns a small model", async () => {
    const worker = await strictWorker();
    const view = await worker.read();
    expect(worker.get).toHaveBeenCalledExactlyOnceWith("issue", "company");
    expect(worker.listExecutionDecisions).toHaveBeenCalledExactlyOnceWith("issue", "company", { cursor: undefined, limit: 50 });
    expect(worker.listInteractions).toHaveBeenCalledExactlyOnceWith("issue", "company");
    expect(view.execution.stages).toHaveLength(2);
    expect(view.history.decisions).toHaveLength(1);
    expect(view.subject).toEqual({ companyId: "company", issueId: "issue" });
    expect(JSON.stringify(view)).not.toContain("Unrelated private data");
    expect(JSON.stringify(view)).not.toContain("Do not return this");
    expect(JSON.stringify(view)).not.toContain("createdByRunId");
  });

  it("passes an opaque cursor unchanged and resolves issue identifiers to UUIDs", async () => {
    const worker = await strictWorker();
    worker.get.mockResolvedValue({ ...hostIssue(), id: "resolved-uuid" });
    const view = await worker.read({ ...params, issueId: "TASK-1", cursor: "opaque+/cursor=" });
    expect(worker.get).toHaveBeenCalledWith("TASK-1", "company");
    expect(worker.listExecutionDecisions).toHaveBeenCalledExactlyOnceWith("resolved-uuid", "company", { cursor: "opaque+/cursor=", limit: 50 });
    expect(view.history.requestedCursor).toBe("opaque+/cursor=");
  });

  it.each([{}, { companyId: "company" }, { ...params, companyId: "" }, { ...params, cursor: 1 }, { ...params, cursor: "" }])("rejects invalid parameters before any read (%j)", async (input) => {
    const worker = await strictWorker();
    await expect(worker.read(input)).rejects.toThrow();
    expect(worker.get).not.toHaveBeenCalled();
  });

  it.each([null, { ...hostIssue(), companyId: "other-company" }])("does not read history or cards for an unavailable/foreign issue", async (source) => {
    const worker = await strictWorker();
    worker.get.mockResolvedValue(source);
    await expect(worker.read()).rejects.toThrow("Issue unavailable");
    expect(worker.listExecutionDecisions).not.toHaveBeenCalled();
    expect(worker.listInteractions).not.toHaveBeenCalled();
  });

  it("surfaces an issue read failure without pretending no stages exist", async () => {
    const worker = await strictWorker();
    worker.get.mockRejectedValue(new Error("Host failed"));
    await expect(worker.read()).rejects.toThrow("Host failed");
  });

  it.each(["rejected", "unsupported"])("shows unavailable history for a %s read while keeping stages/cards", async (failure) => {
    const worker = await strictWorker();
    if (failure === "unsupported") worker.listExecutionDecisions.mockImplementation(() => { throw new TypeError("listExecutionDecisions is not a function"); });
    else worker.listExecutionDecisions.mockRejectedValue(new Error("RPC method not found"));
    const view = await worker.read();
    expect(view.execution.status).toBe("available");
    expect(view.execution.stages).toHaveLength(2);
    expect(view.history).toMatchObject({ status: "unavailable", message: "Decision history unavailable", hasMore: null });
    expect(view.confirmations.items).toHaveLength(1);
  });

  it("reports a failed card read separately from successful history", async () => {
    const worker = await strictWorker();
    worker.listInteractions.mockRejectedValue(new Error("Cards failed"));
    const view = await worker.read();
    expect(view.history).toMatchObject({ status: "available", message: null });
    expect(view.history.decisions).toHaveLength(1);
    expect(view.confirmations).toMatchObject({ status: "unavailable", message: "Task confirmations unavailable" });
  });

  it("keeps both failure messages when history and cards fail", async () => {
    const worker = await strictWorker();
    worker.listExecutionDecisions.mockRejectedValue(new Error("History failed"));
    worker.listInteractions.mockRejectedValue(new Error("Cards failed"));
    const view = await worker.read();
    expect(view.execution.stages).toHaveLength(2);
    expect(view.history.message).toBe("Decision history unavailable");
    expect(view.confirmations.message).toBe("Task confirmations unavailable");
  });

  it("treats missing old-host execution fields as unavailable, separately from history", async () => {
    const worker = await strictWorker();
    worker.get.mockResolvedValue({ ...hostIssue(), executionPolicy: undefined, executionState: undefined });
    const view = await worker.read();
    expect(view.execution.message).toBe("Execution data unavailable");
    expect(view.history.decisions).toHaveLength(1);
  });

  it("reads only one page and does not cache previous task data", async () => {
    const worker = await strictWorker();
    worker.listExecutionDecisions.mockResolvedValueOnce({ ...page([decision()]), nextCursor: "next" });
    expect((await worker.read()).history.hasMore).toBe(true);
    worker.get.mockResolvedValue({ ...hostIssue(), id: "second" });
    worker.listExecutionDecisions.mockResolvedValue(page());
    worker.listInteractions.mockResolvedValue([]);
    const second = await worker.read({ ...params, issueId: "second" });
    expect(second.history.decisions).toEqual([]);
    expect(second.confirmations.items).toEqual([]);
    expect(worker.listExecutionDecisions).toHaveBeenCalledTimes(2);
  });

  it("integrates with the workspace SDK harness using the declared grants", async () => {
    const harness = createTestHarness({ manifest });
    harness.seed({ issues: [hostIssue()], issueExecutionDecisions: [decision()], issueInteractions: [card()] });
    await plugin.definition.setup(harness.ctx);
    const view = await harness.getData<ExecutionFlowResponse>(DATA_KEY, params);
    expect(view.history.status).toBe("available");
    expect(view.history.decisions[0].id).toBe("decision");
    expect(view.confirmations.items[0].id).toBe("card");
    expect(harness.activity).toEqual([]);
    await expect(harness.performAction("approve", params)).rejects.toThrow();
  });
});
