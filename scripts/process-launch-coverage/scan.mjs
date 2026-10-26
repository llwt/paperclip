// AST scanner for OS process launches in Node production code (SX-2476).
//
// A "launch reference" is any use of a binding that can start an OS process:
// the child_process functions (also under an alias, through a namespace or
// default import, destructured from require() or a dynamic import(), or
// wrapped by promisify), process libraries such as execa, and SDK hooks that
// spawn a program for the caller (see SDK_LAUNCH_IMPORTS). Passing such a
// function as a value counts the same as calling it: the callee is the
// launch, wherever the call finally happens.
import { parse } from "@babel/parser";

export const PROCESS_MODULES = new Set([
  "child_process",
  "node:child_process",
  "cluster",
  "node:cluster",
]);

// Packages that start a process on the caller's behalf.
export const PROCESS_LIBRARIES = new Set([
  "execa",
  "cross-spawn",
  "cross-spawn-promise",
  "node-pty",
  "@lydell/node-pty",
  "node-pty-prebuilt-multiarch",
  "shelljs",
  "tinyexec",
  "nano-spawn",
  "zx",
  "child-process-promise",
  "spawn-sync",
]);

// Packages whose API starts an agent or helper program. Each import of one of
// these (any form) is a site, because the launch happens inside the SDK.
export const SDK_LAUNCH_IMPORTS = new Set([
  "acpx",
  "acpx/runtime",
  "embedded-postgres",
  "esbuild",
  "open",
  "@modelcontextprotocol/sdk/client/stdio.js",
  "@anthropic-ai/claude-agent-sdk",
  "@openai/codex-sdk",
  "simple-git",
  "playwright",
  "playwright-core",
  "puppeteer",
  "puppeteer-core",
]);

// Option names through which a caller hands an SDK the function that spawns
// its program. Setting one is a launch site even though it names no import.
export const SDK_LAUNCH_HOOK_PROPERTIES = new Set([
  "spawnClaudeCodeProcess",
  "pathToClaudeCodeExecutable",
  "agentSpawn",
  "spawnAgent",
  "spawnProcess",
]);

export const LAUNCH_APIS = new Set([
  "spawn",
  "spawnSync",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "fork",
]);

const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
]);

const TS_TYPE_NODE = /^TS(?!AsExpression|SatisfiesExpression|NonNullExpression|TypeAssertion|InstantiationExpression|ParameterProperty|EnumDeclaration|ModuleDeclaration|ExportAssignment|ImportEqualsDeclaration|ExternalModuleReference)/;

const FUNCTION_NODES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

// Source text that is itself a program: a string that loads child_process (or
// cluster) at run time. The named generated launchers are also checked by
// extractEmbeddedPrograms; this finds every other one.
const EMBEDDED_LOAD_PATTERN =
  /(?:require|getBuiltinModule)\(\s*["'](?:node:)?(?:child_process|cluster)["']\s*\)|\bfrom\s+["'](?:node:)?(?:child_process|cluster)["']|\bprocess\.execve\b/;

function isNode(value) {
  return value !== null && typeof value === "object" && typeof value.type === "string";
}

export function parseSource(source, file) {
  const jsx = /\.(?:tsx|jsx)$/.test(file);
  const script = /\.cjs$/.test(file);
  return parse(source, {
    sourceType: script ? "script" : "unambiguous",
    plugins: [["typescript", { dts: false }], ...(jsx ? ["jsx"] : [])],
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowNewTargetOutsideFunction: true,
    allowSuperOutsideMethod: true,
    allowUndeclaredExports: true,
  });
}

function staticString(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

function propertyName(member) {
  if (member.type !== "MemberExpression" && member.type !== "OptionalMemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return staticString(member.property);
}

function patternBindings(pattern) {
  const out = [];
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      if (property.type === "RestElement") {
        out.push({ key: "*", local: property.argument.type === "Identifier" ? property.argument.name : null, rest: true });
        continue;
      }
      const key = property.computed ? staticString(property.key) : property.key.type === "Identifier" ? property.key.name : staticString(property.key);
      let value = property.value;
      if (value.type === "AssignmentPattern") value = value.left;
      out.push({ key, local: value.type === "Identifier" ? value.name : null });
    }
  }
  return out;
}

function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === "AwaitExpression" ||
      current.type === "TSAsExpression" ||
      current.type === "TSSatisfiesExpression" ||
      current.type === "TSNonNullExpression" ||
      current.type === "ParenthesizedExpression" ||
      current.type === "TSTypeAssertion")
  ) {
    current = current.type === "AwaitExpression" ? current.argument : current.expression;
  }
  return current;
}

