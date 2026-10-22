/**
 * Decides whether a git invocation may need the managed GitHub credential or
 * commit identity. Plain JavaScript source so the staged launcher and the
 * tests run the same code. Anything not recognised calls the broker.
 */
const GIT_BROKER_DECISION_SOURCE = String.raw`function classifyGitInvocation(args) {
  // Global options that take the next argument as their value.
  const withValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);
  const withAttachedValue = /^--(git-dir|work-tree|namespace|exec-path|config-env|list-cmds|attr-source)=/;
  const flags = new Set(['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects',
    '--no-lazy-fetch', '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs',
    '--noglob-pathspecs', '--icase-pathspecs', '--exec-path', '--html-path', '--man-path', '--info-path',
    '-v', '--version', '-h', '--help']);
  // Commands that never contact a remote and never record a commit or tag
  // author. Ref moves write a reflog entry, which uses git's local fallback
  // identity without managed credentials; reflogs are never pushed.
  const local = new Set(['status', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'range-diff', 'log',
    'shortlog', 'show', 'show-ref', 'show-branch', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file',
    'merge-base', 'for-each-ref', 'symbolic-ref', 'update-ref', 'describe', 'name-rev', 'blame', 'annotate',
    'grep', 'check-ignore', 'check-attr', 'check-ref-format', 'hash-object', 'count-objects', 'reflog',
    'config', 'version', 'help', 'init', 'add', 'rm', 'mv', 'apply', 'clean', 'update-index', 'write-tree',
    'read-tree', 'branch', 'checkout', 'switch', 'restore', 'reset', 'worktree', 'cherry', 'patch-id']);
  const globalArgs = [];
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (withValue.has(arg)) {
      if (i + 1 >= args.length) return { needsBroker: true, globalArgs, subcommand: null };
      globalArgs.push(arg, args[++i]);
    } else if (withAttachedValue.test(arg) || flags.has(arg)) {
      globalArgs.push(arg);
    } else if (arg.startsWith('-')) {
      return { needsBroker: true, globalArgs, subcommand: null };
    } else break;
  }
  if (i >= args.length) return { needsBroker: false, globalArgs, subcommand: null };
  const subcommand = args[i];
  const rest = args.slice(i + 1);
  let needsBroker = !local.has(subcommand);
  if (subcommand === 'remote') {
    // Only the forms that read or edit local remote configuration, with only
    // the options listed for each form. Option values and combined short
    // options (remote add -ft main) are not parsed, so they call the broker.
    const words = rest.filter(arg => arg !== '-v' && arg !== '--verbose');
    const options = {
      'get-url': ['--push', '--all'], 'set-url': ['--push', '--add', '--delete'], remove: [], rm: [],
      rename: ['--progress', '--no-progress'], 'set-branches': ['--add'], add: ['--tags', '--no-tags'], show: ['-n'],
    };
    const action = words[0];
    const allowed = Object.prototype.hasOwnProperty.call(options, action) ? options[action] : null;
    needsBroker = !(action === undefined || (allowed !== null
      && words.slice(1).every(arg => !arg.startsWith('-') || allowed.includes(arg))
      && (action !== 'show' || words.includes('-n'))));
  } else if (subcommand === 'tag') {
    // Listing only: creating an annotated or signed tag records an identity.
    // -l counts only as a listing flag when no other option is present, so a
    // value such as the message in tag -m -l v1 cannot pass as a list.
    const options = rest.filter(arg => arg.startsWith('-'));
    needsBroker = !(rest.length === 0 || (options.length > 0 && options.every(arg => arg === '-l' || arg === '--list')));
  } else if (subcommand === 'stash') {
    needsBroker = !(rest[0] === 'list' || rest[0] === 'show');
  }
  return { needsBroker, globalArgs, subcommand };
}`;

/** Test entry point for the decision that the staged launcher embeds. */
export const classifyGitInvocation = new Function(`${GIT_BROKER_DECISION_SOURCE}\nreturn classifyGitInvocation;`)() as
  (args: string[]) => { needsBroker: boolean; globalArgs: string[]; subcommand: string | null };

