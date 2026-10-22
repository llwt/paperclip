import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { classifyGitInvocation, githubBrokerEnvironment, githubLauncherSource } from "./github-launcher.js";
const exec = promisify(execFile);
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const needsBroker = (...args: string[]) => classifyGitInvocation(args).needsBroker;

describe("git broker decision", () => {
  it.each([
    ["status"], ["diff", "HEAD"], ["diff-tree", "-r", "HEAD"], ["diff-index", "HEAD"], ["diff-files"], ["range-diff", "a...b"],
    ["log", "--oneline", "-1"], ["shortlog", "-s"], ["show", "HEAD"], ["show-ref"], ["show-branch"], ["rev-parse", "HEAD"],
    ["rev-list", "--count", "HEAD"], ["ls-files"], ["ls-tree", "HEAD"], ["cat-file", "-t", "HEAD"], ["merge-base", "a", "b"],
    ["for-each-ref"], ["symbolic-ref", "HEAD"], ["update-ref", "refs/heads/x", "HEAD"], ["describe", "--always"],
    ["name-rev", "HEAD"], ["blame", "file"], ["annotate", "file"], ["grep", "x"], ["check-ignore", "x"], ["check-attr", "-a", "x"],
    ["check-ref-format", "--branch", "x"], ["hash-object", "x"], ["count-objects"], ["reflog"], ["config", "user.name"],
    ["config", "--get", "remote.origin.url"], ["version"], ["help", "push"], ["init"], ["add", "-A"], ["rm", "x"], ["mv", "a", "b"],
    ["apply", "x.patch"], ["clean", "-fd"], ["update-index", "--refresh"], ["write-tree"], ["read-tree", "HEAD"],
    ["branch"], ["branch", "--show-current"], ["branch", "-M", "main"], ["checkout", "-b", "x"], ["switch", "x"],
    ["restore", "x"], ["reset", "--hard"], ["worktree", "list"], ["worktree", "add", "../x"], ["cherry", "main"],
    ["patch-id"], ["remote"], ["remote", "-v"], ["remote", "get-url", "origin"], ["remote", "set-url", "origin", "u"],
    ["remote", "add", "origin", "u"], ["remote", "remove", "origin"], ["remote", "show", "-n", "origin"],
    ["remote", "-v", "set-url", "--push", "origin", "u"], ["remote", "add", "--no-tags", "origin", "u"],
    ["remote", "rename", "a", "b"], ["tag"], ["tag", "-l", "v*"], ["tag", "--list"], ["tag", "v*", "-l"],
    ["stash", "list"], ["stash", "show", "-p"],
  ])("skips the broker for git %s", (...args) => {
    expect(needsBroker(...args)).toBe(false);
  });

  it.each([
    ["fetch"], ["pull"], ["push"], ["clone", "https://github.com/a/b"], ["ls-remote", "origin"], ["commit", "-m", "x"],
    ["merge", "x"], ["rebase", "main"], ["cherry-pick", "x"], ["revert", "x"], ["am", "x"], ["submodule", "update"],
    ["tag", "-a", "v1", "-m", "x"], ["tag", "v1"], ["stash"], ["stash", "push"], ["stash", "pop"], ["notes", "add"],
    ["var", "GIT_AUTHOR_IDENT"], ["commit-tree", "x"], ["maintenance", "run"], ["gc"], ["remote", "update"],
    ["remote", "show", "origin"], ["remote", "add", "-f", "origin", "u"], ["remote", "prune", "origin"],
    ["co", "main"], ["st"], ["unknown-subcommand"],
  ])("calls the broker for git %s", (...args) => {
    expect(needsBroker(...args)).toBe(true);
  });

  // Review round 1: options take values and short options combine, so a form
  // is local only when every option is one the classifier knows.
  it.each([
    ["remote", "add", "-ft", "main", "origin", "u"], ["remote", "add", "-f", "-t", "main", "origin", "u"],
    ["remote", "add", "-t", "main", "origin", "u"], ["remote", "add", "origin", "u", "--fetch"],
    ["remote", "add", "--mirror=fetch", "origin", "u"], ["remote", "set-url", "-f", "origin", "u"],
    ["remote", "show", "origin", "-x"], ["remote", "--verbose", "update"],
    ["tag", "-m", "-l", "v1"], ["tag", "-a", "-l", "v1"], ["tag", "-l", "-m", "x", "v1"], ["tag", "-lm", "x"],
    ["tag", "-s", "v1"], ["tag", "--", "-l"],
  ])("calls the broker for option forms it cannot prove local: git %s", (...args) => {
    expect(needsBroker(...args)).toBe(true);
  });

  it("parses global options before the subcommand", () => {
    expect(classifyGitInvocation(["-C", "x", "status"])).toEqual({ needsBroker: false, globalArgs: ["-C", "x"], subcommand: "status" });
    expect(classifyGitInvocation(["-c", "a=b", "push"])).toMatchObject({ needsBroker: true, subcommand: "push" });
    expect(needsBroker("-c", "user.name=x", "-c", "user.email=y", "commit", "-m", "x")).toBe(true);
    expect(needsBroker("--git-dir=.git", "--work-tree=.", "--no-pager", "-P", "--bare", "--namespace", "n", "log")).toBe(false);
    expect(needsBroker("--git-dir", ".git", "--work-tree", ".", "diff")).toBe(false);
    expect(needsBroker("--exec-path=/x", "--no-optional-locks", "--literal-pathspecs", "status")).toBe(false);
    expect(needsBroker("-C", "status", "push")).toBe(true); // "status" is -C's directory
    expect(needsBroker("-C", "x", "-c", "a=b", "fetch")).toBe(true);
    expect(needsBroker("--version")).toBe(false);
    expect(needsBroker()).toBe(false);
  });

  it("calls the broker when it cannot parse the global options", () => {
    expect(needsBroker("-C")).toBe(true);
    expect(needsBroker("-Cx", "status")).toBe(true);
    expect(needsBroker("--config-env", "a=B", "status")).toBe(true);
    expect(needsBroker("--some-future-option", "status")).toBe(true);
  });
});

