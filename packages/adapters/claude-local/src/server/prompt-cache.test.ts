import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareClaudePromptBundle } from "./prompt-cache.js";

describe("Claude prompt bundle content identity", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-bundle-"));
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "default");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  const prepare = (instructionsContents: string | null) => prepareClaudePromptBundle({
    companyId: "company-1", skills: [], instructionsContents, onLog: async () => {},
  });

  it("keeps v1 while rejecting the old instruction text plus path directive", async () => {
    const text = "Instructions with an authored run-id: run-1.\n";
    const stable = text +
      "\nUse the agent instruction file location supplied in the current run prompt to resolve relative file references. " +
      "The newest Paperclip instruction location section supersedes locations from earlier turns.";
    const current = await prepare(stable);
    for (const entry of ["/runs/run-1/live/AGENTS.md", "/runs/run-2/live/nested/AGENTS.md"]) {
      const legacy = await prepare(text +
        `\nThe above agent instructions were loaded from ${entry}. ` +
        `Resolve any relative file references from ${path.dirname(entry)}/. ` +
        "This base directory is authoritative for sibling instruction files such as " +
        "./HEARTBEAT.md, ./SOUL.md, and ./TOOLS.md; do not resolve those from the parent agent directory.");
      expect(legacy.bundleKey).not.toBe(current.bundleKey);
      expect(legacy.rootDir).not.toBe(current.rootDir);
    }
    expect(await fs.readFile(current.instructionsFilePath!, "utf8")).toBe(stable);
    expect(await prepare(stable)).toEqual(current);
  });

  it("invalidates instruction removal, addition and manifest changes", async () => {
    const keys = await Promise.all([null, "First instructions.\n", "Changed instructions.\n",
      "First instructions.\n\nCompany skill library: changed."].map(async text => (await prepare(text)).bundleKey));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("hashes nested skill files and reuses equal content regardless of skill order", async () => {
    const source = path.join(root, "skill");
    await fs.mkdir(path.join(source, "references"), { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), "Skill instructions.");
    const reference = path.join(source, "references", "details.md");
    await fs.writeFile(reference, "First reference.");
    const skills = [{ key: "one", runtimeName: "one", source }, { key: "two", runtimeName: "two", source }];
    const input = { companyId: "company-1", skills, instructionsContents: "Instructions.", onLog: async () => {} };
    const first = await prepareClaudePromptBundle(input);
    expect(await prepareClaudePromptBundle({ ...input, skills: [...skills].reverse() })).toEqual(first);
    await fs.writeFile(reference, "Changed reference.");
    expect((await prepareClaudePromptBundle(input)).bundleKey).not.toBe(first.bundleKey);
  });
});