// The module name loaded by require("x"), import("x"), createRequire(...)("x")
// or process.getBuiltinModule("x"), or null.
function loadedModule(node, requireAliases = new Set()) {
  if (node?.type !== "CallExpression") return null;
  const first = staticString(node.arguments[0]);
  if (first === null) return null;
  const callee = node.callee;
  if (callee.type === "Import") return first;
  if (callee.type === "Identifier" && (callee.name === "require" || requireAliases.has(callee.name))) return first;
  if (callee.type === "MemberExpression") {
    const name = propertyName(callee);
    if (name === "getBuiltinModule" || name === "require") return first;
  }
  if (callee.type === "CallExpression") return first;
  return null;
}

function functionLabel(path) {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index];
    if (!FUNCTION_NODES.has(node.type)) continue;
    if ((node.type === "FunctionDeclaration" || node.type === "FunctionExpression") && node.id?.name) return node.id.name;
    if (node.key) {
      const name = node.key.type === "Identifier" ? node.key.name : staticString(node.key) ?? node.key.id?.name;
      let owner = null;
      for (let outer = index - 1; outer >= 0; outer -= 1) {
        const holder = path[outer];
        if (holder.type === "ClassDeclaration" || holder.type === "ClassExpression") {
          owner = holder.id?.name ?? null;
          break;
        }
      }
      return owner ? `${owner}.${name}` : name;
    }
    const parent = path[index - 1];
    if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier") return parent.id.name;
    if (parent?.type === "ObjectProperty" && parent.key) {
      return parent.key.type === "Identifier" ? parent.key.name : staticString(parent.key) ?? "<anonymous>";
    }
    if (parent?.type === "AssignmentExpression" && parent.left.type === "MemberExpression") {
      return propertyName(parent.left) ?? "<anonymous>";
    }
    if (parent?.type === "ClassProperty" && parent.key?.type === "Identifier") return parent.key.name;
    // Keep walking: an unnamed callback belongs to the function that holds it.
  }
  return "<module>";
}

/**
 * Parse one file and return its launch references.
 *
 * @returns {{ sites: Array<{ kind: string, api: string, form: "call"|"reference"|"import", in: string, line: number }>, parseErrors: string[] }}
 */
