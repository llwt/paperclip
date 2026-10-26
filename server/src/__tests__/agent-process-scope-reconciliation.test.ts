// SX-2305 step 5: cancel, shutdown and restart reconciliation of agent
// process scopes. The restart matrix of plan SX-2306 ("Verification and
// evidence") on an isolated database and a private scope registry.
//
// Workloads are launched by a separate Node process that stands in for an
// earlier server (fixtures/earlier-server-scope-launch.ts) and exits, so their
// records are really inherited. With a usable systemd user manager the
// workloads run in real scopes below one owned, uniquely named test slice,
// which is stopped afterwards; every case also runs without a scope (a
// degraded launch, as when the manager is unavailable). No live run, service
// or production unit is touched.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  closeRegisteredClients,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  agentScopeRegistryDir,
  buildScopeUnitName,
  createSystemdIsolationPolicy,
  ensureRegistryDir,
  listOwnedScopeRecords,
  newLaunchNonce,
  readBootId,
  readProcStat,
  readScopeRecord,
  SCOPE_MANIFEST_KIND,
  SCOPE_MANIFEST_VERSION,
  spawnIsolated,
  terminateOwnedProcessTree,
  writeScopeManifest,
  type ProcessOwnerKind,
  type ScopeManifest,
  type ScopeRecord,
} from "@paperclipai/process-launch";
import { prepareSystemdTestEnv } from "@paperclipai/process-launch/systemd-test-env";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  abandonHeldAgentRunAdmission,
  closeAgentScopesForShutdown,
  decideInheritedScope,
  holdAgentRunAdmission,
  isAgentRunAdmissionOpen,
  reconcileAgentScopes,
  resetAgentRunAdmissionForTests,
  setAgentScopeRegistryForTests,
  terminateInheritedOwnerScopes,
  waitForAgentRunAdmission,
  type ScopeOwnerFacts,
} from "../services/agent-process-scopes.js";
import { readHotRestartIntent, readProcessStartedAt, writeHotRestartIntent } from "../services/hot-restart.js";
import { heartbeatService } from "../services/heartbeat.js";
import { getRunLogStore } from "../services/run-log-store.js";
import { claimNativeRestartRecoveries } from "../services/native-runtime/native-restart-recovery.js";
import { prepareNativeHeartbeatRun } from "../services/native-runtime/prepare-native-run.js";

// Every provider start in these tests is recorded here and never runs a real
// provider (a process-loss retry is queued as a real run).
const providerExecute = vi.hoisted(() => vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null })));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: providerExecute,
    })),
  };
});

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/earlier-server-scope-launch.ts", import.meta.url));
const relayFixture = fileURLToPath(new URL("./fixtures/earlier-server-relay-launch.ts", import.meta.url));

function manifestFor(
  instanceId: string,
  owner: { kind: ProcessOwnerKind; id: string; companyId: string | null },
  overrides: Partial<ScopeManifest> = {},
): ScopeManifest {
  const nonce = newLaunchNonce();
  return {
    version: SCOPE_MANIFEST_VERSION,
    kind: SCOPE_MANIFEST_KIND,
    instanceId,
    owner,
    nonce,
    unit: buildScopeUnitName({ instanceId, ownerKind: owner.kind, ownerId: owner.id, companyId: owner.companyId, nonce }),
    slice: "app-agents.slice",
    bootId: readBootId(),
    createdAt: new Date().toISOString(),
    state: "spawned",
    pid: null,
    pidStartTime: null,
    expectedCgroup: null,
    preflight: null,
    ...overrides,
  };
}

function recordOf(owner: { kind: ProcessOwnerKind; id: string; companyId?: string | null }, state: "intent" | "spawned" = "spawned"): ScopeRecord {
  const manifest = manifestFor("instance-a", { kind: owner.kind, id: owner.id, companyId: owner.companyId ?? "company-a" }, { state });
  return { ref: { registryDir: "/unused", unit: manifest.unit }, manifest, status: null };
}

const noFacts: ScopeOwnerFacts = { run: null, service: null, rootAlive: false };
const activeRun = { status: "running", companyId: "company-a", runtimeMode: "legacy" };

describe("decideInheritedScope", () => {
  it.each([
    ["live legacy run", recordOf({ kind: "run", id: "r" }), { ...noFacts, run: activeRun }, "keep", "owner_run_active"],
    ["terminal run", recordOf({ kind: "run", id: "r" }), { ...noFacts, run: { ...activeRun, status: "failed" } }, "stop", "owner_run_failed"],
    ["missing run", recordOf({ kind: "run", id: "r" }), noFacts, "stop", "owner_run_missing"],
    ["run of another company", recordOf({ kind: "run", id: "r", companyId: "company-b" }), { ...noFacts, run: activeRun }, "stop", "owner_run_missing"],
    ["partial launch of a live run", recordOf({ kind: "run", id: "r" }, "intent"), { ...noFacts, run: activeRun }, "stop", "partial_launch"],
    ["server tool of a native run", recordOf({ kind: "run", id: "r" }), { ...noFacts, run: { ...activeRun, runtimeMode: "native" } }, "stop", "server_tool_unadoptable"],
    ["relay of a live run", recordOf({ kind: "relay", id: "r" }), { ...noFacts, run: activeRun }, "keep", "owner_run_active"],
    ["relay of an ended run", recordOf({ kind: "relay", id: "r" }), { ...noFacts, run: { ...activeRun, status: "succeeded" } }, "stop", "owner_run_succeeded"],
    ["native runner whose root is gone", recordOf({ kind: "runner", id: "x" }), { ...noFacts, nativeRun: activeRun }, "stop", "native_root_gone"],
    ["native runner of an active run", recordOf({ kind: "runner", id: "x" }), { ...noFacts, rootAlive: true, nativeRun: activeRun }, "keep", "native_owner_run_active"],
    ["warm runner retained after a successful run", recordOf({ kind: "runner", id: "x" }), { ...noFacts, rootAlive: true, nativeRun: { ...activeRun, status: "succeeded" } }, "keep", "native_runner_retained"],
    ["native runner whose run recovery failed", recordOf({ kind: "runner", id: "x" }), { ...noFacts, rootAlive: true, nativeRun: { ...activeRun, status: "failed" } }, "stop", "native_owner_run_failed"],
    ["native runner of a cancelled run", recordOf({ kind: "runner", id: "x" }), { ...noFacts, rootAlive: true, nativeRun: { ...activeRun, status: "cancelled" } }, "stop", "native_owner_run_cancelled"],
    ["native runner of another company", recordOf({ kind: "runner", id: "x", companyId: "company-b" }), { ...noFacts, rootAlive: true, nativeRun: activeRun }, "stop", "native_owner_company_mismatch"],
    ["live native runner no run names", recordOf({ kind: "runner", id: "x" }), { ...noFacts, rootAlive: true }, "hold", "native_owner_unresolved"],
    ["native warm provider of an active run", recordOf({ kind: "warm_provider", id: "x" }), { ...noFacts, rootAlive: true, nativeRun: activeRun }, "keep", "native_owner_run_active"],
    ["ACP warm provider", recordOf({ kind: "warm_provider", id: "acp-1" }), { ...noFacts, rootAlive: true }, "stop", "server_stdio_provider"],
    ["auxiliary helper", recordOf({ kind: "auxiliary", id: "a" }), { ...noFacts, rootAlive: true }, "stop", "auxiliary_owner_ended"],
    ["running managed service", recordOf({ kind: "managed_service", id: "s" }), { ...noFacts, service: { status: "running", companyId: "company-a" } }, "keep", "owner_service_active"],
    ["stopped managed service", recordOf({ kind: "managed_service", id: "s" }), { ...noFacts, service: { status: "stopped", companyId: "company-a" } }, "stop", "owner_service_stopped"],
  ] as const)("%s: %s", (_name, record, facts, action, reason) => {
    expect(decideInheritedScope(record, facts)).toEqual({ action, reason });
  });
});

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl ? { supported: true } : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping agent scope reconciliation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

