// Process launches added by dependency patches (SX-2476). Only the added lines
// of a patch change what runs, so only those are counted.

const PATCH_TOKENS = [
  { api: "child_process", pattern: /child_process/g },
  { api: "spawn", pattern: /(?<![A-Za-z0-9_.$])spawn\s*\(/g },
  { api: "spawnSync", pattern: /\bspawnSync\s*\(/g },
  { api: "execFile", pattern: /\bexecFile(?:Sync)?\s*\(/g },
  { api: "exec", pattern: /(?<![A-Za-z0-9_.$/])exec(?:Sync)?\s*\(/g },
  { api: "fork", pattern: /(?<![A-Za-z0-9_.$])fork\s*\(/g },
  { api: "spawnAgent-hook", pattern: /\bspawnAgent\b/g },
  { api: "spawnClaudeCodeProcess-hook", pattern: /\bspawnClaudeCodeProcess\b/g },
];

/**
 * @returns {{ files: string[], counts: Record<string, number> }}
 */
export function scanPatchText(text) {
  const files = [];
  const counts = {};
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      files.push(line.slice(4).replace(/^b\//, ""));
      continue;
    }
    if (!line.startsWith("+")) continue;
    const added = line.slice(1);
    for (const { api, pattern } of PATCH_TOKENS) {
      pattern.lastIndex = 0;
      const found = [...added.matchAll(pattern)].length;
      if (found) counts[api] = (counts[api] ?? 0) + found;
    }
  }
  return { files, counts };
}