export function scanSource(source, file) {
  const ast = parseSource(source, file);
  const parseErrors = (ast.errors ?? []).map((error) => error.message);
  const sites = [];
  const report = (kind, api, form, path, node) =>
    sites.push({ kind, api, form, in: functionLabel(path), line: node.loc?.start.line ?? 0 });

  // name -> canonical API ("spawn", ...) for function bindings
  const functionBindings = new Map();
  // names bound to a whole process module (namespace/default/require result)
  const moduleBindings = new Set();
  // name -> library specifier (execa, ...) for third-party launchers
  const libraryBindings = new Map();
  // name -> { specifier, imported } for SDK launch imports
  const sdkBindings = new Map();
  // Declarations and import specifiers whose identifier is not itself a use.
  const declarationNodes = new Set();

  // Pass 1: collect every node with its path so alias resolution can iterate.
  const records = [];
  const walk = (node, path) => {
    if (!isNode(node)) return;
    records.push({ node, path: path.slice() });
    path.push(node);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) walk(item, path);
      } else if (isNode(value)) walk(value, path);
    }
    path.pop();
  };
  walk(ast.program, []);

  const bindModule = (specifier, bindings) => {
    // bindings: [{ key, local }] where key is the exported name, "*" for
    // namespace, "default" for default.
    if (PROCESS_MODULES.has(specifier)) {
      let anyBound = false;
      for (const { key, local } of bindings) {
        if (!local) continue;
        if (key === "*" || key === "default") {
          moduleBindings.add(local);
          anyBound = true;
        } else if (LAUNCH_APIS.has(key)) {
          functionBindings.set(local, key);
          anyBound = true;
        }
      }
      return anyBound;
    }
    if (PROCESS_LIBRARIES.has(specifier)) {
      for (const { local } of bindings) if (local) libraryBindings.set(local, specifier);
      return true;
    }
    if (SDK_LAUNCH_IMPORTS.has(specifier)) {
      for (const { key, local } of bindings) if (local) sdkBindings.set(local, { specifier, imported: key });
      return true;
    }
    return false;
  };

  const isProcessSpecifier = (specifier) =>
    PROCESS_MODULES.has(specifier) || PROCESS_LIBRARIES.has(specifier) || SDK_LAUNCH_IMPORTS.has(specifier);

  const kindFor = (specifier) =>
    PROCESS_MODULES.has(specifier) ? "node-builtin" : PROCESS_LIBRARIES.has(specifier) ? "process-library" : "sdk-launch";

  for (const { node, path } of records) {
    if (node.type === "ImportDeclaration") {
      const specifier = node.source.value;
      if (!isProcessSpecifier(specifier)) continue;
      if (node.importKind === "type") continue;
      const bindings = [];
      for (const spec of node.specifiers) {
        declarationNodes.add(spec.local);
        if (spec.type === "ImportSpecifier") {
          if (spec.importKind === "type") continue;
          const key = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
          bindings.push({ key, local: spec.local.name });
        } else if (spec.type === "ImportDefaultSpecifier") bindings.push({ key: "default", local: spec.local.name });
        else if (spec.type === "ImportNamespaceSpecifier") bindings.push({ key: "*", local: spec.local.name });
      }
      bindModule(specifier, bindings);
      if (kindFor(specifier) !== "node-builtin") report(kindFor(specifier), `import:${specifier}`, "import", path, node);
    } else if (
      (node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") &&
      node.source &&
      isProcessSpecifier(node.source.value) &&
      node.exportKind !== "type"
    ) {
      report(kindFor(node.source.value), `reexport:${node.source.value}`, "import", path, node);
    } else if (node.type === "TSImportEqualsDeclaration" && node.moduleReference?.expression) {
      const specifier = node.moduleReference.expression.value;
      if (isProcessSpecifier(specifier) && node.importKind !== "type") {
        declarationNodes.add(node.id);
        bindModule(specifier, [{ key: "*", local: node.id.name }]);
        report(kindFor(specifier), `import:${specifier}`, "import", path, node);
      }
    }
  }

  // require()/import()/getBuiltinModule loads and their bindings.
  const handledLoads = new Set();
  const requireAliases = collectRequireAliases(records);
  for (const { node, path } of records) {
    const rawSpecifier = loadedModule(node, requireAliases);
    if (rawSpecifier === null || !isProcessSpecifier(rawSpecifier)) continue;
    handledLoads.add(node);
    const parent = path[path.length - 1];
    let holder = parent;
    let holderIndex = path.length - 1;
    // Skip await / as / parentheses to the real holder.
    while (
      holder &&
      (holder.type === "AwaitExpression" ||
        holder.type === "TSAsExpression" ||
        holder.type === "TSSatisfiesExpression" ||
        holder.type === "TSNonNullExpression" ||
        holder.type === "ParenthesizedExpression")
    ) {
      holderIndex -= 1;
      holder = path[holderIndex];
    }
    let bound = false;
    if (holder?.type === "VariableDeclarator" && unwrap(holder.init) === node) {
      if (holder.id.type === "Identifier") {
        declarationNodes.add(holder.id);
        bound = bindModule(rawSpecifier, [{ key: "*", local: holder.id.name }]);
      } else if (holder.id.type === "ObjectPattern") {
        const bindings = patternBindings(holder.id);
        for (const entry of bindings) {
          if (entry.rest && PROCESS_MODULES.has(rawSpecifier)) {
            if (entry.local) moduleBindings.add(entry.local);
          }
        }
        bound = bindModule(rawSpecifier, bindings);
        markPatternDeclarations(holder.id, declarationNodes);
      }
    } else if (holder?.type === "MemberExpression" && holder.object === (parent === holder ? node : parent)) {
      // (await import("node:child_process")).spawn(...) handled by the member pass below.
    } else if (holder?.type === "CallExpression" && propertyName(holder.callee ?? {}) === "then") {
      // import("node:child_process").then(...) is classified as a dynamic load.
    }
    const kind = kindFor(rawSpecifier);
    if (kind !== "node-builtin" || !bound) {
      report(kind, `load:${rawSpecifier}`, "import", path, node);
    }
    if (kind === "node-builtin" && !bound) {
      // The loaded module is used directly (member access, .then, argument).
      const member = holder?.type === "MemberExpression" ? propertyName(holder) : null;
      if (member && LAUNCH_APIS.has(member)) report(kind, member, "reference", path, node);
      else report(kind, "module", "reference", path, node);
    }
  }

  // Fixpoint over aliases: const a = spawn; const p = promisify(execFile);
  // const { spawn: s } = cp; const s = cp.spawn.
  let changed = true;
  while (changed) {
    changed = false;
    for (const { node } of records) {
      if (node.type === "VariableDeclarator" && node.init) {
        const init = unwrap(node.init);
        if (handledLoads.has(init)) continue;
        let canonical = null;
        let moduleLike = false;
        if (init.type === "Identifier") {
          if (functionBindings.has(init.name)) canonical = functionBindings.get(init.name);
          else if (moduleBindings.has(init.name)) moduleLike = true;
        } else if (init.type === "MemberExpression" && unwrap(init.object).type === "Identifier") {
          const object = unwrap(init.object).name;
          const member = propertyName(init);
          if (moduleBindings.has(object) && member && LAUNCH_APIS.has(member)) canonical = member;
        } else if (init.type === "CallExpression") {
          const calleeName =
            init.callee.type === "Identifier"
              ? init.callee.name
              : init.callee.type === "MemberExpression"
                ? propertyName(init.callee)
                : null;
          if (calleeName === "promisify" || calleeName === "bind") {
            const target = unwrap(init.arguments[0] ?? init.callee.object);
            if (target?.type === "Identifier" && functionBindings.has(target.name)) canonical = functionBindings.get(target.name);
            else if (target?.type === "MemberExpression") {
              const object = unwrap(target.object);
              const member = propertyName(target);
              if (object.type === "Identifier" && moduleBindings.has(object.name) && member && LAUNCH_APIS.has(member)) canonical = member;
            }
          }
        }
        if (canonical && node.id.type === "Identifier" && !functionBindings.has(node.id.name)) {
          functionBindings.set(node.id.name, canonical);
          declarationNodes.add(node.id);
          changed = true;
        }
        if (moduleLike && node.id.type === "Identifier" && !moduleBindings.has(node.id.name)) {
          moduleBindings.add(node.id.name);
          declarationNodes.add(node.id);
          changed = true;
        }
        if (moduleLike && node.id.type === "ObjectPattern") {
          for (const { key, local } of patternBindings(node.id)) {
            if (local && key && LAUNCH_APIS.has(key) && !functionBindings.has(local)) {
              functionBindings.set(local, key);
              changed = true;
            }
          }
          markPatternDeclarations(node.id, declarationNodes);
        }
      } else if (node.type === "AssignmentExpression" && node.operator === "=" && node.left.type === "Identifier") {
        const right = unwrap(node.right);
        if (right.type === "Identifier" && functionBindings.has(right.name) && !functionBindings.has(node.left.name)) {
          functionBindings.set(node.left.name, functionBindings.get(right.name));
          changed = true;
        }
      }
    }
  }

  // Pass 3: every use of a binding.
  for (const { node, path } of records) {
    const parent = path[path.length - 1];
    if (path.some((ancestor) => TS_TYPE_NODE.test(ancestor.type) && ancestor.type !== "TSTypeQuery")) continue;
    if (path.some((ancestor) => ancestor.type === "TSTypeQuery")) continue;

    if (node.type === "Identifier") {
      if (declarationNodes.has(node)) continue;
      if (isPropertyKey(node, parent) || isMemberProperty(node, parent)) continue;
      if (isDeclaredName(node, parent)) continue;
      const name = node.name;
      if (functionBindings.has(name)) {
        report("node-builtin", functionBindings.get(name), isCallee(node, parent) ? "call" : "reference", path, node);
      } else if (libraryBindings.has(name)) {
        report("process-library", libraryBindings.get(name), isCallee(node, parent) ? "call" : "reference", path, node);
      } else if (sdkBindings.has(name)) {
        const { specifier, imported } = sdkBindings.get(name);
        report("sdk-launch", `${specifier}#${imported}`, isCallee(node, parent) ? "call" : "reference", path, node);
      } else if (moduleBindings.has(name)) {
        // cp.spawn(...): the member names the API. A bare use hands the whole module on.
        if (parent?.type === "MemberExpression" && parent.object === node) {
          const member = propertyName(parent);
          if (member && LAUNCH_APIS.has(member)) {
            const grand = path[path.length - 2];
            report("node-builtin", member, grand?.type === "CallExpression" && grand.callee === parent ? "call" : "reference", path, node);
          } else if (!member) {
            report("node-builtin", "module", "reference", path, node);
          }
        } else if (parent?.type !== "VariableDeclarator" || parent.id === node) {
          if (!(parent?.type === "VariableDeclarator" && parent.id === node)) {
            report("node-builtin", "module", "reference", path, node);
          }
        }
      }
    } else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      // (await import("node:child_process")).spawn and process.binding
      const object = unwrap(node.object);
      if (object && handledLoads.has(object) && !isBoundLoad(path, object)) continue;
      const name = propertyName(node);
      if (
        object?.type === "Identifier" &&
        object.name === "process" &&
        (name === "binding" || name === "execve" || name === "_linkedBinding" || name === "dlopen")
      ) {
        report("process-builtin", `process.${name}`, "reference", path, node);
      }
      if (object?.type === "Identifier" && (object.name === "Bun" || object.name === "Deno") && name) {
        if (/^(?:spawn|spawnSync|Command|run)$/.test(name)) report("runtime-global", `${object.name}.${name}`, "reference", path, node);
      }
    } else if (node.type === "ObjectProperty" || node.type === "ObjectMethod" || node.type === "ClassProperty") {
      const key = node.key;
      const name = key?.type === "Identifier" && !node.computed ? key.name : staticString(key);
      if (name && SDK_LAUNCH_HOOK_PROPERTIES.has(name)) report("sdk-hook", name, "reference", path, node);
    } else if (node.type === "StringLiteral" || node.type === "TemplateElement") {
      const text = node.type === "StringLiteral" ? node.value : node.value.cooked ?? "";
      if (EMBEDDED_LOAD_PATTERN.test(text)) report("embedded-script", "child_process", "reference", path, node);
    }
  }

  // A (await import("node:child_process")).spawn(...) style direct member use.
  sites.sort((a, b) => a.line - b.line || (a.api < b.api ? -1 : 1));
  return { sites, parseErrors };
}