describe("staged launcher against a stub broker", () => {
  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-github-broker-decision-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, "managed");
    await mkdir(bin);
    for (const name of ["git", "gh"]) await writeFile(path.join(bin, name), githubLauncherSource(), { mode: 0o700 });
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "available", env: {
        GH_TOKEN: "managed-token", GITHUB_TOKEN: "managed-token", PAPERCLIP_GIT_TOKEN: "managed-token",
        GIT_AUTHOR_NAME: "Managed", GIT_AUTHOR_EMAIL: "managed@example.test",
        GIT_COMMITTER_NAME: "Managed", GIT_COMMITTER_EMAIL: "managed@example.test",
      } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
    const { port } = server.address() as { port: number };
    // Leaked host credentials must not survive into any child, skipped or not.
    const env = (extraPath = "") => ({
      ...process.env,
      ...githubBrokerEnvironment({}, { url: `http://127.0.0.1:${port}`, token: "run-capability" }),
      GH_TOKEN: "host-token", GITHUB_TOKEN: "host-token", PAPERCLIP_GIT_TOKEN: "host-token",
      GH_CONFIG_DIR: path.join(root, "gh-config"),
      PATH: `${bin}:${extraPath}${process.env.PATH}`,
    });
    return { root, bin, env, calls: () => calls };
  }

  it("makes no broker call for a local sequence and one for each push and fetch", async () => {
    const { root, bin, env, calls } = await fixture();
    const origin = path.join(root, "origin.git"), repo = path.join(root, "repo");
    await exec("git", ["init", "--bare", "-q", origin]);
    await exec("git", ["init", "-q", repo]);
    await exec("git", ["-C", repo, "config", "user.name", "Local"]);
    await exec("git", ["-C", repo, "config", "user.email", "local@example.test"]);
    await exec("git", ["-C", repo, "remote", "add", "origin", origin]);
    await exec("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", "base"]);
    await writeFile(path.join(repo, "file.txt"), "work\n");
    const git = (...args: string[]) => exec(path.join(bin, "git"), args, { cwd: repo, env: env() });
    for (const args of [["rev-parse", "HEAD"], ["status", "--porcelain"], ["diff"], ["log", "--oneline", "-1"], ["add", "file.txt"],
      ["-C", repo, "status"], ["branch", "--show-current"], ["remote", "get-url", "origin"]]) await git(...args);
    expect(calls()).toBe(0);
    await git("push", "-q", "origin", "HEAD:refs/heads/main");
    expect(calls()).toBe(1);
    await git("fetch", "-q", "origin");
    expect(calls()).toBe(2);
    await git("commit", "-q", "-m", "work");
    expect(calls()).toBe(3);
    expect((await git("log", "-1", "--format=%an")).stdout.trim()).toBe("Managed");
    expect(calls()).toBe(3);
  });

  it("gives a skipped command no credential and keeps the broker for gh, network git and partial clones", async () => {
    const { root, bin, env, calls } = await fixture();
    const realBin = path.join(root, "real");
    await mkdir(realBin);
    // Stands in for the real binaries: reports what credentials it received.
    const report = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--get-regexp')) process.exit(process.env.FAKE_PROMISOR === '1' ? 0 : 1);
const keys = ['GH_TOKEN', 'GITHUB_TOKEN', 'PAPERCLIP_GIT_TOKEN', 'GH_ENTERPRISE_TOKEN', 'SSH_AUTH_SOCK', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_VALUE_0', 'GIT_ASKPASS'];
process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]))));
`;
    for (const name of ["git", "gh"]) await writeFile(path.join(realBin, name), report, { mode: 0o700 });
    const run = async (program: string, args: string[], extra: Record<string, string> = {}) =>
      JSON.parse((await exec(path.join(bin, program), args, { cwd: root, env: { ...env(`${realBin}:`), ...extra } })).stdout);
    const sanitised = { SSH_AUTH_SOCK: "", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "5", GIT_CONFIG_VALUE_0: "", GIT_ASKPASS: null, GH_ENTERPRISE_TOKEN: null };
    for (const args of [["status"], ["rev-parse", "HEAD"], ["-C", root, "diff"], ["log"], ["add", "."]]) {
      expect(await run("git", args)).toEqual({ GH_TOKEN: null, GITHUB_TOKEN: null, PAPERCLIP_GIT_TOKEN: null, ...sanitised });
    }
    expect(calls()).toBe(0);
    expect(await run("git", ["push"])).toMatchObject({ GH_TOKEN: "managed-token", PAPERCLIP_GIT_TOKEN: "managed-token" });
    expect(calls()).toBe(1);
    expect(await run("gh", ["pr", "list"])).toMatchObject({ GH_TOKEN: "managed-token" });
    expect(calls()).toBe(2);
    expect(await run("git", ["status"], { FAKE_PROMISOR: "1" })).toMatchObject({ GH_TOKEN: "managed-token" });
    expect(calls()).toBe(3);
  });

  it("treats a real partial clone as needing the broker for local commands", async () => {
    const { root, bin, env, calls } = await fixture();
    const repo = path.join(root, "repo");
    await exec("git", ["init", "-q", repo]);
    const git = (...args: string[]) => exec(path.join(bin, "git"), args, { cwd: repo, env: env() });
    await git("status");
    expect(calls()).toBe(0);
    await exec("git", ["-C", repo, "config", "remote.origin.promisor", "true"]);
    await git("status");
    expect(calls()).toBe(1);
  });

  it("keeps the broker when a full parent recurses into a partial-clone submodule", async () => {
    const { root, bin, env, calls } = await fixture();
    const origin = path.join(root, "sub-origin"), parent = path.join(root, "parent"), sub = path.join(parent, "sub");
    const setup = (...args: string[]) => exec("git", ["-c", "user.name=Setup", "-c", "user.email=setup@example.test", "-c", "protocol.file.allow=always", ...args]);
    await setup("init", "-q", origin);
    await setup("-C", origin, "config", "uploadpack.allowFilter", "true");
    await writeFile(path.join(origin, "data.txt"), "old content\n");
    await setup("-C", origin, "add", "data.txt");
    await setup("-C", origin, "commit", "-q", "-m", "old");
    const oldCommit = (await setup("-C", origin, "rev-parse", "HEAD")).stdout.trim();
    await writeFile(path.join(origin, "data.txt"), "new content\n");
    await setup("-C", origin, "commit", "-q", "-am", "new");
    // The parent is a full repository; only the submodule is a partial clone,
    // so the old blob is missing there and checkout must fetch it.
    await setup("init", "-q", parent);
    await setup("clone", "-q", "--filter=blob:none", `file://${origin}`, sub);
    await setup("-C", parent, "submodule", "add", "-q", `file://${origin}`, "sub");
    await setup("-C", parent, "update-index", "--cacheinfo", `160000,${oldCommit},sub`);
    await setup("-C", parent, "commit", "-q", "-m", "submodule at old");
    await setup("-C", parent, "update-index", "--cacheinfo", `160000,${(await setup("-C", sub, "rev-parse", "HEAD")).stdout.trim()},sub`);
    await setup("-C", parent, "commit", "-q", "-m", "submodule at new");
    await expect(exec("git", ["-C", parent, "config", "--get-regexp", "^(extensions\\.partialclone|remote\\..*\\.promisor)$"])).rejects.toThrow();
    const git = (...args: string[]) => exec(path.join(bin, "git"), args, { cwd: parent, env: env() });
    await git("checkout", "-q", "--recurse-submodules", "HEAD~1");
    expect(calls()).toBe(1);
    expect(await readFile(path.join(sub, "data.txt"), "utf8")).toBe("old content\n");
  }, 20_000);

  it("keeps the broker when configuration enables submodule recursion", async () => {
    const { root, bin, env, calls } = await fixture();
    const repo = path.join(root, "repo");
    await exec("git", ["init", "-q", repo]);
    const git = (...args: string[]) => exec(path.join(bin, "git"), args, { cwd: repo, env: env() });
    await git("status");
    expect(calls()).toBe(0);
    await git("-c", "submodule.recurse=true", "status");
    expect(calls()).toBe(1);
    await exec("git", ["-C", repo, "config", "submodule.recurse", "true"]);
    await git("status");
    expect(calls()).toBe(2);
  });
});
