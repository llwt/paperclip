// Process creation in Rust sources (SX-2476). Comments, string contents and
// #[cfg(test)] items are removed first, so only code that ships is counted.

const LAUNCH_TOKENS = [
  { api: "Command::new", pattern: /\bCommand\s*::\s*new\b/g },
  { api: "Command::alias", pattern: /\bCommand\s+as\s+\w+/g },
  { api: "CommandExt::exec", pattern: /\.\s*exec\s*\(\s*\)/g },
  { api: "CommandExt::pre_exec", pattern: /\.\s*pre_exec\s*\(/g },
  { api: "libc::fork", pattern: /\b(?:libc|nix\s*::\s*unistd)\s*::\s*(?:fork|vfork)\b/g },
  { api: "libc::exec", pattern: /\b(?:libc|nix\s*::\s*unistd)\s*::\s*(?:execv|execve|execvp|execvpe|execl|execle|execlp|fexecve|execveat)\b/g },
  { api: "libc::posix_spawn", pattern: /\b(?:libc\s*::\s*)?posix_spawnp?\b/g },
  { api: "libc::system", pattern: /\blibc\s*::\s*(?:system|popen)\b/g },
  { api: "tokio::process", pattern: /\btokio\s*::\s*process\b/g },
];

// Replace comments and the inside of string/char literals with spaces
// (newlines kept), so offsets and line numbers survive.
export function blankRustNonCode(source) {
  let out = "";
  let index = 0;
  const blank = (text) => text.replace(/[^\n]/g, " ");
  while (index < source.length) {
    const rest = source.slice(index, index + 2);
    if (rest === "//") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(index, stop));
      index = stop;
    } else if (rest === "/*") {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < source.length && depth > 0) {
        if (source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      out += blank(source.slice(index, cursor));
      index = cursor;
    } else if (/^b?r#*"/.test(source.slice(index, index + 12))) {
      const match = /^b?r(#*)"/.exec(source.slice(index, index + 12));
      const terminator = `"${match[1]}`;
      const end = source.indexOf(terminator, index + match[0].length);
      const stop = end === -1 ? source.length : end + terminator.length;
      out += `${match[0]}${blank(source.slice(index + match[0].length, stop - terminator.length))}${terminator}`;
      index = stop;
    } else if (source[index] === '"') {
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== '"') cursor += source[cursor] === "\\" ? 2 : 1;
      out += `"${blank(source.slice(index + 1, cursor))}"`;
      index = cursor + 1;
    } else if (source[index] === "'" ) {
      const literal = /^'(?:\\.[^']{0,8}|[^\\'])'/.exec(source.slice(index, index + 12));
      if (literal) {
        out += `'${blank(literal[0].slice(1, -1))}'`;
        index += literal[0].length;
      } else {
        out += "'";
        index += 1;
      }
    } else {
      out += source[index];
      index += 1;
    }
  }
  return out;
}

function removeTestItems(code) {
  let result = code;
  for (;;) {
    const match = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/.exec(result);
    if (!match) return result;
    let cursor = match.index + match[0].length;
    // Skip further attributes, then the item up to its closing brace or semicolon.
    for (;;) {
      const attribute = /^\s*#\s*\[[^\]]*\]/.exec(result.slice(cursor));
      if (!attribute) break;
      cursor += attribute[0].length;
    }
    let depth = 0;
    let end = cursor;
    for (; end < result.length; end += 1) {
      const char = result[end];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      } else if (char === ";" && depth === 0) {
        end += 1;
        break;
      }
    }
    result = result.slice(0, match.index) + result.slice(match.index, end).replace(/[^\n]/g, " ") + result.slice(end);
  }
}

/**
 * @returns {{ sites: Array<{ api: string, in: string, line: number }> }}
 */
export function scanRustSource(source) {
  const code = removeTestItems(blankRustNonCode(source));
  const lineOf = (offset) => code.slice(0, offset).split("\n").length;

  // Enclosing function per offset: scan braces, remembering `fn name` heads.
  const scopes = [];
  const functionAt = new Array(code.length + 1);
  let pending = null;
  let depth = 0;
  for (let offset = 0; offset < code.length; offset += 1) {
    const char = code[offset];
    if (char === "f") {
      const head = /^fn\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(code.slice(offset, offset + 80));
      if (head && !/[A-Za-z0-9_]/.test(code[offset - 1] ?? " ")) pending = head[1];
    } else if (char === ";" && pending && depth === (scopes.at(-1)?.depth ?? 0)) {
      pending = null;
    } else if (char === "{") {
      depth += 1;
      if (pending) {
        scopes.push({ name: pending, depth });
        pending = null;
      }
    } else if (char === "}") {
      if (scopes.at(-1)?.depth === depth) scopes.pop();
      depth -= 1;
    }
    functionAt[offset] = scopes.at(-1)?.name ?? "<module>";
  }

  const sites = [];
  for (const { api, pattern } of LAUNCH_TOKENS) {
    pattern.lastIndex = 0;
    for (const match of code.matchAll(pattern)) {
      sites.push({ api, in: functionAt[match.index] ?? "<module>", line: lineOf(match.index) });
    }
  }
  sites.sort((a, b) => a.line - b.line || (a.api < b.api ? -1 : 1));
  return { sites };
}
