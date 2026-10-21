# llwt/paperclip fork

This fork carries the fixes the Nrwl instance needs. Fork fixes are not
submitted upstream (`paperclipai/paperclip`), per Steven's decision on NX-658
(2026-10-17). An inventory row drops out only when an upstream release ships
an equivalent fix on its own, or when Steven drops the patch.

- Mainline: `somnex-main`. Installs pin a full commit SHA on it. The branch is
  protected: GitHub accepts a change only through a pull request with a green
  `somnex-ci` and rejects every direct push (see "CI gate").
- `master` is a pure mirror of upstream `master`. Never commit to it.
- Fork-only files: this file, `.github/workflows/somnex-ci.yml`,
  `scripts/somnex-ci-server-other.mjs` and the files named under "Localhost
  sign-in". Everything else is upstream code plus the patches listed below.

## Inventory of fork-only commits

Base: upstream tag `v2026.1012.0` (`bba6a45f0`), merged on 2026-10-13 (it
contains `v2026.1005.0`). The tag is upstream `master` at `22a3ea341` plus two
release commits that are not on `master`. Last refreshed 2026-10-13 against
upstream `master` `4b958ecbd`, which is 240 commits past that tag.
`v2026.1012.0` was the latest stable tag on that day. The commits below are
the ones on `somnex-main` before the merge; what is left of each is the diff of
`somnex-main` against the tag.

