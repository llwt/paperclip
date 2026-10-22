// Fork-only install smoke check. Heartbeat and MCP checks remain manual.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const INSTALL_JSON = "/home/steven-bot/.paperclip/cli/install.json";
const CHECKS = ["health", "sha", "ui", "card"];

function detailOf(error, apiKey) {
  const message = error instanceof Error ? error.message : String(error);
  return (apiKey ? message.replaceAll(apiKey, "[redacted]") : message).replace(/\s+/g, " ");
}

function createClient({ apiUrl, apiKey, runId }) {
  const base = new URL(apiUrl.replace(/\/$/, "").replace(/\/api$/, ""));
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("PAPERCLIP_API_URL must be an HTTP URL without credentials");
  }
  return async (path, { method = "GET", body } = {}) => {
    const headers = {};
    if (path.startsWith("/api/")) {
      headers.Authorization = `Bearer ${apiKey}`;
      if (runId) headers["X-Paperclip-Run-Id"] = runId;
    }
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(new URL(path, base), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (response.status !== 200 && !(method === "POST" && response.status === 201)) {
      await response.body?.cancel();
      throw new Error(`${method} ${path}: HTTP ${response.status}`);
    }
    return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
  };
}

export async function checkHealth(request) {
  const response = await request("/api/health");
  if (response.status !== 200 || JSON.parse(response.text).status !== "ok") {
    throw new Error("health status is not ok");
  }
  return "HTTP 200, status ok";
}

export async function checkSha(installJson, expectedSha) {
  const installed = JSON.parse(await readFile(installJson, "utf8"));
  if (installed.sha !== expectedSha) throw new Error("install.json sha does not match expected SHA");
  return `installed SHA matches ${expectedSha}`;
}

export async function checkUi(request) {
  const response = await request("/");
  if (response.status !== 200 || !/^text\/html\b/i.test(response.contentType ?? "") || !/<html\b/i.test(response.text)) {
    throw new Error("root response is not HTML");
  }
  const assets = new Set();
  for (const tag of response.text.matchAll(/<script\b[^>]*>/gi)) {
    const src = tag[0].match(/\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const path = src?.[1] ?? src?.[2] ?? src?.[3];
    if (path && /^\/assets\/[^?#]+\.js(?:[?#].*)?$/.test(path)) assets.add(path);
  }
  if (assets.size === 0) throw new Error("no JavaScript asset referenced");
  for (const path of assets) {
    const asset = await request(path);
    if (asset.status !== 200) throw new Error(`${path}: HTTP ${asset.status}`);
  }
  return `HTML and ${assets.size} JavaScript asset(s) returned HTTP 200`;
}

export async function checkCard(request, companyId) {
  let issueId;
  let failure;
  try {
    const created = JSON.parse((await request(`/api/companies/${encodeURIComponent(companyId)}/issues`, {
      method: "POST",
      body: { title: `smoke check ${new Date().toISOString()}`, status: "todo", assigneeAgentId: null, assigneeUserId: null },
    })).text);
    if (!created.id) throw new Error("created task has no id");
    issueId = created.id;
    const path = `/api/issues/${encodeURIComponent(issueId)}`;
    const interaction = JSON.parse((await request(`${path}/interactions`, {
      method: "POST",
      body: {
        kind: "request_confirmation",
        resolverPolicy: "anyone",
        continuationPolicy: "none",
        payload: { version: 1, prompt: "Accept this throwaway smoke check?" },
      },
    })).text);
    if (!interaction.id) throw new Error("created interaction has no id");
    await request(`${path}/interactions/${encodeURIComponent(interaction.id)}/accept`, { method: "POST", body: {} });
    const interactions = JSON.parse((await request(`${path}/interactions`)).text);
    if (!Array.isArray(interactions) || !interactions.some((item) => item.id === interaction.id && item.status === "accepted")) {
      throw new Error("interaction was not read back as accepted");
    }
  } catch (error) {
    failure = error;
  } finally {
    if (issueId) {
      try {
        await request(`/api/issues/${encodeURIComponent(issueId)}`, { method: "PATCH", body: { status: "cancelled" } });
      } catch (error) {
        failure = new Error(`${failure ? `${failure.message}; ` : ""}cleanup failed for task ${issueId}: ${error.message}`);
      }
    }
  }
  if (failure) throw failure;
  return `confirmation accepted and task ${issueId} cancelled`;
}

export async function runSmokeChecks({ expectedSha, installJson = INSTALL_JSON, env = process.env }) {
  for (const name of ["PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID"]) {
    if (!env[name]) throw new Error(`missing ${name}`);
  }
  if (!/^[a-f\d]{40}$/i.test(expectedSha ?? "")) throw new Error("--sha must be a full 40-character commit SHA");
  const request = createClient({ apiUrl: env.PAPERCLIP_API_URL, apiKey: env.PAPERCLIP_API_KEY, runId: env.PAPERCLIP_RUN_ID });
  const checks = [
    () => checkHealth(request),
    () => checkSha(installJson, expectedSha),
    () => checkUi(request),
    () => checkCard(request, env.PAPERCLIP_COMPANY_ID),
  ];
  const results = {};
  for (const [index, name] of CHECKS.entries()) {
    try {
      results[name] = { pass: true, detail: detailOf(await checks[index](), env.PAPERCLIP_API_KEY) };
    } catch (error) {
      results[name] = { pass: false, detail: detailOf(error, env.PAPERCLIP_API_KEY) };
    }
  }
  return results;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let json = args.includes("--json");
  let results;
  try {
    const { values } = parseArgs({ args, options: { sha: { type: "string" }, json: { type: "boolean" }, "install-json": { type: "string" } } });
    json = values.json ?? false;
    results = await runSmokeChecks({ expectedSha: values.sha, installJson: values["install-json"], env });
  } catch (error) {
    results = Object.fromEntries(CHECKS.map((name) => [name, { pass: false, detail: detailOf(error, env.PAPERCLIP_API_KEY) }]));
  }
  console.log(json ? JSON.stringify(results) : CHECKS.map((name) => `${results[name].pass ? "PASS" : "FAIL"} ${name}: ${results[name].detail}`).join("\n"));
  return CHECKS.every((name) => results[name].pass) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