/** Standalone source is staged unchanged on local, SSH, and sandbox runtimes. No secrets in files. */
export function githubLauncherSource(): string {
  return String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const directory = path.dirname(fs.realpathSync(process.argv[1]));
const program = path.basename(process.argv[1]);
const originalPath = (process.env.PATH || '').split(path.delimiter).filter(p => {
  try { return fs.realpathSync(p) !== directory; } catch { return true; }
});
const executable = originalPath.map(p => path.join(p, program)).find(p => {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
});
if (!['git', 'gh'].includes(program) || !executable) {
  process.stderr.write('Paperclip: requested GitHub command is not installed.\n');
  process.exit(127);
}
${GIT_BROKER_DECISION_SOURCE}
async function main() {
  let env = { ...process.env };
  const diagnostic = (code) => process.stderr.write('Paperclip: GitHub ' + code + '; continuing without managed credentials.\n');
  const configRoot = env.GH_CONFIG_DIR || os.tmpdir();
  // A missing/unwritable scratch directory must not break local Git. The
  // fallback deliberately cannot load the host's gh authentication files.
  let configDirectory = path.join(directory, 'unavailable-gh-config');
  let configReady = false;
  try {
    fs.mkdirSync(configRoot, { recursive: true, mode: 0o700 });
    configDirectory = fs.mkdtempSync(path.join(configRoot, 'paperclip-github-operation-'));
    fs.chmodSync(configDirectory, 0o700);
    configReady = true;
    process.once('exit', () => { try { fs.rmSync(configDirectory, { recursive: true, force: true }); } catch {} });
  } catch { diagnostic('configuration_directory_unavailable'); }
  {
    for (const key of Object.keys(env)) {
      if (/^(GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_AUTHOR_.*|GIT_COMMITTER_.*|GIT_CONFIG_.*|GIT_ASKPASS|SSH_ASKPASS|SSH_AUTH_SOCK|GIT_SSH.*)$/.test(key)) delete env[key];
    }
    Object.assign(env, {
      GH_CONFIG_DIR: configDirectory, SSH_AUTH_SOCK: '',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      // The inherited identity was deleted above. Empty identity env values
      // override even explicit repository/command config and break local commits.
      // Require configured identity instead of guessing the OS user's details.
      GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_1: 'git@github.com:',
      GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf', GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
      GIT_CONFIG_KEY_3: 'core.askPass', GIT_CONFIG_VALUE_3: '',
      GIT_CONFIG_KEY_4: 'user.useConfigOnly', GIT_CONFIG_VALUE_4: 'true',
    });
    // gh always uses the broker. A local git command keeps the sanitised
    // environment above and never receives a credential. In a partial clone a
    // local command can fetch missing objects, so it keeps the broker too.
    // Recursion can fetch inside a submodule, where child Git runs without the
    // launcher, so any submodule configuration (an initialised submodule's url,
    // submodule.recurse, submodule.active) keeps the broker as well.
    let needsBroker = true;
    if (program === 'git') {
      const decision = classifyGitInvocation(process.argv.slice(2));
      if (!decision.needsBroker) {
        const promisor = spawnSync(executable, [...decision.globalArgs, 'config', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor|submodule\\..*)$'],
          { env: { ...env, PATH: originalPath.join(path.delimiter) }, stdio: 'ignore', timeout: 10000 });
        needsBroker = promisor.status !== 1;
      }
    }
    const base = env.PAPERCLIP_GITHUB_BROKER_URL || env.PAPERCLIP_API_URL;
    if (needsBroker) try {
    let response;
    if (base && env.PAPERCLIP_GITHUB_BROKER_TOKEN) {
      const url = base.replace(/\/+$/, '').replace(/\/api$/, '') + '/runtime-tools/github/credentials';
      // A slow or restarting control plane must not cost the operation its
      // managed identity, so a failed request is retried before giving up.
      // Busy (409) responses and transport failures keep separate budgets, and
      // the body is read inside the retry so a failed read is retried too.
      let transportFailures = 0, conflicts = 0, result;
      for (;;) {
        try {
          response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
            headers: { authorization: 'Bearer ' + (env.PAPERCLIP_GITHUB_BRIDGE_TOKEN || env.PAPERCLIP_API_KEY || env.PAPERCLIP_GITHUB_BROKER_TOKEN),
              'x-paperclip-github-capability': env.PAPERCLIP_GITHUB_BROKER_TOKEN, 'content-type': 'application/json' },
            body: '{}',
          });
          if (response.status === 409 && conflicts < 29) {
            conflicts += 1;
            await response.arrayBuffer();
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          result = response.ok ? await response.json() : null;
          break;
        } catch (error) {
          transportFailures += 1;
          if (transportFailures >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, 500 * transportFailures));
        }
      }
      if (!response.ok) {
        diagnostic(response.status === 401 || response.status === 403 ? 'capability_rejected' : 'broker_response_unavailable');
      } else {
      if (result.status === 'unavailable') {
        const reason = typeof result.reason === 'string'
          ? result.reason.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500)
          : 'Check the GitHub connection in Paperclip';
        process.stderr.write('Paperclip: GitHub access unavailable: ' + reason + '. Continuing without GitHub credentials.\n');
      }
      if (result.status === 'available' && configReady) {
        for (const [key, value] of Object.entries(result.env || {})) {
          if (/^(GH_TOKEN|GITHUB_TOKEN|PAPERCLIP_GIT_TOKEN|GIT_TERMINAL_PROMPT|GIT_AUTHOR_(NAME|EMAIL)|GIT_COMMITTER_(NAME|EMAIL)|GIT_CONFIG_COUNT|GIT_CONFIG_(KEY|VALUE)_\d+)$/.test(key) && typeof value === 'string') env[key] = value;
        }
      }
      }
    } else { diagnostic('capability_missing'); }
    } catch { diagnostic('broker_transport_unavailable'); }
  }
  // Only this invocation and its children inherit the captured credential.
  // Its Git children use the real binary, so steering cannot split a gh operation.
  env.PATH = originalPath.join(path.delimiter);
  // Nested shell aliases must not reload the parent launcher profile and
  // recapture a newer identity. All ordinary descendants stay in this operation.
  env.ZDOTDIR = configDirectory;
  env.BASH_ENV = '/dev/null';
  env.GIT_SSH_COMMAND = 'ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes';
  const child = spawn(executable, process.argv.slice(2), { env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { process.stderr.write('Paperclip: GitHub command could not start.\n'); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code === null ? 128 : code; });
}
main().catch(() => { process.stderr.write('Paperclip: GitHub launcher_setup_failed.\n'); process.exitCode = 1; });
`;
}

/** Override inherited credentials even when adapters merge the host environment later. */
export function githubBrokerEnvironment(input: Record<string, unknown>, broker: { url: string; token: string }): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) if (typeof value === "string") env[key] = value;
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "PAPERCLIP_GIT_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_CONFIG_COUNT", "PAPERCLIP_GITHUB_OPERATION_ACTIVE"]) env[key] = "";
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) env[key] = "";
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.SSH_ASKPASS = "";
  env.GIT_SSH_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=none -o BatchMode=yes";
  env.SSH_AUTH_SOCK = "";
  env.PAPERCLIP_GITHUB_BROKER_URL = broker.url;
  env.PAPERCLIP_GITHUB_BROKER_TOKEN = broker.token;
  return env;
}