const systemd = prepareSystemdTestEnv();
// Every case runs without a scope; with a usable user manager it also runs in a real scope.
const modes: Array<"scope" | "degraded"> = systemd.skipReason ? ["degraded"] : ["scope", "degraded"];
if (systemd.skipReason) console.warn(`Real scope cases skipped: ${systemd.skipReason}`);

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return readProcStat(pid)?.state !== "Z";
  } catch {
    return false;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

describeEmbeddedPostgres("agent process scope reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let home = "";
  let previousHome: string | undefined;
  let instanceId = "";
  let registryDir = "";
  // PIDs a test made; SIGKILLed afterwards even when an assertion fails.
  const owned = new Set<number>();
  const children = new Set<ChildProcess>();
  const registries = new Set<{ registryDir: string; instanceId: string }>();

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-scope-reconcile-");
      db = createDb(tempDb.connectionString);
    }
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 30_000);

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-scope-reconcile-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    instanceId = `pcrecon-${randomBytes(4).toString("hex")}`;
    registryDir = agentScopeRegistryDir(resolvePaperclipInstanceRoot());
    registries.add({ registryDir, instanceId });
    ensureRegistryDir(registryDir);
    setAgentScopeRegistryForTests({ instanceId, registryDir, graceMs: 300, killWaitMs: 3_000 });
  });

  afterEach(async () => {
    setAgentScopeRegistryForTests(null);
    resetAgentRunAdmissionForTests();
    providerExecute.mockClear();
    // Each test sees only its own live runs.
    const active = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    if (active.length > 0) {
      await db
        .update(heartbeatRuns)
        .set({ status: "cancelled", finishedAt: new Date(), processPid: null, processGroupId: null })
        .where(inArray(heartbeatRuns.id, active.map((run) => run.id)));
    }
    for (const registry of registries) {
      for (const record of listOwnedScopeRecords(registry.registryDir, registry.instanceId).records) {
        await terminateOwnedProcessTree(record.ref, { instanceId: registry.instanceId, graceMs: 100, killWaitMs: 2_000 }).catch(() => null);
      }
    }
    registries.clear();
    for (const child of children) child.kill("SIGKILL");
    children.clear();
    for (const pid of owned) {
      if (pid > 1) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
    owned.clear();
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(home, { recursive: true, force: true });
  });

  afterAll(async () => {
    systemd.stop();
    if (externalTestDatabaseUrl) await closeRegisteredClients(externalTestDatabaseUrl);
    await tempDb?.cleanup();
  });

  /** Launch `script` the way an earlier server process would, and return what it left. */
  function launchEarlier(
    mode: "scope" | "degraded",
    owner: { kind: ProcessOwnerKind; id: string; companyId: string | null },
    script: string,
    target: { instanceId: string; registryDir: string } = { instanceId, registryDir },
  ): { pid: number; unit: string; outcome: string } {
    registries.add(target);
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        fixture,
        JSON.stringify({
          registryDir: target.registryDir,
          instanceId: target.instanceId,
          slice: systemd.slice,
          userBusAddress: systemd.userBusAddress,
          helperPath: mode === "scope" ? systemd.helper : "/nonexistent/paperclip-scope-exec",
          owner,
          script,
        }),
      ],
      { cwd: serverRoot, encoding: "utf8", timeout: 30_000 },
    );
    const launched = JSON.parse(out.trim().split("\n").pop()!) as { pid: number; unit: string; outcome: string };
    owned.add(launched.pid);
    expect(launched.outcome).toBe(mode === "scope" ? "enrolled" : "degraded");
    return launched;
  }

  /**
   * Launch a run's provider with piped output and hand its pipes to a real
   * output relay, the way an earlier server does at a hot restart.
   */
  function launchEarlierWithRelay(
    mode: "scope" | "degraded",
    run: { runId: string; companyId: string },
    script: string,
  ): { pid: number; unit: string; relayPid: number; relayUnit: string; relayDir: string } {
    const relayDir = path.resolve(resolvePaperclipInstanceRoot(), "data", "run-output-relay", run.runId);
    const out = execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        relayFixture,
        JSON.stringify({
          registryDir,
          instanceId,
          slice: systemd.slice,
          userBusAddress: systemd.userBusAddress,
          helperPath: mode === "scope" ? systemd.helper : "/nonexistent/paperclip-scope-exec",
          runId: run.runId,
          companyId: run.companyId,
          relayDir,
          script,
        }),
      ],
      { cwd: serverRoot, encoding: "utf8", timeout: 30_000 },
    );
    const launched = JSON.parse(out.trim().split("\n").pop()!) as {
      pid: number;
      unit: string;
      outcome: string;
      relayPid: number;
      relayUnit: string;
      relayOutcome: string;
    };
    owned.add(launched.pid);
    owned.add(launched.relayPid);
    expect(launched.outcome).toBe(mode === "scope" ? "enrolled" : "degraded");
    expect(launched.relayOutcome).toBe(mode === "scope" ? "enrolled" : "degraded");
    return { ...launched, relayDir };
  }

  /** A provider that writes `payload` once `go` exists, then keeps its output pipes open. */
  function writesOnSignal(go: string, payload: string): string {
    return `while [ ! -e ${go} ]; do /bin/sleep 0.05; done; printf '${payload}'; exec /bin/sleep 300`;
  }

  /** Whether the provider got past its write (it then runs `sleep`). */
  function providerWrote(pid: number): boolean {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8").startsWith("/bin/sleep");
    } catch {
      return false;
    }
  }

  async function readRunLog(run: { companyId: string; agentId: string; runId: string }): Promise<string> {
    const store = getRunLogStore();
    return (await store.read(await store.begin(run))).content;
  }

  async function readPid(file: string): Promise<number> {
    expect(await waitUntil(() => existsSync(file) && readFileSync(file, "utf8").trim() !== "")).toBe(true);
    const pid = Number(readFileSync(file, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    owned.add(pid);
    return pid;
  }

  function pidFile(): string {
    return path.join(home, `pid-${randomBytes(4).toString("hex")}`);
  }

  /** A workload with a leftover that escapes its process group and environment when a scope holds it. */
  function workload(mode: "scope" | "degraded", file: string, rootExits = false): string {
    const leftover = mode === "scope"
      ? `setsid sh -c 'exec env -i /bin/sleep 300' & echo $! > ${file}`
      : `/bin/sleep 300 & echo $! > ${file}`;
    return `${leftover}; ${rootExits ? "exit 0" : "exec /bin/sleep 300"}`;
  }

  function inScope(pid: number, unit: string): boolean {
    try {
      return readFileSync(`/proc/${pid}/cgroup`, "utf8").trim().endsWith(`/${unit}`);
    } catch {
      return false;
    }
  }

  async function seedRun(input: {
    status?: string;
    processPid?: number | null;
    runtimeMode?: "legacy" | "native";
    /** Add the run to an agent seeded earlier. */
    agent?: { companyId: string; agentId: string };
  } = {}) {
    const companyId = input.agent?.companyId ?? randomUUID();
    const agentId = input.agent?.agentId ?? randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    if (!input.agent) {
      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        defaultResponsibleUserId: "responsible-user",
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "running",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {},
      status: input.status === "queued" ? "queued" : "claimed",
      runId,
      claimedAt: input.status === "queued" ? null : new Date(),
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status ?? "running",
      wakeupRequestId,
      contextSnapshot: { executionEngine: "cli", processTopology: "detached" },
      runtimeMode: input.runtimeMode ?? "legacy",
      runtimeModeResolvedAt: new Date(),
      processPid: input.processPid ?? null,
      processGroupId: input.processPid ?? null,
      nextEventSeq: 1,
      logStore: "local_file",
      logRef: path.join(companyId, agentId, `${runId}.ndjson`),
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, agentId, runId };
  }

  /** A native run as the native runtime prepares it, with its runner instance id. */
  async function seedNativeRun(input: { issueStatus?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const prefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Native",
      issuePrefix: prefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Native runner",
      role: "engineer",
      status: "active",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Native task",
      status: input.issueStatus ?? "in_progress",
      priority: "medium",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    const [run] = await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    }).returning();
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const native = await prepareNativeHeartbeatRun({
      db,
      run: run!,
      issue: { id: issueId, title: "Native task", description: null, reviewPolicy: null },
      environmentLeaseId: `lease-${runId}`,
    });
    await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed" });
    return { companyId, agentId, runId, issueId, runnerInstanceId: native.runnerInstanceId };
  }

  async function setRunStatus(runId: string, status: string) {
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  }

  function recorded(unit: string): boolean {
    return readScopeRecord({ registryDir, unit }) !== null;
  }

  describe.each(modes)("%s launch", (mode) => {
    it("terminal run with a surviving grandchild: the leftover is stopped and the record removed", async () => {
      const { runId, companyId } = await seedRun();
      const file = pidFile();
      const launched = launchEarlier(mode, { kind: "run", id: runId, companyId }, workload(mode, file));
      const leftover = await readPid(file);
      if (mode === "scope") expect(inScope(leftover, launched.unit)).toBe(true);

      // While the run is live, a restart keeps its scope for run recovery.
      expect((await reconcileAgentScopes({ db })).kept.map((entry) => entry.unit)).toEqual([launched.unit]);
      expect(alive(leftover)).toBe(true);

      await setRunStatus(runId, "succeeded");
      const report = await reconcileAgentScopes({ db });
      expect(report.stopped).toEqual([
        expect.objectContaining({ unit: launched.unit, ownerKind: "run", reason: "owner_run_succeeded", outcome: "terminated" }),
      ]);
      expect(await waitUntil(() => !alive(leftover) && !alive(launched.pid))).toBe(true);
      expect(recorded(launched.unit)).toBe(false);
    });

    it("provider exited while the server was down: once the reaper ends the run, its leftovers are handled", async () => {
      const file = pidFile();
      const { runId, companyId } = await seedRun();
      const launched = launchEarlier(mode, { kind: "run", id: runId, companyId }, workload(mode, file, true));
      const leftover = await readPid(file);
      expect(await waitUntil(() => !alive(launched.pid))).toBe(true);
      await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, runId));
      if (mode === "degraded") {
        // Without a scope the leftover still carries the root's process group,
        // so the reaper sees a live group and keeps the run; end it here.
        await setRunStatus(runId, "failed");
      } else {
        await heartbeatService(db).reapOrphanedRuns();
        const reaped = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
        expect(reaped.status).toBe("failed");
      }

      const report = await reconcileAgentScopes({ db });
      if (mode === "scope") {
        // The reaper stopped the run's scope as it ended the run; nothing is left to decide.
        expect(alive(leftover)).toBe(false);
        expect(recorded(launched.unit)).toBe(false);
        expect(report).toEqual({ kept: [], stopped: [], pending: [], unmatchedUnits: [] });
      } else {
        // The root was reaped, so the group id can no longer be tied to the
        // record: nothing is signalled, the record stays, and the result is
        // pending, never a reported success.
        expect(report.stopped).toEqual([]);
        expect(report.pending).toEqual([
          expect.objectContaining({ unit: launched.unit, reason: "owner_run_failed:group_ownership_unprovable" }),
        ]);
        expect(alive(leftover)).toBe(true);
        expect(recorded(launched.unit)).toBe(true);
      }
    });

    it("cancel of a run adopted after a restart stops its inherited scope", async () => {
      const file = pidFile();
      const { runId, companyId } = await seedRun();
      const launched = launchEarlier(mode, { kind: "run", id: runId, companyId }, workload(mode, file));
      const leftover = await readPid(file);
      await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, runId));

      const cancelled = await heartbeatService(db).cancelRun(runId, "Stopped by the operator");
      expect(cancelled?.status).toBe("cancelled");
      expect(await waitUntil(() => !alive(leftover) && !alive(launched.pid))).toBe(true);
      expect(recorded(launched.unit)).toBe(false);
      expect((cancelled?.resultJson as Record<string, unknown> | null)?.agentScopeCleanup).toBeUndefined();
    });

    it("hot restart hands the scope reference over and adoption keeps the scope", async () => {
      const file = pidFile();
      const { runId, companyId } = await seedRun();
      const launched = launchEarlier(mode, { kind: "run", id: runId, companyId }, workload(mode, file));
      const leftover = await readPid(file);
      await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, runId));

      const oldServer = heartbeatService(db);
      await writeHotRestartIntent({ previousServerPid: process.pid, previousServerVersion: "old-version" });
      const prepared = await oldServer.prepareHotRestartShutdown("SIGTERM");
      expect(prepared).toMatchObject({ mode: "hot_restart", skipDrain: true });
      const intent = await readHotRestartIntent();
      expect(intent?.shutdownSnapshot?.activeRuns).toEqual([
        expect.objectContaining({ runId, agentScopeUnits: [launched.unit] }),
      ]);
      // The old server's last step keeps run scopes it hands over.
      const closed = await closeAgentScopesForShutdown({ handOff: true });
      expect(closed.stopped).toEqual([]);

      const newServer = heartbeatService(db);
      const adoption = await newServer.reconcileHotRestartAdoption();
      expect(adoption).toMatchObject({ adoptedRunIds: [runId] });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      const adopted = events.find((event) => event.message === "Adopted live child process after hot restart");
      expect((adopted?.payload as Record<string, unknown>)?.agentScopes).toEqual({ units: [launched.unit], unrecordedUnits: [] });

      const report = await reconcileAgentScopes({ db });
      expect(report.kept.map((entry) => entry.unit)).toEqual([launched.unit]);
      expect(alive(leftover)).toBe(true);
      expect(alive(launched.pid)).toBe(true);
      if (mode === "scope") expect(inScope(launched.pid, launched.unit)).toBe(true);
    });

    it("hot restart with an output relay: adoption keeps it; after the run ends its buffered output drains before its scope closes", async () => {
      const go = path.join(home, `go-${randomBytes(4).toString("hex")}`);
      const payload = "final-output-of-the-provider-30";
      const { runId, companyId, agentId } = await seedRun();
      const launched = launchEarlierWithRelay(mode, { runId, companyId }, writesOnSignal(go, payload));
      await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, runId));

      // Planned hot restart: the old server hands the run, its scope and its relay over.
      const oldServer = heartbeatService(db);
      await writeHotRestartIntent({ previousServerPid: process.pid, previousServerVersion: "old-version" });
      await oldServer.prepareHotRestartShutdown("SIGTERM");
      expect((await closeAgentScopesForShutdown({ handOff: true })).stopped).toEqual([]);
      const newServer = heartbeatService(db);
      expect(await newServer.reconcileHotRestartAdoption()).toMatchObject({ adoptedRunIds: [runId] });
      const adoptedRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
      expect(((adoptedRun.resultJson as Record<string, any>).hotRestart).outputCapture).toMatchObject({ mode: "relay" });
      expect((await reconcileAgentScopes({ db })).kept.map((entry) => entry.unit).sort())
        .toEqual([launched.unit, launched.relayUnit].sort());

      // The relay falls behind: the provider's last bytes wait in the pipe.
      process.kill(launched.relayPid, "SIGSTOP");
      try {
        writeFileSync(go, "");
        expect(await waitUntil(() => providerWrote(launched.pid))).toBe(true);
        expect((await newServer.cancelRun(runId, "Stopped by the operator"))?.status).toBe("cancelled");
        expect(await waitUntil(() => !alive(launched.pid))).toBe(true);

        // The run ended, but its relay has not drained: it is left running and reported, not killed.
        setAgentScopeRegistryForTests({ instanceId, registryDir, graceMs: 300, killWaitMs: 3_000, relayDrainMs: 300 });
        const draining = await reconcileAgentScopes({ db });
        expect(draining.stopped).toEqual([]);
        expect(draining.pending).toEqual([
          expect.objectContaining({ unit: launched.relayUnit, ownerKind: "relay", reason: "owner_run_cancelled:relay_draining" }),
        ]);
        expect(alive(launched.relayPid)).toBe(true);
        expect(recorded(launched.relayUnit)).toBe(true);
      } finally {
        process.kill(launched.relayPid, "SIGCONT");
      }

      // Once it drained, its scope is closed and its record removed.
      const drained = await reconcileAgentScopes({ db });
      expect(drained.pending).toEqual([]);
      expect(drained.stopped).toEqual([
        expect.objectContaining({ unit: launched.relayUnit, ownerKind: "relay", reason: "owner_run_cancelled" }),
      ]);
      expect(recorded(launched.relayUnit)).toBe(false);
      // Every byte reached the run log, and the relay wrote its end marker.
      expect(await waitUntil(() => !existsSync(launched.relayDir), 15_000)).toBe(true);
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
      expect(events.map((event) => event.message)).toContain("Child output relay reached the end of the child's output");
      expect(await readRunLog({ companyId, agentId, runId })).toContain(payload);
    }, 30_000);

    it("a relay that never drains is stopped only after the drain deadline, and reported as undrained", async () => {
      const { runId, companyId } = await seedRun();
      const launched = launchEarlierWithRelay(mode, { runId, companyId }, "exec /bin/sleep 300");
      process.kill(launched.relayPid, "SIGSTOP");
      await setRunStatus(runId, "failed");
      setAgentScopeRegistryForTests({
        instanceId,
        registryDir,
        graceMs: 300,
        killWaitMs: 3_000,
        relayDrainMs: 200,
        relayDrainDeadlineMs: 1_000,
      });

      const first = await reconcileAgentScopes({ db });
      expect(first.stopped).toEqual([expect.objectContaining({ unit: launched.unit, reason: "owner_run_failed" })]);
      expect(first.pending).toEqual([expect.objectContaining({ unit: launched.relayUnit, reason: "owner_run_failed:relay_draining" })]);
      expect(alive(launched.relayPid)).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const later = await reconcileAgentScopes({ db });
      expect(later.stopped).toEqual([
        expect.objectContaining({ unit: launched.relayUnit, reason: "owner_run_failed:relay_undrained", outcome: "terminated" }),
      ]);
      expect(await waitUntil(() => !alive(launched.relayPid))).toBe(true);
      expect(recorded(launched.relayUnit)).toBe(false);
    }, 30_000);

    it("two instances on one manager never touch each other's scopes", async () => {
      const otherInstance = `pcrecon-${randomBytes(4).toString("hex")}`;
      const otherRegistry = path.join(home, "other-instance", "runtime", "agent-scopes");
      const fileA = pidFile();
      const fileB = pidFile();
      const { runId: runA, companyId: companyA } = await seedRun({ status: "failed" });
      const { runId: runB, companyId: companyB } = await seedRun({ status: "failed" });
      const mine = launchEarlier(mode, { kind: "run", id: runA, companyId: companyA }, workload(mode, fileA));
      const theirs = launchEarlier(
        mode,
        { kind: "run", id: runB, companyId: companyB },
        workload(mode, fileB),
        { instanceId: otherInstance, registryDir: otherRegistry },
      );
      // A record of the other instance in this instance's directory is ignored too.
      const stray = manifestFor(otherInstance, { kind: "auxiliary", id: "aux-1", companyId: null }, {
        pid: theirs.pid,
        pidStartTime: readProcStat(theirs.pid)!.startTime,
        preflight: { outcome: "degraded", reason: "helper_missing" },
      });
      writeScopeManifest(registryDir, stray);
      const leftoverA = await readPid(fileA);
      const leftoverB = await readPid(fileB);

      const report = await reconcileAgentScopes({ db });
      expect(report.stopped.map((entry) => entry.unit)).toEqual([mine.unit]);
      expect(await waitUntil(() => !alive(leftoverA))).toBe(true);
      expect(alive(leftoverB)).toBe(true);
      expect(alive(theirs.pid)).toBe(true);
      expect(readScopeRecord({ registryDir: otherRegistry, unit: theirs.unit })).not.toBeNull();
      expect(readScopeRecord({ registryDir, unit: stray.unit })).not.toBeNull();
    });

    it("ordinary shutdown stops run, auxiliary and ACP warm scopes and keeps native and service owners", async () => {
      const { runId, companyId } = await seedRun();
      const serviceId = randomUUID();
      await db.insert(workspaceRuntimeServices).values({
        id: serviceId,
        companyId,
        scopeType: "project_workspace",
        serviceName: "web",
        status: "running",
        lifecycle: "shared",
        provider: "local_process",
      });
      const run = launchEarlier(mode, { kind: "run", id: runId, companyId }, "exec /bin/sleep 300");
      const aux = launchEarlier(mode, { kind: "auxiliary", id: randomUUID(), companyId: null }, "exec /bin/sleep 300");
      const acp = launchEarlier(mode, { kind: "warm_provider", id: `acp-${randomUUID()}`, companyId }, "exec /bin/sleep 300");
      const runner = launchEarlier(mode, { kind: "runner", id: randomUUID(), companyId }, "exec /bin/sleep 300");
      const service = launchEarlier(mode, { kind: "managed_service", id: serviceId, companyId }, "exec /bin/sleep 300");

      const hot = await closeAgentScopesForShutdown({ handOff: true, graceMs: 300 });
      expect(hot.stopped.map((entry) => entry.unit).sort()).toEqual([aux.unit, acp.unit].sort());
      expect(alive(run.pid)).toBe(true);

      const ordinary = await closeAgentScopesForShutdown({ handOff: false, graceMs: 300 });
      expect(ordinary.stopped.map((entry) => entry.unit)).toEqual([run.unit]);
      expect(await waitUntil(() => !alive(run.pid) && !alive(aux.pid) && !alive(acp.pid))).toBe(true);
      expect(alive(runner.pid)).toBe(true);
      expect(alive(service.pid)).toBe(true);
      expect(ordinary.kept.map((entry) => entry.unit).sort()).toEqual([runner.unit, service.unit].sort());
    });

    it("native runner recovery: native restart recovery decides a live runner, the leftovers of a dead one are stopped", async () => {
      // Recovery reattaches the runner it can verify; the run stays live.
      const reattached = await seedNativeRun();
      const live = launchEarlier(mode, { kind: "runner", id: reattached.runnerInstanceId, companyId: reattached.companyId }, "exec /bin/sleep 300");
      const startedAt = await readProcessStartedAt(live.pid);
      await db.update(heartbeatRuns)
        .set({ processPid: live.pid, processGroupId: live.pid, processStartedAt: startedAt ? new Date(startedAt) : null })
        .where(eq(heartbeatRuns.id, reattached.runId));
      // The task changed hands while the server was down: recovery ends the run.
      const ended = await seedNativeRun({ issueStatus: "done" });
      const orphan = launchEarlier(mode, { kind: "runner", id: ended.runnerInstanceId, companyId: ended.companyId }, "exec /bin/sleep 300");
      // A live runner no run names: its owner cannot be resolved.
      const unnamed = launchEarlier(mode, { kind: "runner", id: randomUUID(), companyId: reattached.companyId }, "exec /bin/sleep 300");
      // A runner whose root died: what it left is leftovers.
      const file = pidFile();
      const dead = launchEarlier(mode, { kind: "runner", id: reattached.runnerInstanceId, companyId: reattached.companyId }, workload(mode, file, true));
      const leftover = await readPid(file);
      expect(await waitUntil(() => !alive(dead.pid))).toBe(true);

      const dispositions = await claimNativeRestartRecoveries({
        db,
        restartKind: "hard",
        runIds: [reattached.runId, ended.runId],
      });
      expect(dispositions).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId: reattached.runId, kind: "reattach_existing_runner" }),
        expect.objectContaining({ runId: ended.runId, kind: "blocked", reason: "task_ownership_or_status_changed" }),
      ]));

      const report = await reconcileAgentScopes({ db });
      expect(report.kept).toEqual([expect.objectContaining({ unit: live.unit, reason: "native_owner_run_active" })]);
      expect(alive(live.pid)).toBe(true);
      expect(report.stopped).toEqual(expect.arrayContaining([
        expect.objectContaining({ unit: orphan.unit, reason: "native_owner_run_failed", outcome: "terminated" }),
      ]));
      expect(await waitUntil(() => !alive(orphan.pid))).toBe(true);
      expect(report.pending).toEqual(expect.arrayContaining([
        { unit: unnamed.unit, ownerKind: "runner", reason: "native_owner_unresolved" },
      ]));
      expect(alive(unnamed.pid)).toBe(true);
      expect(recorded(unnamed.unit)).toBe(true);
      if (mode === "scope") {
        expect(report.stopped).toEqual(expect.arrayContaining([expect.objectContaining({ unit: dead.unit, reason: "native_root_gone" })]));
        expect(await waitUntil(() => !alive(leftover))).toBe(true);
      } else {
        expect(report.pending).toEqual(expect.arrayContaining([
          expect.objectContaining({ unit: dead.unit, reason: "native_root_gone:group_ownership_unprovable" }),
        ]));
      }
    });

    it("native warm runner retained after a successful run is kept until a later run of it ends otherwise", async () => {
      const native = await seedNativeRun();
      const runner = launchEarlier(mode, { kind: "runner", id: native.runnerInstanceId, companyId: native.companyId }, "exec /bin/sleep 300");
      await setRunStatus(native.runId, "succeeded");
      expect((await reconcileAgentScopes({ db })).kept).toEqual([
        expect.objectContaining({ unit: runner.unit, reason: "native_runner_retained" }),
      ]);
      // The next run reuses the retained runner and is cancelled.
      const next = await seedRun({ status: "cancelled", runtimeMode: "native", agent: native });
      await db.update(heartbeatRuns)
        .set({ runnerInstanceId: native.runnerInstanceId, createdAt: new Date(Date.now() + 1_000) })
        .where(eq(heartbeatRuns.id, next.runId));
      const report = await reconcileAgentScopes({ db });
      expect(report.stopped).toEqual([expect.objectContaining({ unit: runner.unit, reason: "native_owner_run_cancelled" })]);
      expect(await waitUntil(() => !alive(runner.pid))).toBe(true);
    });

    it("native runner whose run belongs to another company than its record names is stopped", async () => {
      const native = await seedNativeRun();
      await setRunStatus(native.runId, "failed");
      const runner = launchEarlier(mode, { kind: "runner", id: native.runnerInstanceId, companyId: randomUUID() }, "exec /bin/sleep 300");
      const report = await reconcileAgentScopes({ db });
      expect(report.pending).toEqual([]);
      expect(report.stopped).toEqual([
        expect.objectContaining({ unit: runner.unit, ownerKind: "runner", reason: "native_owner_company_mismatch" }),
      ]);
      expect(await waitUntil(() => !alive(runner.pid))).toBe(true);
    });

    it("warm ACP provider: an earlier server's is stopped, this server's own is left to its owner", async () => {
      const companyId = randomUUID();
      const earlier = launchEarlier(mode, { kind: "warm_provider", id: `acp-${randomUUID()}`, companyId }, "exec /bin/sleep 300");
      const policy = createSystemdIsolationPolicy({
        slice: systemd.slice,
        instanceId,
        registryDir,
        userBusAddress: systemd.userBusAddress,
        helperPath: mode === "scope" ? systemd.helper : "/nonexistent/paperclip-scope-exec",
      });
      const current = spawnIsolated(
        { command: "/bin/sleep", args: ["300"], options: { stdio: "ignore", detached: true } },
        { policy, owner: { kind: "warm_provider", id: `acp-${randomUUID()}`, companyId } },
      );
      children.add(current.child);
      owned.add(current.child.pid!);

      const report = await reconcileAgentScopes({ db });
      expect(report.stopped.map((entry) => entry.unit)).toEqual([earlier.unit]);
      expect(report.kept).toEqual([]);
      expect(await waitUntil(() => !alive(earlier.pid))).toBe(true);
      expect(alive(current.child.pid!)).toBe(true);
      expect(readScopeRecord(current.launch.record!)).not.toBeNull();
    });

    it("managed service scopes follow the runtime service row", async () => {
      const { companyId } = await seedRun({ status: "succeeded" });
      const serviceId = randomUUID();
      await db.insert(workspaceRuntimeServices).values({
        id: serviceId,
        companyId,
        scopeType: "project_workspace",
        serviceName: "web",
        status: "running",
        lifecycle: "shared",
        provider: "local_process",
      });
      const service = launchEarlier(mode, { kind: "managed_service", id: serviceId, companyId }, "exec /bin/sleep 300");
      expect((await reconcileAgentScopes({ db })).kept.map((entry) => entry.unit)).toEqual([service.unit]);
      await db.update(workspaceRuntimeServices).set({ status: "stopped" }).where(eq(workspaceRuntimeServices.id, serviceId));
      const report = await reconcileAgentScopes({ db });
      expect(report.stopped).toEqual([expect.objectContaining({ unit: service.unit, reason: "owner_service_stopped" })]);
      expect(await waitUntil(() => !alive(service.pid))).toBe(true);
    });
  });

  describe.skipIf(systemd.skipReason !== null)(`real scope only${systemd.skipReason ? ` (skipped: ${systemd.skipReason})` : ""}`, () => {
    it("crash restart: the reaper stops a dead run's surviving grandchild before the next queued run, which waits for admission", async () => {
      const file = pidFile();
      const first = await seedRun();
      const launched = launchEarlier("scope", { kind: "run", id: first.runId, companyId: first.companyId }, workload("scope", file, true));
      const leftover = await readPid(file);
      expect(await waitUntil(() => !alive(launched.pid))).toBe(true);
      await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, first.runId));
      const next = await seedRun({ status: "queued", agent: first });

      holdAgentRunAdmission();
      const heartbeat = heartbeatService(db);
      const reaped = await heartbeat.reapOrphanedRuns();
      expect(reaped.runIds).toContain(first.runId);
      expect(alive(leftover)).toBe(false);
      expect(recorded(launched.unit)).toBe(false);
      const waiting = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, next.runId)).then((rows) => rows[0]!);
      expect(waiting.status).toBe("queued");
      expect(providerExecute).not.toHaveBeenCalled();

      await reconcileAgentScopes({ db });
      expect(isAgentRunAdmissionOpen()).toBe(true);
    });

    it("server killed after the intent, before the spawn callback: the enrolled scope is stopped", async () => {
      const file = pidFile();
      const { runId, companyId } = await seedRun();
      const launched = launchEarlier("scope", { kind: "run", id: runId, companyId }, workload("scope", file));
      const leftover = await readPid(file);
      // The manifest as the server left it: intent only, no PID.
      const record = readScopeRecord({ registryDir, unit: launched.unit })!;
      writeScopeManifest(registryDir, { ...record.manifest, state: "intent", pid: null, pidStartTime: null });

      const report = await reconcileAgentScopes({ db });
      expect(report.stopped).toEqual([expect.objectContaining({ unit: launched.unit, reason: "partial_launch", outcome: "terminated" })]);
      expect(await waitUntil(() => !alive(leftover) && !alive(launched.pid))).toBe(true);
      expect(recorded(launched.unit)).toBe(false);
    });

    it("failed adoption: a run whose provider died during the swap has its leftovers stopped", async () => {
      const file = pidFile();
      const { runId, companyId } = await seedRun();
      const launched = launchEarlier("scope", { kind: "run", id: runId, companyId }, workload("scope", file, true));
      const leftover = await readPid(file);
      expect(await waitUntil(() => !alive(launched.pid))).toBe(true);
      await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, runId));

      await writeHotRestartIntent({ previousServerPid: process.pid, previousServerVersion: "old-version" });
      await heartbeatService(db).prepareHotRestartShutdown("SIGTERM");
      const newServer = heartbeatService(db, { adoptedRunLeftoverSweep: { sweep: vi.fn(async () => null) } });
      const adoption = await newServer.reconcileHotRestartAdoption();
      expect(adoption).toMatchObject({ lostRunIds: [runId] });
      await newServer.waitForAdoptedRunSweeps();
      expect(await waitUntil(() => !alive(leftover))).toBe(true);
      expect(recorded(launched.unit)).toBe(false);
    });
  });

  it("reused PID: a degraded record never signals the process that now has its PID", async () => {
    const { runId, companyId } = await seedRun({ status: "cancelled" });
    const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    children.add(bystander);
    const manifest = manifestFor(instanceId, { kind: "run", id: runId, companyId }, {
      pid: bystander.pid!,
      pidStartTime: "1",
      preflight: { outcome: "degraded", reason: "helper_missing" },
    });
    writeScopeManifest(registryDir, manifest);
    const report = await reconcileAgentScopes({ db });
    expect(report.stopped).toEqual([expect.objectContaining({ unit: manifest.unit, outcome: "already_empty" })]);
    expect(alive(bystander.pid!)).toBe(true);
  });

  it("cleanup that cannot be verified (no usable manager or cgroup) stays pending and keeps the record", async () => {
    const { runId, companyId } = await seedRun({ status: "failed" });
    const bystander = spawn("/bin/sleep", ["300"], { stdio: "ignore" });
    children.add(bystander);
    // The helper was stopped mid-enrollment: no status, a scope may exist.
    const cgroupRoot = path.join(home, "cgroup");
    const manifest = manifestFor(instanceId, { kind: "run", id: runId, companyId });
    manifest.expectedCgroup = `/user.slice/user-1000.slice/user@1000.service/app.slice/app-agents.slice/${manifest.unit}`;
    writeScopeManifest(registryDir, manifest);
    // A scope directory that reports members whose membership cannot be
    // confirmed, and a kill file that changes nothing.
    const scopeDir = path.join(cgroupRoot, manifest.expectedCgroup);
    mkdirSync(scopeDir, { recursive: true });
    writeFileSync(path.join(scopeDir, "cgroup.events"), "populated 1\nfrozen 0\n");
    writeFileSync(path.join(scopeDir, "cgroup.procs"), `${bystander.pid}\n`);
    setAgentScopeRegistryForTests({ instanceId, registryDir, graceMs: 100, killWaitMs: 300, cgroupRoot });

    const report = await reconcileAgentScopes({ db });
    expect(report.stopped).toEqual([]);
    expect(report.pending).toEqual([expect.objectContaining({ unit: manifest.unit, reason: "owner_run_failed:scope_not_empty" })]);
    expect(recorded(manifest.unit)).toBe(true);
    expect(alive(bystander.pid!)).toBe(true);
    await fs.rm(path.join(registryDir, `${manifest.unit}.json`), { force: true });
  });

  it("an unreadable record is reported as pending, never as an empty scope", async () => {
    const manifest = manifestFor(instanceId, { kind: "run", id: randomUUID(), companyId: null });
    writeScopeManifest(registryDir, manifest);
    writeFileSync(path.join(registryDir, `${manifest.unit}.json`), "{broken");
    const report = await reconcileAgentScopes({ db });
    expect(report.pending).toEqual([{ unit: manifest.unit, ownerKind: null, reason: "record_unreadable" }]);
    await fs.rm(path.join(registryDir, `${manifest.unit}.json`), { force: true });
  });

  /** Write a record whose manifest cannot be read, for this owner. */
  function writeUnreadableRecord(owner: { kind: ProcessOwnerKind; id: string; companyId: string | null }): string {
    const manifest = manifestFor(instanceId, owner);
    writeScopeManifest(registryDir, manifest);
    writeFileSync(path.join(registryDir, `${manifest.unit}.json`), "{broken");
    return manifest.unit;
  }

  it("cancel with an unreadable record of the run reports cleanup unconfirmed; another owner's is not counted", async () => {
    const file = pidFile();
    const { runId, companyId } = await seedRun();
    const launched = launchEarlier("degraded", { kind: "run", id: runId, companyId }, workload("degraded", file));
    const leftover = await readPid(file);
    await db.update(heartbeatRuns).set({ processPid: launched.pid, processGroupId: launched.pid }).where(eq(heartbeatRuns.id, runId));
    const mine = writeUnreadableRecord({ kind: "run", id: runId, companyId });
    const mineWithoutCompany = writeUnreadableRecord({ kind: "run", id: runId, companyId: null });
    const theirs = writeUnreadableRecord({ kind: "run", id: randomUUID(), companyId });

    const cancelled = await heartbeatService(db).cancelRun(runId, "Stopped by the operator");
    expect(cancelled?.status).toBe("cancelled");
    expect(await waitUntil(() => !alive(leftover) && !alive(launched.pid))).toBe(true);
    const cleanup = (cancelled?.resultJson as Record<string, unknown> | null)?.agentScopeCleanup as
      | { confirmed: boolean; results: Array<{ unit: string; reason: string }> }
      | undefined;
    expect(cleanup?.confirmed).toBe(false);
    expect(cleanup?.results).toEqual(expect.arrayContaining([
      { unit: mine, ownerKind: null, reason: "record_unreadable" },
      { unit: mineWithoutCompany, ownerKind: null, reason: "record_unreadable" },
    ]));
    expect(cleanup?.results.map((entry) => entry.unit)).not.toContain(theirs);

    // Only another owner's unreadable record: this owner's cleanup is settled.
    const other = await terminateInheritedOwnerScopes({ ownerKinds: ["run"], ownerId: randomUUID(), companyId, reason: "test" });
    expect(other).toEqual({ found: 0, settled: true, results: [] });
  });

  it("shutdown reports unreadable records as pending, never as closed", async () => {
    const unit = writeUnreadableRecord({ kind: "auxiliary", id: randomUUID(), companyId: null });
    for (const handOff of [true, false]) {
      const report = await closeAgentScopesForShutdown({ handOff, graceMs: 100 });
      expect(report.pending).toEqual([{ unit, ownerKind: null, reason: "record_unreadable" }]);
      expect(report.stopped).toEqual([]);
    }
  });

  describe("run admission", () => {
    it("waits for scope classification; a failed pass keeps it held and no provider starts", async () => {
      const { companyId, agentId, runId } = await seedRun({ status: "queued" });
      const heartbeat = heartbeatService(db);
      holdAgentRunAdmission();
      expect(isAgentRunAdmissionOpen()).toBe(false);
      expect(await heartbeat.resumeQueuedRunsForAgent(companyId, agentId)).toEqual([]);
      await heartbeat.resumeQueuedRuns();

      // The registry cannot be listed: the pass fails and admission stays held.
      const notADirectory = path.join(home, "not-a-directory");
      writeFileSync(notADirectory, "");
      setAgentScopeRegistryForTests({ instanceId, registryDir: notADirectory });
      await expect(reconcileAgentScopes({ db })).rejects.toThrow();
      expect(isAgentRunAdmissionOpen()).toBe(false);
      expect(await heartbeat.resumeQueuedRunsForAgent(companyId, agentId)).toEqual([]);
      const held = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
      expect(held.status).toBe("queued");
      expect(providerExecute).not.toHaveBeenCalled();

      setAgentScopeRegistryForTests({ instanceId, registryDir });
      await reconcileAgentScopes({ db });
      expect(isAgentRunAdmissionOpen()).toBe(true);
      await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
      await heartbeat.drainActiveRunExecutions();
      const started = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
      expect(started.status).not.toBe("queued");
      expect(providerExecute).toHaveBeenCalled();
    });

    it("a run already claimed by restart recovery waits; shutdown releases it without admitting it", async () => {
      holdAgentRunAdmission();
      const opened = waitForAgentRunAdmission();
      await reconcileAgentScopes({ db });
      expect(await opened).toBe(true);

      resetAgentRunAdmissionForTests();
      holdAgentRunAdmission();
      const released = waitForAgentRunAdmission();
      abandonHeldAgentRunAdmission();
      expect(await released).toBe(false);
      expect(isAgentRunAdmissionOpen()).toBe(false);
    });

    it("a pass that started before admission was held does not open it", async () => {
      const slow = reconcileAgentScopes({ db });
      holdAgentRunAdmission();
      await slow;
      const second = reconcileAgentScopes({ db });
      expect(second).not.toBe(slow);
      await second;
      expect(isAgentRunAdmissionOpen()).toBe(true);
    });
  });
});