| Commit | What | Upstream status | Drops out when |
| --- | --- | --- | --- |
| NX-834 (this PR) | Tools: opt-in `compact-v1` connection tool names for Claude runs. Pure helper `server/src/services/compact-connection-tool-names.ts`; narrow hooks in the named MCP route (`?toolNames=compact-v1`, unknown values rejected), `listToolsForNamedGateway` (alias projection), `findToolForSession` (alias resolution on the descriptors it already loads, after authentication) and `buildPaperclipRuntimeMcpServers` (label `p` and the versioned URL for `claude_local` agents with `runtimeConfig.connectionToolNames: "compact-v1"`), plus a Claude resume check (`packages/adapters/claude-local/src/server/tool-name-format.ts`) that starts a fresh session when the tool name format changes, because upstream now resumes across other MCP server changes. Stored names, policies, signatures and rate buckets keep the internal name. Kill switch `PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED=true`. Rollback: unset the agent opt-in (or set the kill switch), let compact sessions restart, then revert the binary | Local only (NX-658). Fork-specific implementation of the approved Nx plan. Related upstream: paperclipai/paperclip#15668 (open). | An upstream release provides equivalent presentation aliases without changing stored gateway identities, policy evaluation or signed approvals |
| SX-1120 (this PR) | Database: index for the `paperclipIssue` branch of `valuesForIssue`, so comment lists do not scan all `heartbeat_runs` | On upstream `master` since `e9b6c4d44` (paperclipai/paperclip#16278), also open PR paperclipai/paperclip#12499; not in a stable tag yet. Nothing to submit: upstream already has the fix | The first upstream release merge that contains #16278. On that merge drop the fork's 0306 migration, its journal entry and snapshot, and take upstream's |
| `2593ef230` | CLI: pruning preserves and reports older install payloads with a live executable or working directory on Linux. Processes the installing user may not inspect (`EACCES`, `EPERM`) are skipped and not protected. Unsupported platforms and failed process checks retain payloads without failing the install | Local only (NX-658) | An upstream release guards payload pruning against live processes and failed inspection |
| `d6ca4706f` | A future scheduled check covers an agent-owned `in_progress` or `in_review` blocker with no user assignee and marks its dependency path live. Checks that cannot fire, overdue, cleared, timed out, exhausted checks and checks owned by uninvokable agents keep the previous attention result | Local only (NX-658) | An upstream release carries the same scheduled-check blocker coverage |
| `25fcf9633` | Gateway: configurable tool timeout, connection stays listed after a tool timeout | Local only (NX-658). Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| `669a157cb` | Gateway: approved execution budget stays fixed, timeout env values bounded | Local only (NX-658). Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| `0d78b3d67` | Gateway: summarize the stream when no message matches the `tools/call` request ID | Local only (NX-658) for the stream summary. The selection by request ID is upstream since `v2026.1001.0` and the fork's own copy was dropped in the `v2026.1005.0` merge. The stream summary is not upstream. As upstream does, a malformed `tools/call` response marks the connection errored | An upstream release carries an equivalent fix |
| `ba2e6f933` | Gateway: known method labels only, skip non-JSON stream events | Local only (NX-658). Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| fork PR #24 | Gateway: an oversized tool response leaves connection health unchanged, so its other tools stay listed and callable. The 502 error includes the byte limit and asks the caller to narrow the request | Local only (NX-658) | An upstream release carries the same response-size health handling |
| fork PR #27 | Tools: oversized discovery and session initialization preserve health status and diagnostics. Health probes advance only the check timestamp to retain the sweep interval. Size errors retain their reason and byte limit in caller errors and failure audits. Catalog refresh still fails and retains cached tools, or no catalog if discovery has never succeeded | Local only (NX-658) | An upstream release carries the same discovery and initialization size handling |
| `0fc5dd88b` | UI: remount the composer takeover card per pending input (fork PR #1) | Open upstream as paperclipai/paperclip#15121, no review yet. It stays open as it is. Nothing more is pushed without Steven's go-ahead | #15121 lands and that release is merged |
| `200a198f0` | Tools: offer sign-in when a custom MCP server answers 401 without `WWW-Authenticate` (fork PR #2) | Open upstream as paperclipai/paperclip#15450, from port branch `fix/mcp-401-sign-in-without-challenge` (`e0ffbf2f6`). It stays open as it is. Nothing more is pushed without Steven's go-ahead | #15450 lands and that release is merged |
| fork PR #12 | Tools: the `x-amzn-remapped-www-authenticate` hint is reduced to its metadata address, so endpoints and scopes it names directly are dropped (`metadataOnlyChallenge`) | Open upstream as part of paperclipai/paperclip#15450 (port branch commits `9f13a7dc8` and `e0ffbf2f6`). It stays open as it is. Nothing more is pushed without Steven's go-ahead | #15450 lands and that release is merged |
| fork PR #6 | UI: Enter on an empty last line of a quote block, and Backspace at its start, leave the quote in the editor (`ui/src/lib/quote-exit.ts`) | Local only (NX-658). Port branch `fix/editor-leave-quote-block` (`eecb1eec6`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| fork PR #21 | UI: a quote typed with `> ` gets the paragraph shape of a quote loaded from markdown, so Enter on a line with text continues the quote and only Enter on an empty last line leaves it (`ui/src/lib/quote-exit.ts`) | Local only (NX-658). Port branch `fix/editor-leave-quote-block` does not carry this fix and is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| fork PR #7 | CLI: `install --ref` builds `server/ui-dist`, copies `skills`, stages real workspace dependency versions, and works with `ignore-scripts=true` (see "Install") | Local only (NX-658). Upstream issue #15026 tracks the staging faults. Open upstream PR paperclipai/paperclip#13928 (not ours) covers `server/ui-dist`, the `skills` copy, workspace dependency versions and `npm pack --ignore-scripts`. The two `ignore-scripts=true` faults, root `tsc` missing from the build PATH and embedded PostgreSQL library links, remain local only. Port branch `fix/git-install-ignore-scripts` (`bbc8ccaf4`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| fork PR #14 | Recovery: release the local environment lease of a terminal run once its process is gone (stale-lock sweep, cancel without a process handle, healing sweep at startup and on the recovery tick). Without it a run kept across a restart, or orphaned by a hard stop, blocks every later wake on its task | Local only (NX-658). Upstream #13515 (`e1f245a66`, in `v2026.1005.0`) releases the active lease of a terminal run after a restart or on its sweep (about 5 minutes). The fork keeps immediate release and starts wakes saved behind the lease (Steven: keep, NX-658) | An upstream release both releases the lease immediately and starts wakes saved behind it |
| fork PR #17 | Documents: same-company agents can upsert documents on another agent's idle issue; access decisions, the active run lock, recovery restrictions, revision checks and document locks still apply | Local only (NX-658). Upstream `master` (`71cd0a262`) still lacks the open-write option as of 2026-10-08 | An upstream release carries an equivalent fix |
| fork PR #19 | Tools: one remote tool discovery (the handshake and every catalog page) has a total budget of 60 seconds and fails with `remote_http_response_timeout`. `readMcpHttpResponse` and `initializeMcpHttpSession` take an optional `signal`. Without it a server that keeps the `tools/list` stream alive and never answers holds a catalog refresh or a health check open until the 8 MiB limit | Open upstream as part of paperclipai/paperclip#15448 (commit `2deb0c002`). It stays open as it is. Nothing more is pushed without Steven's go-ahead | #15448 lands and that release is merged |
| NX-617 (this PR) | Tools: per-connection "Sign in through localhost" and "Scopes to request" for a pasted MCP URL (see "Localhost sign-in") | Local only (NX-658) | An upstream release carries an equivalent setting, or the Atlassian connection no longer needs a localhost callback |
| NX-668 (this PR) | CLI tests: a setup guard blocks `systemctl`, `loginctl`, `journalctl` and `launchctl` in every CLI test and fails the test that reached them; the two `uninstallCommand` tests and the `doctor` test no longer look up the host service manager. Test-only, no runtime change | Local only (NX-658). Upstream `master` (`9f4acc8f1`) has the same unguarded tests. Port branch `fix/cli-tests-never-reach-service-manager` is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| fork PR #29 | UI: show all nine Google Workspace catalog entries and saved accounts on the Connectors page for this instance's customer-owned OAuth app | Local only (NX-658). Upstream plans to remove the filter itself after Google approval | The upstream release without the filter is merged |
| NX-716 (this PR) | Interactions: a confirmation card whose source run ended without a `workspace_finalize` row can be accepted (`runWorkspaceIsFinalized` in `server/src/services/issues.ts`). Before, a card posted by a run that was then lost (`process_lost`) could never be accepted. A live run still blocks, and so does an ended native-runtime run whose finalization coordinator row has not reached `terminal_failure` (native recovery can still resume it) | Local only (NX-658). Upstream `master` has the same gap | An upstream release carries an equivalent fix |
| SX-1370 (this PR) | Dependencies: the workspace-finalize barrier on a `done` blocker holds only while the run that last touched the blocker's workspace can still record a `workspace_finalize` (a live run, or an ended native-runtime run native recovery can still resume, as in `runWorkspaceIsFinalized`). A finalize that ended `failed` or `skipped`, a stale `running` finalize of an ended run, a run that ended without one and an operation with no run no longer block the dependent; the run-end hook and the periodic dependency backstop then wake it. A `PATCH` that changes `blockedByIssueIds` and the status together checks the blockers against the new links (`getDependencyReadinessForBlockerIssueIds`). `cancelled` blockers still block, as upstream intends | Local only (NX-1092). Upstream `master` has the same barrier and route ordering | An upstream release carries an equivalent fix |
| NX-892 (this PR) | `pnpm-lock.yaml`: the `server` entries for `@modelcontextprotocol/sdk` and `light-my-request`, 27 added lines. The tag's `server/package.json` names both, its lockfile does not, and `pnpm install --frozen-lockfile` (fork CI and `paperclipai install`) fails without them | Upstream `master` has them since its lockfile refresh `03cf6a6ec` (2026-10-06), which is after the commit the tag was cut from | The next upstream merge. Take upstream's lockfile on a conflict |
| fork PR #3, fork files | `FORK.md`, `.github/workflows/somnex-ci.yml` and `scripts/somnex-ci-server-other.mjs` | Fork-only by design, will not go upstream | The fork is retired |

To refresh this table:

```sh
git fetch upstream --tags && git fetch fork
git log --oneline <base tag>..fork/somnex-main        # fork-only commits
git cherry upstream/master fork/somnex-main           # "-" means upstream has it
git rev-list --left-right --count fork/somnex-main...upstream/master
gh pr view <number> -R paperclipai/paperclip        # each upstream PR
```

## Localhost sign-in

Two settings on a connection to a pasted MCP URL, both off by default, under
"Advanced authentication" in the setup form (create and reconnect):

- **Sign in through localhost.** The sign-in uses
  `http://localhost:<server port>/api/tools/oauth/callback` as callback instead
  of the public address. For an authorization server that refuses the public
  address but accepts loopback (Atlassian for the Nx organization).
- **Scopes to request.** The sign-in asks for exactly this list. Without it a
  pasted URL asks for every scope the server advertises.

How it works:

- The browser that signs in reaches the callback through a port forward
  (`ssh -L <port>:127.0.0.1:<port> <host>`), where it has no Paperclip session.
  The callback handler answers such a request (no signed-in actor, `Host`
  exactly `localhost` or `127.0.0.1`, no `X-Forwarded-Host`, exact path) with a
  page that sends the browser to the same path on the configured public
  address. That address must be HTTPS and not loopback. Nothing from the
  request goes into the target origin. No state is looked up and no code is
  exchanged on that hop. This relay is the one part that is not per
  connection: it answers any such request, whatever connection it belongs to.
- A localhost attempt carries its own snapshot in its OAuth `state`
  (`lb2.<port>.<client binding>.<random>`). The callback rebuilds the localhost
  address from that port, so the token request names the address the
  authorization request named even if another process or a restarted server on
  another port handles it, and it refuses if the connection's client changed
  since the start. A dotted state in a format the server cannot read (for
  example one started before an upgrade) is refused and needs a fresh sign-in.
  There is no database column for this on purpose: upstream already has later
  migrations than the fork.
- With a scope list, a caller can only narrow it, the list is stored as the
  connection's scopes, and a grant wider than the request is not saved.
- The settings belong to the setup form. The tool access service wraps its
  database handle (`withOAuthSignInPreservingWrites`, first statement of
  `toolAccessService`), so every update of a connection's `config` or
  `transportConfig` made through it, in or out of a transaction, takes the two
  settings from the row as it is at the moment of the update, not from the copy
  the operation read earlier. That covers client registration, start, callback,
  renewal, catalog refresh and discovery without a change at the write itself.
  Only the setup form's connect request and its undo store a config as given
  (`ownedConnectionConfig`, four uses). The legacy token backfill wraps its
  handle the same way. The callback also locks the connection row and rechecks
  the attempt before it stores credentials. A test asserts the wrap, the four
  owned writes and the absence of raw SQL updates.
- The config schema accepts any JSON under `oauth`, and only an object can hold
  the settings. A write whose `oauth` is an object loses its own copies of the
  two keys and gets the row's, also when the row has none. A write whose
  `oauth` is missing, JSON null, a scalar or an array is stored unchanged when
  the row has no settings; when the row has settings, `oauth` becomes an object
  holding just those settings and every other field is stored as written.
- What the wrap does not cover: a `set` whose config value is a SQL expression,
  raw SQL, an upsert (`insert ... onConflictDoUpdate`) and a database handle
  that was not wrapped. None of these writes a connection's config today. A
  write of that kind added by an upstream merge is not protected, so audit the
  writers of `tool_connections.config` and `transportConfig` at every upstream
  merge.
- Not available for curated apps, Vercel-backed or brokered sign-ins.

Files: `packages/shared/src/oauth-sign-in-settings.ts`,
`server/src/services/tool-oauth-sign-in.ts`,
`server/src/services/tool-oauth-sign-in-writes.ts`,
`server/src/__tests__/tool-oauth-loopback.test.ts`,
`ui/src/features/connections/OAuthSignInSettingsFields.tsx`,
`ui/src/features/connections/oauth-sign-in-settings.ts` and their tests are
fork-only. The wiring in upstream-owned files is marked "Fork-only (NX-617)" or
"Differs from upstream (fork, NX-617)": `server/src/services/tool-access.ts`
(`toolAccessService` first statement, `startOAuth`, `completeOAuthCallback`,
`connectGalleryApp`), `server/src/services/tool-oauth-legacy-backfill.ts` (two
lines),
`server/src/routes/tool-access.ts` (callback handler), `server/src/app.ts`,
`packages/shared/src/validators/tool-access.ts`, `packages/shared/src/index.ts`
and `ui/src/features/connections/ConnectionSetupFlow.tsx`. On a release merge,
keep those marked blocks and rerun `tool-oauth-loopback.test.ts`.

## Rules for a change to `somnex-main`

1. **Fork first, local only.** A fix the instance needs lands on `somnex-main`
   through a fork PR. Do not create a port branch on upstream `master` or
   prepare an upstream PR. A fix that is not urgent is not sent upstream
   either: it waits for upstream or becomes a fork fix.
2. **Every fork-only commit has an inventory row** above, with its upstream
   status: whether upstream already has an equivalent fix, with its commit or
   PR when one exists. A fork PR without its row is not ready for review.
3. **Mark deliberate differences in the code.** Where a patched line differs
   from upstream on purpose, say so in a comment next to it (see the "Differs
   from upstream" comment in `server/src/services/mcp-http.ts`). A release
   merge updates the tag named in such a comment.
4. **Upstream release merges land as a merge commit, never squashed.** Fix PRs
   may be squash-merged. No rebase and no force push on `somnex-main`.
5. Posting to `paperclipai/paperclip` (PR, issue, comment or push to an open PR)
   is external and needs Steven's go-ahead each time.
6. **Every change goes through a fork pull request with a green `somnex-ci`.**
   That covers fixes, upstream release merges, reverts and edits to this file.
   Never push to `somnex-main` directly. GitHub enforces this: branch protection
   requires a pull request and a green `somnex-ci` on its head, for admins too,
   and rejects a direct push (see "CI gate").

## Taking upstream releases

`somnex-main` takes each upstream **stable release tag** by merge commit, within
7 days of the release.

```sh
git fetch upstream --tags
git switch -c merge/upstream-<tag> fork/somnex-main
git merge --no-ff <tag>
```

- Push `merge/upstream-<tag>` to the fork and open a fork PR from it into
  `somnex-main`. Merge that PR with a merge commit. Never squash or rebase it
  (rule 4). The release merge has no shortcut: branch protection requires a
  pull request, so GitHub rejects a push of the merge commit straight to
  `somnex-main`, and the PR merges only once `somnex-ci` is green on its head
  (rule 6).
- Conflicts only appear in files the fork patched. Resolve each conflict so
  the fork patch stays, and keep the "Differs from upstream" comments.
- After the merge, refresh the inventory: remove rows that upstream now carries.
- Upstream keeps `pnpm-lock.yaml` current with a bot on `master`, so a tag can
  carry a lockfile that lags its `package.json`. If
  `pnpm install --frozen-lockfile` fails on the merge result, refresh the
  lockfile in its own commit with upstream's fallback command
  (`pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile`) and
  give it an inventory row.
- Sync the fork's `master` from upstream in the same task.
- Exception: merge a specific upstream `master` commit only when one upstream
  fix is needed early, and record the reason in the PR.

## CI gate

`.github/workflows/somnex-ci.yml` runs on every pull request into `somnex-main`, on
GitHub-hosted runners: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm build`, and the suites of `pnpm test:run` split into parallel lanes with
upstream's own shard flags. Upstream's server shards pick files by path rules
and miss a few that the unsharded run includes, so one extra lane ("server
other") runs every server project test file that no shard selects. The list is
computed by `scripts/somnex-ci-server-other.mjs` (fork-only) from vitest's own
collection minus the shards' dry-run selection; `--list` prints it. The
`somnex-ci` check is green only when every lane passed.

Until 2026-10-21 the mainline was named `nrwl-main` and the required check `nrwl-ci` (renamed on SX-1119 Step 3). Older PRs, tasks and install notes use those names.

`.github/workflows/pr.yml` is upstream's and calls upstream's reusable
workflow at upstream `master` (`pr-trusted.yml@master`). It is left untouched
so it never conflicts with an upstream merge. It does run on fork pull
requests (it passed on fork PR #3), but its definition follows upstream
`master`, not the code on `somnex-main`, so it is extra signal and not the gate.

**Red test baseline: empty.** No test is allowed to fail. The two tests that
were red on `somnex-main` (`tool-access-service.test.ts`, "executes allowed test
calls as a board user while attributing the selected agent" and "drives an
ask-first test call through its live lifecycle") pass on clean `v2026.916.1`.
They failed only with the fork's request ID selection (`0d78b3d67`), because
their fixtures answered with a fixed ID. Fork PR #3 fixed the fixtures the same
way upstream did in `v2026.1001.0`. If a test is ever red on a clean upstream
tag, record it in a baseline file next to the workflow, make the gate "no
failures outside the baseline", and never skip or delete the test.

### Branch protection

`somnex-main` takes changes only through a pull request, and `somnex-ci` is a
required status check on it. GitHub branch protection enforces both. Settings
as of 2026-10-07:

| Setting | Value |
| --- | --- |
| Required status checks | `somnex-ci` only, pinned to GitHub Actions (app id 15368). It is the `gate` job of `somnex-ci.yml` |
| Branch up to date before merging (`strict`) | Off |
| Enforced for admins (`enforce_admins`) | On |
| Force pushes | Blocked |
| Branch deletion | Blocked |
| Pull request required (`required_pull_request_reviews`) | Yes |
| Required approving reviews | 0 |
| Dismiss stale reviews, code owner review, last push approval | Off |
| Push restrictions | None |
| Rulesets | None |

What this means in practice:

- A pull request into `somnex-main` cannot be merged until `somnex-ci` is green on
  its head commit. That holds for everyone, including the admin account all
  agents use. There is no admin override.
- A direct push to `somnex-main` is rejected in every case, for admins too,
  because protection requires a pull request. That includes a push of a commit
  that already has a green `somnex-ci`, such as the head of an up to date pull
  request. The merged pull request is the only way in (rule 6).
- `somnex-main` cannot be force pushed or deleted. To take a commit back, open a
  revert pull request.
- `strict` is off: a pull request does not have to contain the latest
  `somnex-main` to merge. Its `somnex-ci` result is for the merge with the base as
  it was when the run started.
- Zero approving reviews are required. All agents share one GitHub account and
  an account cannot approve its own pull request, so an approval requirement
  could not be met. The independent review and Steven's approval of the head
  SHA are process, not something GitHub enforces.
- `master` has no part in this: the protection covers `somnex-main` only.

To inspect the live settings (read only):

```sh
gh api repos/llwt/paperclip/branches/somnex-main/protection
```

If the output differs from the table, the table is stale: correct it in a pull
request. Changing or removing the protection is a repository setting, not a
routine step. It needs Steven's go-ahead each time, including a temporary
change to get one merge through.

## Install

An install is a deployment. It is its own task, assigned by the Coordinator
after Steven approves the SHA.

1. The target is a full SHA on `somnex-main` with a green `somnex-ci` run. Never
   install a branch name. GitHub lets a commit reach `somnex-main` only through
   a merged pull request (rule 6), so an install never involves a push to
   `somnex-main`.
2. Record the current `sha` from `~/.paperclip/cli/install.json`. List the
   migrations the new commit adds: `git diff --stat <old> <new> -- packages/db/src/migrations`.
3. Take a database backup: `paperclipai db:backup`. `install` takes none (only
   `update` does).
4. Copy anything hand-made out of `~/.paperclip/cli/installs` first. `install`
   keeps the new payload and the two before it and deletes every other
   directory under `installs/npm` and `installs/git`, hand-made ones included.
5. `GH_TOKEN="$(gh auth token)" paperclipai install --repo llwt/paperclip --ref <sha> -y`
6. `paperclipai service restart`
7. Run the smoke checklist.

Facts about `install --ref` on this host (found on NX-449 and NX-509):

- **Run the fixed CLI from a checkout while the installed CLI is older than
  fork PR #7.** The installed CLI cannot build a git ref (see the next
  point). In a checkout of the target SHA, after `pnpm install`, replace
  `paperclipai` in step 5 with `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts`.
  Once a payload that contains fork PR #7 is installed, the installed CLI works.
- Before fork PR #7 a git install could not complete: nothing built
  `server/ui-dist` or copied `server/skills` before the server was staged
  (`ENOENT` from `scripts/prepare-bundled-package.mjs`), and the staged server
  asked for `@paperclipai/plugin-sdk` at the server's version, which does not
  exist. The two older "git" payloads on chungus (`669a157cb307`,
  `ba2e6f933fa5`) are hand-patched copies of the npm `2026.916.1` payload.
- **The ref lookup needs a GitHub token.** It calls the GitHub API, and the
  anonymous limit is 60 requests per hour per host. The CLI reads `GH_TOKEN` or
  `GITHUB_TOKEN`. In a Paperclip run `GH_TOKEN` is empty, so take it from
  `gh auth token` as in step 5.
- **`ignore-scripts=true` stays on.** The host npm config
  (`~/.config/npm/npmrc`) sets it on purpose, and the install works with it
  since fork PR #7. Do not disable it for the install. Two things made it fail
  before: pnpm leaves the workspace root `node_modules/.bin` off the script
  PATH under that setting (`tsc: not found`), which the installer now adds
  itself; and npm skips the `@embedded-postgres/<platform>` install script,
  which links `libpq.so.5` and the ICU libraries, so the embedded database
  could not start. The installer now creates those links from the package's
  `pg-symlinks.json` and prints a line when it does. No dependency script runs.
  The other install scripts npm skips in the payload (`esbuild`, `protobufjs`,
  `ssh2`, `cpu-features`) are not needed: read from their sources, not tested
  one by one.
- The install does not depend on the setting either way: staged packages are
  packed with `--ignore-scripts`, because their `prepack` script fails outside
  the workspace. A full install with the setting off is not tested.
- The build needs a Rust toolchain (`cargo`) on PATH for
  `packages/paperclip-runner`, besides Node and corepack.
- The whole install takes about 5 minutes on chungus.
- To try an install without touching the live one, set both `HOME` and
  `PAPERCLIP_HOME` to a scratch directory. `PAPERCLIP_HOME` alone is not
  enough: the shim is written to `$HOME/.local/bin/paperclipai`.

## Rollback

1. `paperclipai update --rollback`, or
   `paperclipai install --repo llwt/paperclip --ref <previous sha> -y`.
2. `paperclipai service restart`, then the smoke checklist.
3. If the new build ran migrations, the old code may not work on the new
   schema. Rollback then also means restoring the database backup from install
   step 3.

A rollback changes the installed build only. It does not move `somnex-main`,
which cannot be reset, force pushed or pushed to directly. To take the bad
commit off `somnex-main`, open a revert pull request and wait for a green
`somnex-ci` like any other change.

`update --rollback` flips `current` to `previous[0]` in `install.json` for any
managed install, npm or git, and restarts the active service. It does not
reverse migrations. This is read from the source
(`rollbackManagedInstall` in `cli/src/commands/update.ts`). It was then run on
this host: see "Record of the `98fa44c` install" for the result and for why
its exit code cannot be trusted here.

## Smoke checklist

The health endpoint reports `commit: null`, so the SHA check reads
`install.json`.

1. `paperclipai service status` is healthy, and `/api/health` returns 200 with
   `status: ok`.
2. `sha` in `~/.paperclip/cli/install.json` equals the approved SHA.
3. One agent heartbeat run completes on a throwaway task.
4. One MCP gateway tool call succeeds (the tool timeout path).
5. One pending card renders and accepts input in the UI (the card remount
   path).

## Record of the `98fa44c` install

What the first install under this process showed (NX-449, chungus,
2026-10-07, from `ba2e6f933fa5` to
`98fa44c0d29b7db77612dc23bf64e4288f4661ce`). Every statement is marked
**Tested** (run on this host, with the result seen) or **Read from source**
(taken from the code at `98fa44c`, not run). Do not turn a "read from source"
line into a procedure step without testing it first.

### Install

- **Tested.** The sequence in "Install" worked: `install --repo llwt/paperclip
  --ref 98fa44c0d29b7db77612dc23bf64e4288f4661ce -y` (exit 0 after 244 s), then
  `paperclipai service restart`, then the smoke checklist. The install ran
  through the CLI of a checkout with the same tree as the target, with
  `GH_TOKEN` from `gh auth token`, because the installed CLI was older than
  fork PR #7.
- **Not tested.** The same install through the installed `paperclipai` shim.
  `98fa44c` contains fork PR #7, so it should work from the next install on.
- **Tested.** `install` only stages the payload, flips `current` and writes
  `install.json`. The old server keeps running until the restart.
- **Tested.** Smoke checklist steps 1 to 4 passed on `98fa44c`. Step 5 needs a
  person to click a card in the UI; an agent can only show that the UI is
  served from the new payload.
- **Process, not a test result.** Steven's approval binds to one full SHA. A
  new commit on `somnex-main` after the approval is not covered: it needs a new
  approval before it is installed, and smoke step 2 checks the installed `sha`
  against the approved one.

### Backup

- **Tested.** `install` takes no database backup. No backup file appeared
  during the install. The newest ones were the one taken by hand just before
  it and the server's own hourly backup from 8 minutes earlier.
- **Read from source.** `cli/src/commands/install.ts` has no backup call. Only
  `paperclipai update` runs one (`runPreUpdateBackup` in
  `cli/src/commands/update.ts`).
- **Tested.** `paperclipai db:backup`, run before the install, wrote
  `paperclip-<timestamp>.sql.gz` (about 92 MiB) to
  `~/.paperclip/instances/default/data/backups/`. Run it first every time
  ("Install" step 3).
- **Not tested.** Restoring from that backup.

### Rollback

- **Tested.** `paperclipai update --rollback` works for a git install. Run
  twice with no agent run active: the first call moved `install.json`, the
  `current` link, the server process and the embedded PostgreSQL to
  `ba2e6f933fa5`, the second moved all four back to `98fa44c0d29b`.
  `/api/health` returned `status: ok` after each. It swaps the current payload
  with `previous[0]`, so a second rollback returns to where you were.
- **Tested.** It restarts the active service itself. No separate
  `service restart` was needed.
- **Tested.** Its exit code is not reliable on this host. Both calls exited 1
  after about 65 s with `Paperclip service did not become healthy at version
  <version>: reported no version`, although the flip and the restart had
  worked. After a rollback, ignore the exit code and check:

  ```sh
  jq -r .sha ~/.paperclip/cli/install.json        # expect the rollback target
  readlink ~/.paperclip/cli/current               # expect installs/git/<first 12 of that sha>
  paperclipai service status                      # active, healthy
  ```

  and that `/api/health` returns 200 with `status: ok`.
- **Read from source.** After the flip the CLI waits for the service to report
  the target version (`waitForHealth` in `cli/src/commands/service.ts`, 60 s).
  It reads `serverVersion` or `version` from `/api/health`. The response on
  this host has neither field (tested), so the wait always times out.
- **Limit of the test.** There were no new DB migrations between `ba2e6f933fa5`
  and `98fa44c0d29b`, so the rollback was a payload flip only. A rollback
  across new migrations is not tested; "Rollback" step 3 still applies.
- **Not tested.** The fallback by hand (restore a saved copy of `install.json`,
  point `~/.paperclip/cli/current` at the old payload directory, restart). It
  was prepared and not needed.

### `paperclipai update` on this host

**Read from source, not tested.** All points come from `updateCommand` in
`cli/src/commands/update.ts` at `98fa44c`; `update` was never run here.

- With the install as it is, `update` does nothing. `install.json` has
  `source: git` and the full SHA as `ref`. For a git install whose `ref` is a
  SHA, `update` prints "Git install is pinned at ..." and returns: no backup,
  no new payload, no restart.
- `update` does not switch a git install to an npm release. It only installs
  from npm when the managed install came from npm.
- The automatic rollback applies to a git install made from a moving ref (a
  branch or tag name). There `update` resolves the ref, builds the new commit,
  restarts the service and waits for the same version check that fails for
  `update --rollback`. A failed check triggers
  `rollbackAfterServiceValidationFailure`, so on this host that update would
  most likely undo itself and report a failure. "Install" step 1 already
  forbids installing a branch name; this is one more reason.
- So `update` is not a way to change the build here. Use
  `install --repo llwt/paperclip --ref <sha>` for every change of build.

### Restarts end running agent runs

State at the install (12:24 UTC), before any change to the service unit:

- **Tested.** `paperclipai service restart` was not a hot restart: it ended
  every running agent run, including the run that issued it (that run exited
  143, which is SIGTERM). Issue the restart from a place that survives it, or
  expect the task to be resumed by a later run.
- **Tested.** Server log of the restart at 12:24:30 UTC. Old server:

  ```
  ERROR: hot-restart shutdown preparation failed; falling back to graceful heartbeat run drain {"signal":"SIGTERM"}
      caused by: Error: read ECONNRESET
  ERROR: graceful heartbeat run drain failed {"signal":"SIGTERM"}
  ERROR: Embedded PostgreSQL exited unexpectedly; attempting recovery
  ```

  New server:

  ```
  WARN: hot-restart intent present but shutdown snapshot is missing; no runs can be adopted
  ```

  The failed query in the first error reads `heartbeat_runs`.
- **Tested.** `systemctl --user show paperclipai.service -p KillMode` reported
  `control-group`. The unit and its drop-ins set no `KillMode`.
- **Likely cause.** With `control-group` systemd sends SIGTERM to every process
  of the service at once. The embedded PostgreSQL goes down while the server
  still needs it to write the snapshot of its running runs, and the agent
  processes get the same SIGTERM directly. The trial below fits this
  explanation.
- **Read from source.** The unit the CLI generates
  (`cli/src/services/service-manager.ts`) sets no `KillMode`, on this fork and
  on upstream. This is an upstream gap, not a fork patch. It is not reported
  upstream.

Trial of a fix (NX-597, drop-in `40-kill-mode.conf` with `KillMode=process`,
llwt/configs PR #24). The drop-in is on chungus since 13:25 UTC on 2026-10-07.
It is a trial under review, not an accepted fix, and it has open defects:

- **Tested, one restart.** With the drop-in, `paperclipai service restart` at
  13:25 UTC kept all 4 live `claude_local` runs: `hot-restart-report.json`
  shows 4 `adoptedRunIds` and no `lostRunIds`, and health was `ok` after about
  4 s.
- **Tested, defect.** A kept run finishes its work but then ends as
  `interrupted` (`orphaned_running_run`), with no log, usage or session id
  recorded after the restart.
- **Tested, defect.** The kept runs left their environment lease unreleased.
  The next wake on such a task is deferred and no run starts until the lease
  is released by hand. Seen on three tasks after that one restart.
- **Read from source, not tested.** After a hard server crash under
  `KillMode=process`, PostgreSQL and agent processes are left running.
- **Not tested.** `codex_local` runs across a restart, and whether the next
  run resumes the session of a kept run.

Until NX-597 is closed and this section is updated: check
`systemctl --user show paperclipai.service -p KillMode` before a restart.
With `control-group`, every running agent run ends. With `process`, expect
nothing beyond what the one trial showed: 4 `claude_local` runs were kept in
one restart, each with the two defects above, and `codex_local` runs are
untested. Check every task that had a run across the restart.
