# llwt/paperclip fork

This fork exists only to run a few fixes on the Nrwl instance before upstream
(`paperclipai/paperclip`) ships them. It is temporary. The target is an empty
inventory below, at which point the instance returns to plain upstream releases
and this fork is retired.

- Mainline: `nrwl-main`. Installs pin a full commit SHA on it.
- `master` is a pure mirror of upstream `master`. Never commit to it.
- Fork-only files: this file and `.github/workflows/nrwl-ci.yml`. Everything
  else is upstream code plus the patches listed below.

## Inventory of fork-only commits

Base: upstream tag `v2026.916.0` (`dffc2b3ca`). Last refreshed 2026-10-05
against upstream `master` `1c07b5903` and the latest stable tag `v2026.1001.0`
(`8f8a0ab7e`). `nrwl-main` (`200a198f0`) was 7 ahead and 342 behind upstream
`master`, and 77 behind `v2026.1001.0`.

| Commit | What | Upstream status | Drops out when |
| --- | --- | --- | --- |
| `d554c4789` | UI: composer stays available while pause state loads (upstream #13562) | Upstream's own `v2026.916.1` hotfix, not ours | Any merge of a later stable tag |
| `25fcf9633` | Gateway: configurable tool timeout, connection stays listed after a tool timeout | Not submitted. Port branch `gateway-tool-timeout-upstream` (`534d5ebd1`) is ready | The upstream PR from the port branch lands |
| `669a157cb` | Gateway: approved execution budget stays fixed, timeout env values bounded | Not submitted. Same port branch | Same PR |
| `0d78b3d67` | Gateway: pick the `tools/call` response by request ID, summarize the stream when none matches | Partly upstream: `v2026.1001.0` also selects by request ID. The stream summary is not upstream | Same PR, smaller after the `v2026.1001.0` merge |
| `ba2e6f933` | Gateway: known method labels only, skip non-JSON stream events | Not submitted. Same port branch | Same PR |
| `0fc5dd88b` | UI: remount the composer takeover card per pending input (fork PR #1) | Open upstream as paperclipai/paperclip#15121, no review yet | #15121 lands and that release is merged |
| `200a198f0` | Tools: offer sign-in when a custom MCP server answers 401 without `WWW-Authenticate` (fork PR #2) | Not submitted. Port branch `fix/mcp-401-sign-in-without-challenge` (`cb19b98d4`) is ready | The upstream PR from that port branch lands and that release is merged |
| fork PR #3, test commit | Tests: three test-call fixtures in `tool-access-service.test.ts` answer with the request ID. Needed by `0d78b3d67` | Identical change is in upstream `v2026.1001.0` | The `v2026.1001.0` merge |
| fork PR #3, fork files | `FORK.md` and `.github/workflows/nrwl-ci.yml` | Fork-only by design, will not go upstream | The fork is retired |

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
   from upstream" comment in `server/src/services/mcp-http.ts`).
4. **Merge commits only.** No rebase and no force push on `nrwl-main`.
5. Posting to `paperclipai/paperclip` (PR, issue or comment) is external and
   needs Steven's go-ahead each time.

## Taking upstream releases

`nrwl-main` takes each upstream **stable release tag** by merge commit, within
7 days of the release.

```sh
git fetch upstream --tags
git switch -c merge/upstream-<tag> fork/nrwl-main
git merge --no-ff <tag>
```

- Open a fork PR from `merge/upstream-<tag>` into `nrwl-main`. Do not squash it.
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
upstream's own shard flags. The `nrwl-ci` check is green only when every lane
passed.

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

## Install

An install is a deployment. It is its own task, assigned by the Coordinator
after Steven approves the SHA.

1. The target is a full SHA on `nrwl-main` with a green `nrwl-ci` run. Never
   install a branch name.
2. Record the current `sha` from `~/.paperclip/cli/install.json`. List the
   migrations the new commit adds: `git diff --stat <old> <new> -- packages/db/src/migrations`.
3. Confirm a fresh database backup exists (`/api/health` reports
   `databaseBackup.status: ok`).
4. `paperclipai install --repo llwt/paperclip --ref <sha> -y`
5. `paperclipai service restart`
6. Run the smoke checklist.

## Rollback

1. `paperclipai update --rollback` (flips to the retained previous payload), or
   `paperclipai install --repo llwt/paperclip --ref <previous sha> -y`.
2. `paperclipai service restart`, then the smoke checklist.
3. If the new build ran migrations, the old code may not work on the new
   schema. Rollback then also means restoring the database backup from install
   step 3.

Not verified yet: whether `update --rollback` works for a git install, and
whether `install` takes its own database backup the way `update` does. Test
both on the first install under this process and update this section.

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