// Names bound to a require function: const r = createRequire(import.meta.url),
// import { createRequire as make } from "node:module" then make(...), and
// aliases of those (const r2 = r).
function collectRequireAliases(records) {
  const factories = new Set(["createRequire"]);
  const aliases = new Set();
  for (const { node } of records) {
    if (node.type === "ImportDeclaration" && /^(?:node:)?module$/.test(node.source.value)) {
      for (const spec of node.specifiers) {
        if (spec.type === "ImportSpecifier") {
          const imported = spec.imported.type === "Identifier" ? spec.imported.name : spec.imported.value;
          if (imported === "createRequire") factories.add(spec.local.name);
        }
      }
    }
  }
  const isFactoryCall = (init) => {
    const call = unwrap(init);
    if (call?.type !== "CallExpression") return false;
    const callee = unwrap(call.callee);
    if (callee.type === "Identifier") return factories.has(callee.name);
    return callee.type === "MemberExpression" && propertyName(callee) === "createRequire";
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const { node } of records) {
      if (node.type !== "VariableDeclarator" || !node.init || node.id.type !== "Identifier") continue;
      if (aliases.has(node.id.name)) continue;
      const init = unwrap(node.init);
      if (isFactoryCall(init) || (init.type === "Identifier" && aliases.has(init.name))) {
        aliases.add(node.id.name);
        changed = true;
      }
    }
  }
  return aliases;
}

