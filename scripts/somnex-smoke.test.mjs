import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runSmokeChecks } from "./somnex-smoke.mjs";

const SHA = "a".repeat(40);
const API_KEY = "synthetic-smoke-key";
const runFile = promisify(execFile);
const scriptPath = new URL("./somnex-smoke.mjs", import.meta.url);

async function fixture(t, { failPath, hangPath, pending = false, failCleanup = false, health = "ok", noAssets = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "somnex-smoke-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installJson = join(dir, "install.json");
  await writeFile(installJson, JSON.stringify({ sha: SHA }));
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: req.url, method: req.method, body, headers: req.headers });
    const json = (value, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === hangPath) {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    } else if (req.url === failPath || (failCleanup && req.method === "PATCH")) {
      json({ error: API_KEY }, 500);
    } else if (req.url === "/api/health") {
      json({ status: health });
    } else if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(noAssets ? '<!doctype html><html><body>No bundle</body></html>' : '<!doctype html><html><script type="module" src="/assets/main.js"></script><script src=\'/assets/other.js?v=1\'></script><script src=/assets/unquoted.js></script></html>');
    } else if (req.url.startsWith("/assets/")) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end("export default true;");
    } else if (req.url === "/api/companies/company-1/issues" && req.method === "POST") {
      json({ id: "task-1" }, 201);
    } else if (req.url === "/api/issues/task-1/interactions" && req.method === "POST") {
      json({ id: "card-1", status: "pending" }, 201);
    } else if (req.url === "/api/issues/task-1/interactions/card-1/accept" && req.method === "POST") {
      json({ id: "card-1", status: "accepted" });
    } else if (req.url === "/api/issues/task-1/interactions" && req.method === "GET") {
      json([{ id: "card-1", status: pending ? "pending" : "accepted" }]);
    } else if (req.url === "/api/issues/task-1" && req.method === "PATCH") {
      json({ id: "task-1", status: "cancelled" });
    } else {
      json({ error: "unexpected request" }, 404);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const env = {
    PAPERCLIP_API_URL: `http://127.0.0.1:${server.address().port}/api/`,
    PAPERCLIP_API_KEY: API_KEY,
    PAPERCLIP_COMPANY_ID: "company-1",
    PAPERCLIP_RUN_ID: "run-1",
  };
  return { calls, env, installJson, expectedSha: SHA };
}

function assertCancelled(calls) {
  const last = calls.at(-1);
  assert.equal(last.path, "/api/issues/task-1");
  assert.equal(last.method, "PATCH");
  assert.deepEqual(last.body, { status: "cancelled" });
}

