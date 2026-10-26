# Adapter Authoring Notes

In-repo notes for adapter authors. The user-facing guide lives at
[`docs/adapters/creating-an-adapter.md`](../../docs/adapters/creating-an-adapter.md);
this file holds invariants that are easy to violate from inside the adapter
package itself.

## Process launch contract (agent process isolation)

When `server.agentProcessIsolation.mode` is `systemd`, every agent process tree
runs in its own systemd user scope under a low-weight slice, and Paperclip
stops the whole scope on cancel, timeout and restart. See
[`docs/deploy/agent-process-isolation.md`](../../docs/deploy/agent-process-isolation.md).

External adapters are covered only if they use the shared launch contract.
An adapter that calls `child_process` itself stays in the server cgroup,
starts its provider before any scope exists, and can leave descendants behind.
Use the helpers from `@paperclipai/adapter-utils/server-utils` and
`@paperclipai/adapter-utils`:

| Need | Use |
|------|-----|
| Start the provider of a run and stream its output | `runChildProcess(runId, command, args, { cwd, env, timeoutSec, graceSec, onLog })` |
| Start a long-lived process you manage yourself | `spawnScoped` |
| Run a short command and read its output | `execFileAuxiliary` (or `execFileScoped` for a run-owned command) |
| Synchronous short command | `execFileSyncAuxiliary` or `spawnSyncScoped` |

Rules:

- Pass the run id from `ctx.runId` so the scope is owned by the run.
- Do not use `detached: true`, `setsid`, `nohup`, `unshare` or `systemd-run`.
  A launch that leaves the scope cannot be stopped with the run.
- Do not wrap the provider in your own shell or launcher that starts it a
  second way. Hand the final command to the helper once.
- If the host cannot isolate the process, the helper runs it once in the
  original cgroup and writes a degraded line to the run log. Do not retry.

`packages/adapter-utils/src/test-support/external-adapter-fixture.ts` is a
conforming adapter. Its test starts it under a real user manager and checks
that the provider's first action runs inside the slice and that a descendant
that called `setsid` is stopped when the run times out.

Check a package before you ship it:

```sh
pnpm check:process-launches --external path/to/my-adapter
```

The check parses the package source and exits non-zero on any raw launch
site. It cannot see a dependency that spawns on your behalf, so test that case
with the fixture above.

## No-remote-git contract (cross-run persistence)

The local execution-workspace cwd is the only persistence boundary across
runs. No adapter may depend on a git remote for cross-run state.

Why: Paperclip resolves a local execution workspace (a worktree) for each
heartbeat. Code state is carried forward by syncing that local cwd to wherever
the agent actually runs — over ssh, into a sandbox, into a managed runtime —
and then syncing changes back when the run finishes. Treating a `git remote`
as the source of truth (`git push` from inside the agent, fetch on the next
wake) breaks dependent issues that are gated on the local worktree being
caught up, and breaks isolated execution workspaces that have no remote
configured at all.

How to apply:

- Never `git push` from adapter runtime code. Never assume the local worktree
  has any `git remote` configured. If you need data from the previous run,
  read it from the local cwd Paperclip handed you.
- If your adapter runs the agent on a different host (ssh, sandbox, remote
  container), use the round-trip helpers in `@paperclipai/adapter-utils`:
  [`prepareWorkspaceForSshExecution`](../adapter-utils/src/ssh.ts) bundles the
  local cwd to the remote dir before the run, and
  [`restoreWorkspaceFromSshExecution`](../adapter-utils/src/ssh.ts) syncs
  remote-side changes (including new git commits) back into the local cwd
  after the run. Both run with no `git remote` configured.
- If your adapter runs the agent locally, you can read and write the cwd
  directly — same invariant applies: changes that future runs need must live
  in the local cwd by the time `execute()` returns.
- A failed sync-back is a run-level error. The heartbeat records
  `workspace_finalize=failed` on the execution workspace, which gates
  dependent issue wakes until the next successful finalize. Do not swallow
  restore errors.
- A transported workspace copy *may* carry the local workspace's `origin`
  remote URL so that branches in the copy stay publishable by the agent or an
  operator who holds credentials — the transport helpers copy the URL as
  metadata only. The copy is allowlist-based and fails closed
  (`sanitizeGitRemoteUrl`): http(s) URLs are stripped of userinfo, query, and
  fragment; `ssh:`/`git:` scheme URLs are stripped of password and query;
  scp-like `user@host:path` passes through (the syntax has no password slot);
  every other shape — filesystem paths, unknown schemes — is dropped rather
  than risk persisting an embedded secret. This does not weaken the contract:
  sync-back through the local cwd remains the only cross-run persistence
  path, the helpers never fetch from or push to that remote, and a workspace
  without an `origin` transports exactly as before.

The invariant is pinned by the `no-remote-git contract` case in
[`packages/adapter-utils/src/ssh-fixture.test.ts`](../adapter-utils/src/ssh-fixture.test.ts),
which asserts that a remote-only commit propagates to the local worktree
through `prepareWorkspaceForSshExecution` → `restoreWorkspaceFromSshExecution`
with no git remote configured at any point.

A static check enforces the rule before runtime ever sees it:
[`scripts/check-no-git-push.mjs`](../../scripts/check-no-git-push.mjs) scans
adapter and runtime source (`packages/adapters/`, `packages/adapter-utils/`,
`server/src/`, `cli/src/`) and fails the `policy` CI job if any unapproved
`git push` invocation is added. If you are building an operator-configured
path that legitimately must push, add a
`// paperclip:allow-git-push: <reason>` comment on the line (or the line
above) so the opt-in shows up in code review.

For the architecture-level write-up of cross-run persistence, see
[`docs/guides/board-operator/execution-workspaces-and-runtime-services.md`](../../docs/guides/board-operator/execution-workspaces-and-runtime-services.md#cross-run-persistence-no-remote-git-contract).