function isBoundLoad(path, loadNode) {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    if (path[index] === loadNode) {
      const holder = path[index - 1];
      return holder?.type === "VariableDeclarator";
    }
  }
  return false;
}

function markPatternDeclarations(pattern, declarationNodes) {
  if (pattern.type === "ObjectPattern") {
    for (const property of pattern.properties) {
      const target = property.type === "RestElement" ? property.argument : property.value;
      if (target?.type === "Identifier") declarationNodes.add(target);
      else if (target?.type === "AssignmentPattern" && target.left.type === "Identifier") declarationNodes.add(target.left);
    }
  }
}

function isCallee(node, parent) {
  return (parent?.type === "CallExpression" || parent?.type === "OptionalCallExpression" || parent?.type === "NewExpression") && parent.callee === node;
}

function isPropertyKey(node, parent) {
  return (
    (parent?.type === "ObjectProperty" || parent?.type === "ObjectMethod" || parent?.type === "ClassProperty" || parent?.type === "ClassMethod") &&
    parent.key === node &&
    !parent.computed &&
    !(parent.type === "ObjectProperty" && parent.shorthand && parent.value === node)
  );
}

function isMemberProperty(node, parent) {
  return (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.property === node && !parent.computed;
}

function isDeclaredName(node, parent) {
  if ((parent?.type === "FunctionDeclaration" || parent?.type === "FunctionExpression" || parent?.type === "ClassDeclaration") && parent.id === node) return true;
  if (parent?.type === "VariableDeclarator" && parent.id === node) return true;
  if (parent?.type === "ImportSpecifier") return true;
  if (parent?.type === "ExportSpecifier" && parent.local !== node) return true;
  if (parent?.type === "LabeledStatement" || parent?.type === "BreakStatement" || parent?.type === "ContinueStatement") return true;
  return false;
}

function literalText(node, raw = false) {
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral") {
    return node.quasis
      .map((quasi, index) => (raw ? quasi.value.raw : (quasi.value.cooked ?? quasi.value.raw)) + (index < node.expressions.length ? "__x" : ""))
      .join("");
  }
  return null;
}