test("all checks pass against a local fake server and temp install.json", async (t) => {
  const options = await fixture(t);
  const results = await runSmokeChecks(options);
  assert.deepEqual(Object.keys(results), ["health", "sha", "ui", "card"]);
  assert.ok(Object.values(results).every((result) => result.pass));
  assert.equal(options.calls.filter((call) => call.path.startsWith("/assets/")).length, 3);
  const created = options.calls.find((call) => call.path === "/api/companies/company-1/issues");
  assert.match(created.body.title, /^smoke check \d{4}-\d\d-\d\dT/);
  assert.equal(created.body.status, "todo");
  assert.equal(created.body.assigneeAgentId, null);
  assert.equal(created.body.assigneeUserId, null);
  const card = options.calls.find((call) => call.method === "POST" && call.path.endsWith("/interactions"));
  assert.equal(card.body.kind, "request_confirmation");
  assert.equal(card.body.resolverPolicy, "anyone");
  assert.equal(card.body.continuationPolicy, "none");
  assert.equal(card.body.payload.version, 1);
  for (const call of options.calls.filter((call) => call.path.startsWith("/api/"))) {
    assert.equal(call.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(call.headers["x-paperclip-run-id"], "run-1");
  }
  assertCancelled(options.calls);
});

test("wrong SHA fails only sha", async (t) => {
  const options = await fixture(t);
  const results = await runSmokeChecks({ ...options, expectedSha: "b".repeat(40) });
  assert.equal(results.sha.pass, false);
  assert.ok(results.health.pass && results.ui.pass && results.card.pass);
});

test("HTTP 500 on a JavaScript asset fails ui and still runs card", async (t) => {
  const options = await fixture(t, { failPath: "/assets/other.js?v=1" });
  const results = await runSmokeChecks(options);
  assert.equal(results.ui.pass, false);
  assert.match(results.ui.detail, /HTTP 500/);
  assert.equal(results.card.pass, true);
});

test("HTML without a JavaScript asset fails ui and still runs card", async (t) => {
  const options = await fixture(t, { noAssets: true });
  const results = await runSmokeChecks(options);
  assert.equal(results.ui.pass, false);
  assert.equal(results.ui.detail, "no JavaScript asset referenced");
  assert.ok(results.health.pass && results.sha.pass && results.card.pass);
  assertCancelled(options.calls);
});

test("a failed accept call fails card and still cancels the throwaway task", async (t) => {
  const options = await fixture(t, { failPath: "/api/issues/task-1/interactions/card-1/accept" });
  const results = await runSmokeChecks(options);
  assert.equal(results.card.pass, false);
  assert.match(results.card.detail, /accept: HTTP 500/);
  assertCancelled(options.calls);
  assert.ok(!JSON.stringify(results).includes(API_KEY));
});

test("a failed interaction creation still cancels the task", async (t) => {
  const options = await fixture(t, { failPath: "/api/issues/task-1/interactions" });
  const results = await runSmokeChecks(options);
  assert.equal(results.card.pass, false);
  assertCancelled(options.calls);
});

test("a stalled accept response times out and still cancels the task", { timeout: 25_000 }, async (t) => {
  const options = await fixture(t, { hangPath: "/api/issues/task-1/interactions/card-1/accept" });
  const results = await runSmokeChecks(options);
  assert.equal(results.card.pass, false);
  assert.match(results.card.detail, /abort|timeout/i);
  assertCancelled(options.calls);
});

test("card must be read back as accepted", async (t) => {
  const options = await fixture(t, { pending: true });
  const results = await runSmokeChecks(options);
  assert.equal(results.card.pass, false);
  assert.match(results.card.detail, /not read back as accepted/);
  assertCancelled(options.calls);
});

test("cleanup failure fails card and identifies the leftover task", async (t) => {
  const options = await fixture(t, { failCleanup: true });
  const results = await runSmokeChecks(options);
  assert.equal(results.card.pass, false);
  assert.match(results.card.detail, /cleanup failed for task task-1/);
});

test("health requires status ok", async (t) => {
  const options = await fixture(t, { health: "degraded" });
  const results = await runSmokeChecks(options);
  assert.equal(results.health.pass, false);
});

test("CLI prints four PASS lines and exits 0", async (t) => {
  const options = await fixture(t);
  const { stdout, stderr } = await runFile(process.execPath, [scriptPath.pathname, "--sha", SHA, "--install-json", options.installJson], { env: options.env });
  assert.equal(stderr, "");
  assert.deepEqual(stdout.trim().split("\n").map((line) => line.split(":")[0]), ["PASS health", "PASS sha", "PASS ui", "PASS card"]);
  assert.ok(!stdout.includes(API_KEY));
});

test("CLI --json prints one object and exits 1 when any check fails", async (t) => {
  const options = await fixture(t);
  await assert.rejects(runFile(process.execPath, [scriptPath.pathname, "--sha", "b".repeat(40), "--install-json", options.installJson, "--json"], { env: options.env }), (error) => {
    assert.equal(error.code, 1);
    assert.equal(error.stderr, "");
    const results = JSON.parse(error.stdout);
    assert.equal(results.sha.pass, false);
    assert.ok(results.health.pass && results.ui.pass && results.card.pass);
    assert.equal(error.stdout.trim().split("\n").length, 1);
    assert.ok(!error.stdout.includes(API_KEY));
    return true;
  });
});

test("CLI rejects missing SHA without HTTP calls or leaking the API key", async (t) => {
  const options = await fixture(t);
  await assert.rejects(runFile(process.execPath, [scriptPath.pathname, "--json"], { env: options.env }), (error) => {
    assert.equal(error.code, 1);
    assert.ok(Object.values(JSON.parse(error.stdout)).every((result) => !result.pass));
    assert.ok(!error.stdout.includes(API_KEY));
    return true;
  });
  assert.equal(options.calls.length, 0);
});
