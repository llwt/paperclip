import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

const script = new URL("../with-storybook.mjs", import.meta.url).href;
const fixture = `
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
writeFileSync('started.json', JSON.stringify({ args, cwd: process.cwd() }));
if (process.env.FIXTURE_MODE === 'exit') process.exit(2);
if (process.env.FIXTURE_MODE === 'stubborn') {
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
  child.stdout.once('data', () => writeFileSync('descendant.pid', String(child.pid)));
}
const port = Number(args[args.indexOf('-p') + 1]);
createServer((req, res) => {
  res.writeHead(process.env.FIXTURE_MODE === 'timeout' ? 503 : 200).end('{}');
}).listen(port, '127.0.0.1');
`;

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "with-storybook-test-"));
  await writeFile(join(dir, "storybook.mjs"), fixture);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return { dir, port };
}

function run(t, { dir, port }, command, mode = "", timeoutMs = 2000) {
  const options = { cwd: dir, storybookBin: join(dir, "storybook.mjs"), timeoutMs, graceMs: 200 };
  const code = `import { withStorybook } from ${JSON.stringify(script)};
    try { process.exitCode = await withStorybook(...JSON.parse(process.argv[1])); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code, JSON.stringify([port, command, options])], {
    env: { ...process.env, FIXTURE_MODE: mode }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const done = once(child, "exit").then(([code]) => ({ code, output }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await done;
  });
  return { child, done, output: () => output };
}

async function until(check) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail("Timed out waiting for fixture");
}

async function assertPortFree(port) {
  const server = createServer();
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  await new Promise((resolve) => server.close(resolve));
}

test("runs the command with its URL, exact arguments, and exit code; frees the port", async (t) => {
  const ctx = await setup(t);
  const result = await run(t, ctx, [process.execPath, "-e", "console.log(process.env.STORYBOOK_URL, process.argv[1]); process.exit(7)", "one argument"]).done;
  assert.equal(result.code, 7, result.output);
  assert.match(result.output, new RegExp(`http://127.0.0.1:${ctx.port} one argument`));
  const started = JSON.parse(await readFile(join(ctx.dir, "started.json"), "utf8"));
  assert.deepEqual(started, { cwd: ctx.dir, args: ["dev", "--exact-port", "--ci", "--no-open", "--host", "127.0.0.1", "-c", "storybook/.storybook", "-p", String(ctx.port)] });
  await assertPortFree(ctx.port);
});

test("rejects an occupied port before spawning Storybook", async (t) => {
  const ctx = await setup(t);
  const occupied = createServer();
  occupied.listen(ctx.port, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const result = await run(t, ctx, [process.execPath, "-e", "process.exit(0)"]).done;
  assert.equal(result.code, 1);
  assert.match(result.output, /port is already in use/);
  await assert.rejects(readFile(join(ctx.dir, "started.json")), { code: "ENOENT" });
});

for (const mode of ["exit", "timeout"]) {
  test(`cleans up on readiness ${mode} and never runs the command`, async (t) => {
    const ctx = await setup(t);
    const result = await run(t, ctx, [process.execPath, "-e", "console.log('INNER RAN')"], mode, 400).done;
    assert.equal(result.code, 1);
    assert.match(result.output, mode === "exit" ? /Storybook exited unexpectedly/ : /Timed out/);
    assert.doesNotMatch(result.output, /INNER RAN/);
    await assertPortFree(ctx.port);
  });
}

test("cleans up when command spawn fails", async (t) => {
  const ctx = await setup(t);
  const result = await run(t, ctx, [join(ctx.dir, "missing-command")]).done;
  assert.equal(result.code, 1);
  assert.match(result.output, /ENOENT/);
  await assertPortFree(ctx.port);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  for (const phase of ["readiness", "command"]) {
    test(`${signal} during ${phase} stops server and command`, async (t) => {
      const ctx = await setup(t);
      const job = run(t, ctx, [process.execPath, "-e", "console.log('INNER STARTED'); setInterval(() => {}, 1000)"], phase === "readiness" ? "timeout" : "");
      await until(async () => phase === "command" ? job.output().includes("INNER STARTED") : readFile(join(ctx.dir, "started.json")).then(() => true, () => false));
      job.child.kill(signal);
      const result = await job.done;
      assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.output);
      await assertPortFree(ctx.port);
    });
  }
}

test("kills a stubborn descendant even after its group leader exits", async (t) => {
  const ctx = await setup(t);
  const job = run(t, ctx, [process.execPath, "-e", "setTimeout(() => {}, 300)"], "stubborn");
  await until(() => readFile(join(ctx.dir, "descendant.pid")).then(() => true, () => false));
  const pid = Number(await readFile(join(ctx.dir, "descendant.pid"), "utf8"));
  assert.equal((await job.done).code, 0);
  await until(async () => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
    } catch (error) {
      if (error.code === "ENOENT") return true;
      throw error;
    }
  });
  await assertPortFree(ctx.port);
});