/**
 * The generated programs a file contains: a string or template literal that
 * loads child_process, or an array of string lines that does (joined by
 * newlines). Interpolations become `__x`, so the program still parses.
 *
 * @returns {Array<{ line: number, in: string, text: string, rawText: string }>}
 */
export function extractEmbeddedPrograms(source, file) {
  const ast = parseSource(source, file);
  const programs = [];
  const covered = new Set();
  const visit = (node, path) => {
    if (!isNode(node)) return;
    if (node.type === "ArrayExpression" && node.elements.length >= 2) {
      const literals = node.elements.filter((element) => element && literalText(element) !== null);
      if (literals.length * 2 >= node.elements.length) {
        const join = (raw) => node.elements.map((element) => (element ? (literalText(element, raw) ?? "__x") : "")).join("\n");
        const text = join(false);
        if (EMBEDDED_LOAD_PATTERN.test(text)) {
          programs.push({ line: node.loc?.start.line ?? 0, in: functionLabel(path.concat(node)), text, rawText: join(true) });
          for (const element of literals) covered.add(element);
        }
      }
    }
    if ((node.type === "StringLiteral" || node.type === "TemplateLiteral") && !covered.has(node)) {
      const text = literalText(node);
      if (text !== null && EMBEDDED_LOAD_PATTERN.test(text) && !path.some((ancestor) => ancestor.type === "ImportDeclaration")) {
        programs.push({ line: node.loc?.start.line ?? 0, in: functionLabel(path.concat(node)), text, rawText: literalText(node, true) });
        return;
      }
    }
    path.push(node);
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      const value = node[key];
      if (Array.isArray(value)) for (const item of value) visit(item, path);
      else if (isNode(value)) visit(value, path);
    }
    path.pop();
  };
  visit(ast.program, []);
  return programs;
}

/**
 * Scan one extracted program. Template literals are tried as cooked text
 * first and as raw text second, since a program written with `\n` inside a
 * template only parses one of the two ways.
 *
 * @returns {{ sites: ReturnType<typeof scanSource>["sites"], parsed: boolean, text: string }}
 */
export function scanEmbeddedProgram(program) {
  for (const text of new Set([program.text, program.rawText])) {
    try {
      const result = scanSource(text, "embedded.cjs");
      if (result.parseErrors.length === 0) return { sites: result.sites, parsed: true, text };
    } catch {
      // Try the other reading.
    }
  }
  return { sites: [], parsed: false, text: program.text };
}
