# llwt/paperclip fork

This fork exists only to run a few fixes on the Nrwl instance before upstream
(`paperclipai/paperclip`) ships them. It is temporary. The target is an empty
inventory below, at which point the instance returns to plain upstream releases
and this fork is retired.

- Mainline: `nrwl-main`. Installs pin a full commit SHA on it. The branch is
  protected: GitHub rejects any commit that has no green `nrwl-ci`, and the
  process sends every change through a pull request (see "CI gate").
- `master` is a pure mirror of upstream `master`. Never commit to it.
- Fork-only files: this file, `.github/workflows/nrwl-ci.yml` and
  `scripts/nrwl-ci-server-other.mjs`. Everything
  else is upstream code plus the patches listed below.

## Inventory of fork-only commits

Base: upstream tag `v2026.1005.0` (`467125faf`), merged on 2026-10-07 (it
contains `v2026.1001.0`). Last refreshed 2026-10-07 against upstream `master`
`b31558064`, which is 170 commits past that tag. `v2026.1005.0` was the latest
stable tag on that day. The commits below are the ones on `nrwl-main` before
the merge; what is left of each is the diff of `nrwl-main` against the tag.

| Commit | What | Upstream status | Drops out when |
| --- | --- | --- | --- |
| `25fcf9633` | Gateway: configurable tool timeout, connection stays listed after a tool timeout | Not submitted. Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is ready | The upstream PR from the port branch lands |
| `669a157cb` | Gateway: approved execution budget stays fixed, timeout env values bounded | Not submitted. Same port branch | Same PR |
| `0d78b3d67` | Gateway: summarize the stream when no message matches the `tools/call` request ID | The selection by request ID is upstream since `v2026.1001.0` and the fork's own copy was dropped in the `v2026.1005.0` merge. The stream summary is not upstream. As upstream does, a malformed `tools/call` response marks the connection errored | Same PR |
| `ba2e6f933` | Gateway: known method labels only, skip non-JSON stream events | Not submitted. Same port branch | Same PR |
| `0fc5dd88b` | UI: remount the composer takeover card per pending input (fork PR #1) | Open upstream as paperclipai/paperclip#15121, no review yet | #15121 lands and that release is merged |
| `200a198f0` | Tools: offer sign-in when a custom MCP server answers 401 without `WWW-Authenticate` (fork PR #2) | Not submitted. Port branch `fix/mcp-401-sign-in-without-challenge` (`e0ffbf2f6`) is ready. The port branch also reduces the `x-amzn-remapped-www-authenticate` hint to its metadata address, which `nrwl-main` does not do yet | The upstream PR from that port branch lands and that release is merged |
| fork PR #7 | CLI: `install --ref` builds `server/ui-dist`, copies `skills`, stages real workspace dependency versions, and works with `ignore-scripts=true` (see "Install") | Not submitted. Upstream `master` (`a1ab55a56`) has the same code. Upstream issue #15026 and open upstream PR #13928 cover the staging faults, not the `ignore-scripts` ones. Port branch `nx-509-git-install-upstream` is ready, local only on chungus | The upstream PR from that port branch lands and that release is merged |
| fork PR #3, fork files | `FORK.md`, `.github/workflows/nrwl-ci.yml` and `scripts/nrwl-ci-server-other.mjs` | Fork-only by design, will not go upstream | The fork is retired |

To refresh this table:

```sh
git fetch upstream --tags && git fetch fork
git log --oneline <base tag>..fork/nrwl-main        # fork-only commits
git cherry upstream/master fork/nrwl-main           # "-" means upstream has it
git rev-list --left-right --count fork/nrwl-main...upstream/master
gh pr view <number> -R paperclipai/paperclip        # each upstream PR
```

## Rules for a change to `nrwl-main`

1. **Fork first, upstream in the same task.** A fix the instance needs now lands
   on `nrwl-main` first. The same task also produces a port branch on upstream
   `master` and the prepared upstream PR. A fix that is not urgent goes upstream
   only and arrives with a release.
2. **Every fork-only commit has an inventory row** above, with the upstream PR
   link or the reason it will not go upstream. A fork PR without its row is not
   ready for review.
3. **Mark deliberate differences in the code.** Where a patched line differs
   from upstream on purpose, say so in a comment next to it (see the "Differs
   from upstream" comment in `server/src/services/mcp-http.ts`). A release
   merge updates the tag named in such a comment.
4. **Merge commits only.** No rebase and no force push on `nrwl-main`.
5. Posting to `paperclipai/paperclip` (PR, issue or comment) is external and
   needs Steven's go-ahead each time.
6. **Every change goes through a fork pull request with a green `nrwl-ci`.**
   That covers fixes, upstream release merges, reverts and edits to this file.
   Never push to `nrwl-main` directly. This is a process rule: branch
   protection rejects a push of a commit that has no green `nrwl-ci`, for
   admins too, but it does not require a pull request (see "CI gate").

## Taking upstream releases

`nrwl-main` takes each upstream **stable release tag** by merge commit, within
7 days of the release.

```sh
git fetch upstream --tags
git switch -c merge/upstream-<tag> fork/nrwl-main
git merge --no-ff <tag>
```

- Push `merge/upstream-<tag>` to the fork and open a fork PR from it into
  `nrwl-main`. Do not squash it. The release merge has no shortcut: the merge
  commit has no `nrwl-ci` result until a PR runs it, so GitHub rejects a push
  of it straight to `nrwl-main`, and the PR merges only once `nrwl-ci` is green
  on its head. Merge it through the PR, not by a push (rule 6).
- Conflicts only appear in files the fork patched. Where a port branch exists
  for the file, take the port branch version, and keep the "Differs from
  upstream" comments.
- After the merge, refresh the inventory: remove rows that upstream now carries.
- Sync the fork's `master` from upstream in the same task.
- Exception: merge a specific upstream `master` commit only when one upstream
  fix is needed early, and record the reason in the PR.

## CI gate

`.github/workflows/nrwl-ci.yml` runs on every pull request into `nrwl-main`, on
GitHub-hosted runners: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm build`, and the suites of `pnpm test:run` split into parallel lanes with
upstream's own shard flags. Upstream's server shards pick files by path rules
and miss a few that the unsharded run includes, so one extra lane ("server
other") runs every server project test file that no shard selects. The list is
computed by `scripts/nrwl-ci-server-other.mjs` (fork-only) from vitest's own
collection minus the shards' dry-run selection; `--list` prints it. The
`nrwl-ci` check is green only when every lane passed.

`.github/workflows/pr.yml` is upstream's and calls upstream's reusable
workflow at upstream `master` (`pr-trusted.yml@master`). It is left untouched
so it never conflicts with an upstream merge. It does run on fork pull
requests (it passed on fork PR #3), but its definition follows upstream
`master`, not the code on `nrwl-main`, so it is extra signal and not the gate.

**Red test baseline: empty.** No test is allowed to fail. The two tests that
were red on `nrwl-main` (`tool-access-service.test.ts`, "executes allowed test
calls as a board user while attributing the selected agent" and "drives an
ask-first test call through its live lifecycle") pass on clean `v2026.916.1`.
They failed only with the fork's request ID selection (`0d78b3d67`), because
their fixtures answered with a fixed ID. Fork PR #3 fixed the fixtures the same
way upstream did in `v2026.1001.0`. If a test is ever red on a clean upstream
tag, record it in a baseline file next to the workflow, make the gate "no
failures outside the baseline", and never skip or delete the test.

### Branch protection

`nrwl-ci` is a required status check on `nrwl-main`, enforced by GitHub branch
protection. Settings as of 2026-10-06:

| Setting | Value |
| --- | --- |
| Required status checks | `nrwl-ci` only, pinned to GitHub Actions (app id 15368). It is the `gate` job of `nrwl-ci.yml` |
| Branch up to date before merging (`strict`) | Off |
| Enforced for admins (`enforce_admins`) | On |
| Force pushes | Blocked |
| Branch deletion | Blocked |
| Required reviews | None |
| Push restrictions | None |

What this means in practice:

- A pull request into `nrwl-main` cannot be merged until `nrwl-ci` is green on
  its head commit. That holds for everyone, including the admin account all
  agents use. There is no admin override.
- A direct push to `nrwl-main` is rejected when the pushed commit has no green
  `nrwl-ci`. The workflow runs only on pull requests into `nrwl-main`, so a
  commit gets that check only as the head of a pull request.
- Protection does not require a pull request (no required reviews, no push
  restrictions, no rulesets). GitHub therefore accepts a direct push of a
  commit that already has a green `nrwl-ci`, for example a fast-forward of
  `nrwl-main` to the head of an up to date pull request. Do not do this: rule 6
  makes the merged pull request the only allowed way in. That part is process,
  not something GitHub enforces.
- `nrwl-main` cannot be force pushed or deleted. To take a commit back, open a
  revert pull request.
- `strict` is off: a pull request does not have to contain the latest
  `nrwl-main` to merge. Its `nrwl-ci` result is for the merge with the base as
  it was when the run started.
- Branch protection does not require a review. The independent review and
  Steven's approval of the head SHA are process, not something GitHub enforces.
- `master` has no part in this: the protection covers `nrwl-main` only.

To inspect the live settings (read only):

```sh
gh api repos/llwt/paperclip/branches/nrwl-main/protection
```

If the output differs from the table, the table is stale: correct it in a pull
request. Changing or removing the protection is a repository setting, not a
routine step. It needs Steven's go-ahead each time, including a temporary
change to get one merge through.

## Install

An install is a deployment. It is its own task, assigned by the Coordinator
after Steven approves the SHA.

1. The target is a full SHA on `nrwl-main` with a green `nrwl-ci` run. Never
   install a branch name. By rule 6 a commit reaches `nrwl-main` only through
   a merged pull request, so an install never involves a push to `nrwl-main`.
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

A rollback changes the installed build only. It does not move `nrwl-main`,
which cannot be reset or force pushed. To take the bad commit off `nrwl-main`,
open a revert pull request and wait for a green `nrwl-ci` like any other change.

`update --rollback` flips `current` to `previous[0]` in `install.json` for any
managed install, npm or git, and restarts the active service. It does not
reverse migrations. This is read from the source
(`rollbackManagedInstall` in `cli/src/commands/update.ts`) and has not been
run on this host yet. Test it on the first install under this process and
update this section.

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
