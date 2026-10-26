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

Base: upstream tag `v2026.1023.0` (`1b4c80381`), merged on 2026-10-24 (SX-2057;
it contains `v2026.1012.0`). The tag is upstream `master` at `1b4c80381`
(2026-10-11). Last refreshed 2026-10-24 against upstream `master` `100477e88`,
which is 561 commits past that tag. `v2026.1023.0` was the latest stable tag on
that day. The commits below are the ones on `somnex-main` before the merge; what
is left of each is the diff of `somnex-main` against the tag.

Upstream split `server/src/services/heartbeat.ts` into
`server/src/services/heartbeat/*.ts` in this tag. The fork's heartbeat patches
now sit in the module that holds the code they change (`run-control.ts`,
`queue.ts`, `recovery.ts`, `run-state.ts`, `run-completion.ts`,
`run-preparation.ts`, `runtime-execution.ts`, `workspaces.ts`,
`workspace-preparation.ts`); fork state shared across modules stays in
`heartbeat.ts` and reaches the modules through their dependency objects.

| Commit | What | Upstream status | Drops out when |
| --- | --- | --- | --- |
| SX-1677 (this PR; code SX-1746, test SX-1747) | Heartbeat: a run adopted after a hot restart whose child then ends gets its real result, not `process_lost`. Only the CLI engines `claude_local` and `codex_local`. The reaper (`reapOrphanedRuns`, `decideAdoptedRunResult` in `server/src/services/adopted-run-result.ts`, `server/src/services/heartbeat/adopted-result-recovery.ts`) reads the provider's final event (Claude `result`, Codex `turn.completed` or `turn.failed`) from the run log through the adapter hook `recoverResultFromOutput`, but only when the output tail wrote its "reached the end of the child's output" receipt and the log is intact; the run then ends `succeeded` or `failed` through the shared finalizer (`completeRun`, source `adopted_output`), with its cost, session and summary. The OS exit code of an adopted child is unknown, so `exitCode` stays null and `resultJson.hotRestart.resultRecovery` records `exitCodeKnown: false`. When the final event is missing or damaged, the receipt is absent, or the log has a gap, the run still ends `failed` with `process_lost` plus one bounded retry. `server/src/__tests__/adopted-run-restart-proof.test.ts` proves it after one and two hot restarts, with synthetic child output and no real provider | Local only. Related upstream: paperclipai/paperclip#11624 (open). Upstream master `def4726be` still marks these runs `process_lost` | An upstream release records the final result of adopted runs |
| SX-2418 (this PR) | Heartbeat: after a reassignment stops the former owner's run (`issue_reassigned`, `reassignmentStopConfirmed`), the new owner's `issue_assigned` wake behind that run (`execution_owner_active`) is saved as `deferred_issue_execution` also without a comment, and the saved hand-off path of SX-1386/SX-1537 starts it: after the lease release, on the owner-exit recheck and on the `resumeQueuedRuns` sweep, without an earlier run of the new owner. Admission rechecks under the issue lock that the wake's agent still owns the open task and that the latest run on the task is that confirmed stop of another agent with cleanup done (`readAssignmentHandoffPredecessor`), then settles the saved receipt and older saved assignment wakes of that owner with the one successor run; a wake for a former assignee is cancelled. Operator Stops, self-reassignment, holds, pauses, dependencies and budget gates still give no run. Before, the release skipped the acknowledged stop and the periodic retry needed a prior run of the target agent, so these wakes waited for hours (SX-2268, SX-1608, SX-2393; SX-2413 `report`) | Local only. Upstream `master` `391dd15ff` (#16673) drops the target-agent filter of the stranded-queue retry (that shape is reused here) but still stops the release on the acknowledged cancellation and scans only comment or interaction wakes; in no stable tag | An upstream release promotes the new owner's saved assignment wake after a confirmed reassignment stop |
| SX-2390 (this PR) | Runs: a late legacy controller lease renewal no longer cancels a run. `renewLegacyControllerLease` keeps the `status = running` and boot id checks but drops the expiry check (revocation replaces the boot id on the same row); when the deadline timer fires it tries one renewal bounded by `LEGACY_CONTROLLER_DEADLINE_RENEW_MS` before it aborts. The abort reason is `LegacyControllerLeaseLostError`, logged at warn. In `completeRun` a lease-lost abort on a row this controller still owns, with a clean adapter result, finalizes as `succeeded`; a lease-lost cancel that stands gets `errorCode: legacy_controller_lease_lost` and `cancellation.source: control_plane` (`run-cancellation.ts`, also when the provider reports the cancel), unless a Stop recorded on the row after the abort, which stands. An event-loop stall of about 70 s on 24 Oct aborted all 18 live runs and turned a clean CLI run into a `cancelled`/`unknown` hold (SX-2385 `root-cause`) | Local only. Upstream `master` `50797ea03` still requires an unexpired lease to renew (it added a liveness pool and retries, which do not cover an event-loop stall) and lets `signal.aborted` win in `completeRun` | An upstream release stops treating a late renewal as a lost lease and keeps a clean result after an abort with no effect |
| SX-2419 (this PR) | Execution blocker: a resolved no-replay hold written before fork #79 for a confirmed reassignment stop (`errorCode: issue_reassigned`, `reassignmentStopConfirmed: true`) no longer blocks the task for any assignee, including the source agent. `execution-blocker.ts` skips it when the run is terminal, has no live controller lease, process (pid) or active environment lease, and no outstanding workspace restore; `isConfirmedReassignmentStop` in `run-cancellation.ts` is shared with `legacy-execution-recovery.ts`. The recovery action is kept as audit history; no data migration (SX-1603 was blocked since 22 Oct) | Local only. Upstream has no reassignment stop classification | Upstream stops writing and honoring no-replay holds for deliberate stops, and no pre-#79 holds remain |
| SX-2509 (this PR) | Runs: a run that changes its own task (hands it off, closes it, cancels it) ends `succeeded`, not `cancelled`. The issue PATCH route still stops the requesting agent's own run first (same fence, locks and `issueMutationStopId`); after the change commits, `recordSelfHandoffOutcome` in `run-control.ts` relabels that one stop as `succeeded` with `resultJson.selfHandoff: true` and `selfHandoffStop` (kind, the stop's `errorCode` and `error`). While an executor in this server still cleans the run up, the run stays `cancelled` and the executor finalizes the outcome when it settles. The dispatch-time `continuation_task_ownership_changed` cancel and the live "run cancelled" toast are unchanged here (SX-2550, SX-2551). Readers of the reassignment stop (`isConfirmedReassignmentStop`, `confirmedReassignmentStopRunSql`, `readAssignmentHandoffPredecessor`, the assignment hand-off source check, `getConversationOwnershipBlocker`) and `agentRunWritesRevoked` accept the self hand-off shape. Changes by anyone else cancel as before. No migration | Local only. Upstream records every stop as `cancelled` | Upstream records a self-made task change with the run's real result |
| SX-2551 (this PR) | Live updates: the stop of a run that changes its own task gives no "run cancelled" toast. The issue PATCH route marks the stop of the requesting agent's own run with `resultJson.selfHandoffRequested: true`; `buildHeartbeatRunStatusLiveEventPayload` then adds `selfHandoffRequested: true` to that transient `cancelled` status event and `buildRunStatusToast` in `LiveUpdatesProvider.tsx` shows nothing for it. The `succeeded` event from SX-2509 shows nothing either. When the change does not complete (the PATCH handler returns or throws before the outcome is recorded, also when `cancelRun` itself throws after it published the marked stop, because the fallback is armed before `cancelRun`; it follows the handler, not the response, so a client disconnect changes nothing; `recordSelfHandoffOutcome` refuses or throws; or the executor's finalize throws), `announceSelfHandoffStopCancelled` in `run-control.ts` publishes the stop again without the flag, so today's cancellation toast appears. `observeRunOutcome` does not remember the marked stop, so that unmarked repeat is not dropped as a duplicate. A stop by anyone else carries no flag and toasts as before. No migration | Local only. Upstream announces every stop | Upstream drops the cancellation toast for a self-made task change, or SX-2509 is dropped |
| SX-2550 (this PR) | Runs: a leftover queued wake whose task its own agent closed or handed off ends `succeeded` (`selfHandoffStop.kind: stale_continuation`), not `cancelled` with `continuation_task_ownership_changed`. When an agent changes a task's status or owner, `issueService.update` writes an `issue.version_changed_by_agent` activity entry (agent, new `statusVersion`, status and owner before and after) in the same transaction; a version raised for another reason (blocker edits, reasserted Blocked) gets none. `StaleExecutionContinuationError.observed` carries the task row the builder rejected. At dispatch, `staleTaskChangedByAgent` (`task-version-attribution.ts`) reads the task row and the entry for that observed version in one statement, and is true only when the task has not changed since and this agent's change caused the stale state (it moved the owner away from itself, or it made the status cancelled or done). The entry is internal: not published live, and left out of the activity lists, the audit feed and CSV, the plugin audit search, the work timeline, run activity counts, run liveness evidence, the routine activity gate and the issue last-activity time. A change by anyone else cancels as before, also before its `issue.updated` audit is written. No migration | Local only. Upstream cancels every stale continuation | Upstream attributes the change that made a continuation stale |
| SX-1581 (this PR) | UI: a pending `ask_user_questions` card stays counted and reachable from the composer (pending counter, "show next", reopen) after the user dismissed it or posted a later comment. It still does not reopen the takeover by itself (superseded by SX-1603: the question now stays docked). Answered, cancelled, expired and hidden (`shouldHideInteractionCard`) questions are not counted. Upstream #15229 (`59015846a`) left every question out of the composer and kept only a muted history row, so a question on SX-1460 went unseen for 18 hours. One line in `ui/src/components/TaskChatThread.tsx` (`pendingReminderInputs`), its tests, the play steps of the two unanswered-question stories, and a new story `task-chat-confirmation-and-question` | Local only (NX-1092). Upstream `master` `043f2514e` still has the #15229 rule | An upstream release counts pending questions in the composer again |
| Install smoke script (this PR) | Fork-only `scripts/somnex-smoke.mjs` checks health, installed SHA, UI assets and confirmation acceptance, then cancels its throwaway task; local fake-server coverage in `scripts/somnex-smoke.test.mjs` | Local only | An upstream release provides an equivalent install smoke check, or the fork drops this script |
| SX-1378 (this PR) | Usage: a resumed Claude CLI run stores and bills only its own tokens and cost. On `--resume` the CLI's `modelUsage` and `total_cost_usd` are session totals (only `result.usage` covers the invocation), but the adapter labelled them `per_run`, so every resumed run stored the session total and a failed run repeated the previous run's figures. The adapter now labels `modelUsage` figures `session_cumulative` (`packages/adapters/claude-local/src/server/parse.ts`, `execute.ts`), and `resolveNormalizedUsageForSession` in `server/src/services/heartbeat/run-state.ts` (called from `run-completion.ts`) subtracts the newest earlier run of the same session from the cost as well as the tokens, for `session_cumulative` only. Without `modelUsage` the tokens are per invocation but the cost is still the session total: the adapter sets `costBasis: "session_cumulative"` (`packages/adapter-utils/src/types.ts`), the server deltas only the cost (`costSource`), and stores the previous raw tokens plus this invocation's as the raw counters. Those invocation tokens count cache writes as input, as `modelUsage` does (`claudeResultUsageTotals`), so the rebuilt baseline uses the same definitions. `result.usage` misses subagent tokens, so those raw counters are marked `rawUsageIncomplete`; the next run that reports `modelUsage` then stores its own `result.usage` tokens (`usageSource: "invocation"`, adapter field `invocationUsage`) instead of a delta, and its complete totals become the baseline again. Subagent tokens of such runs go uncounted, never onto another run. A run that clears its session for the next run (max turns) is still deltaed against the session it resumed. `usage_json` keeps the cumulative cost as `rawCostUsd` for the next run; `usageSource` is `session_delta`, or `session_total` when there is no earlier usage to subtract. The baseline comes from stored rows, so it holds after a restart and for sessions started before the install (their rows hold the totals). Old rows are not rewritten. At install, set `CLAUDE_SESSION_TOTALS_UNTIL` in `maintenance/usage-audit.mjs` (SX-1376 interim script) to the install time, so the audit stops subtracting for runs after it. | Local only. Upstream `master` (`53732c811`, 2026-10-21) still labels Claude CLI `modelUsage` `per_run`. Since `v2026.1023.0` upstream also posts mid-run usage checkpoints (`createUsageCheckpointLog`) labelled `per_run`. SX-2057 keeps the parser's bases there and in the timeout result, and checkpoints name their session (`claude-local` `execute.ts`). The usage recorder (`server/src/services/usage-receipts.ts`) runs the same `resolveNormalizedUsageForSession` before it saves a receipt, so a run lost after its result checkpoint settles only its own tokens and cost and saves `rawCostUsd`, `rawUsageIncomplete` and `rawUsageSessionId` as the next run's baseline. `applyCapturedUsage` gives the heartbeat the CLI's own totals back for a session-total cost | An upstream release stores per-run usage for resumed Claude CLI runs |
| `1a88a60e3` (fork #31), SX-2057 | Usage: a resumed Codex CLI run stores, prices and bills only its own tokens. `codex exec resume` reports session totals in `turn.completed`, so the parser labels them `session_cumulative` (`packages/adapters/codex-local/src/server/parse.ts`); since `v2026.1023.0` the mid-run usage checkpoints and the timeout result in `execute.ts` do too, and checkpoints name their session (`sessionId` on `AdapterUsageCheckpoint`, `packages/adapter-utils/src/types.ts`); the checkpoint log keeps `thread.started` (`packages/adapter-utils/src/usage-checkpoint.ts`), so a fresh session is named too. The usage recorder (`server/src/services/usage-receipts.ts`) subtracts the session's newest earlier run before pricing (`priceCodexReceipt` prices per-run receipts only), saves the session totals as raw counters with `rawUsageSessionId`, and hands the totals back to the heartbeat (`applyCapturedUsage`, called in `runtime-execution.ts`), which subtracts the same baseline from the tokens and keeps the receipt's price (`costBasis: "per_run"`). `getLatestSessionUsageJson` (`run-state.ts`) also finds a run lost after a checkpoint by `rawUsageSessionId`, so the next run does not count its tokens again. Rows written before `v2026.1023.0` hold raw Codex input with cache hits; `readRawUsageTotals` subtracts those for `codex_local` when a row lacks `rawInputIncludesCached: false`. Tests: `server/src/__tests__/codex-session-usage-accounting.test.ts` | Local only. Upstream `v2026.1023.0` labels Codex CLI usage `per_run`, so a resumed run stores and prices the session total | An upstream release treats Codex CLI totals as session totals |
| SX-1495 (this PR) | CI: `somnex-ci.yml` job `install_git` runs `paperclipai install --ref` for the commit under test on node 24 with npm ignore-scripts on, and the `somnex-ci` gate needs it (see "CI gate") | Local only. Fork-only workflow, nothing to submit | The fork stops installing from git refs |
| SX-1600 (this PR) | Hot restart: before the old server exits it hands each local child's stdout/stderr pipes to a detached relay (`packages/adapter-utils/src/run-output-relay.ts`, `handOffRunningProcessOutput` in `server-utils.ts`). The relay appends them to `<instance>/data/run-output-relay/<runId>/{stdout,stderr}.log` until EOF. The adopting server tails those files from saved offsets into the run log, live log events and `lastOutputAt` (`startAdoptedRunOutputTail` in `server/src/services/heartbeat/recovery.ts`), and the reaper waits until the output is in. An adopted run without a relay (started under an older server, or a failed handoff) gets `resultJson.hotRestart.outputCapture.mode = "not_captured"` and a warn event. Before, output written after a hot restart was lost (EPIPE). The final result of an adopted run is not decided here: for `claude_local` and `codex_local` the reaper reads it from the recorded output (row SX-1677 below); every other adapter, and a run with missing or damaged output, is still settled as `process_lost` | Local only. Not checked against upstream `master` | An upstream release keeps the output of adopted children |
| SX-1457 (this PR) | Backups: both engines write to `.partial` files and publish the complete gzip by rename; server startup removes incomplete files; Install and Rollback check for a running backup before restart | Local only (SX-1456) | An upstream release writes backups to a temporary name |
| Claude quota classification (this PR) | Claude login detection ignores stream-json objects in raw stdout and gives terminal quota or transient errors priority, so a tool's `unauthorized` output cannot turn a session limit into account reauthorization | Local only | An upstream release carries an equivalent fix |
| NX-1092 (this PR) | Setup-token cleanup: exclude local subscription rows from scoped reads and writes, clear records with no lease without a provider release, and log only the error class and SQLSTATE on a failed release | Local only (NX-1092). Upstream `master` `f3af9887c` has the same fault | An upstream release carries an equivalent fix |
| NX-834 (this PR) | Tools: opt-in `compact-v1` connection tool names for Claude runs. Pure helper `server/src/services/compact-connection-tool-names.ts`; narrow hooks in the named MCP route (`?toolNames=compact-v1`, unknown values rejected), `listToolsForNamedGateway` (alias projection), `findToolForSession` (alias resolution on the descriptors it already loads, after authentication) and `buildPaperclipRuntimeMcpServers` (label `p` and the versioned URL for `claude_local` agents with `runtimeConfig.connectionToolNames: "compact-v1"`), plus a Claude resume check (`packages/adapters/claude-local/src/server/tool-name-format.ts`) that starts a fresh session when the tool name format changes, because upstream now resumes across other MCP server changes. Stored names, policies, signatures and rate buckets keep the internal name. Kill switch `PAPERCLIP_COMPACT_CONNECTION_TOOL_NAMES_DISABLED=true`. Rollback: unset the agent opt-in (or set the kill switch), let compact sessions restart, then revert the binary | Local only (NX-658). Fork-specific implementation of the approved Nx plan. Related upstream: paperclipai/paperclip#15668 (open). | An upstream release provides equivalent presentation aliases without changing stored gateway identities, policy evaluation or signed approvals |
| SX-1369 (this PR) | Runs: run temp folders (`paperclip-ai-*`, `paperclip-run-*`) are removed on every end path, and resume data survives. The managed AI home gets an owner marker (company, agent, run); at run end the heartbeat writes back the credential and removes the home only when the run is terminal and neither its process id nor its process group is alive (`server/src/services/run-temp-dirs.ts`). A home with a pending credential write-back (`.paperclip-ai-writeback.json`) is removed only after that write-back runs. A sweep at startup and every 10 minutes removes marked folders whose run the lookup shows as ended for the same company and agent, skips runs whose teardown is still in progress in this server, and runs a write-back left pending by a crash before removal; unmarked folders are left alone. For local runs `provider/projects`, `provider/sessions` and `provider/archived_sessions` link to `<instance>/companies/<company>/agents/<agent>/ai-session-state/`, so Claude `--resume`, agent memory and Codex sessions outlive the temp home; a run whose links cannot be verified fails before the provider starts. Credentials stay in `/tmp`. The sandbox mounts the link targets read-write | Local only. Not checked against upstream `master` and not raised upstream | An upstream release keeps managed session state outside the temp home and sweeps folders of runs cut off by a restart |
| SX-1444 (this PR) | Runs: a managed AI run gets `MISE_DATA_DIR` and `MISE_CACHE_DIR` in `<instance>/runtime/mise/{data,cache}` and the host user's `<mise data dir>/installs` in `MISE_SHARED_INSTALL_DIRS` (`managedAiToolEnvironment` in `server/src/services/ai-connection-runtime.ts`). Before, `HOME` and `XDG_DATA_HOME` in the run's temp home made mise reinstall every tool into `/tmp/paperclip-ai-*/data/mise` on each run. mise reads the host installs and never writes them; new installs land once in the shared dir, and two runs that install the same version wait on mise's lock in the shared cache. mise state (config trust) and credentials stay in the temp home. An agent's own `MISE_*` env wins. The values are left out of the session fingerprint. A workspace sandbox mounts these dirs, the shims next to them and the `mise` binary on `PATH` read-only (`miseToolInstallMounts`), so a confined run can call `mise` or a shim and reuse tools but cannot install or change them (see "Shared tool folders in the workspace sandbox" below the table). The fresh-root sandbox also no longer binds the host's `/bin`, `/sbin`, `/lib`, `/lib64` when they are symlinks into `/usr` (merged-/usr hosts); that bind failed before with `Can't bind mount /oldroot/usr/bin on /newroot/bin` | Local only. Upstream has the same per-run `HOME` | An upstream release keeps tool installs out of the managed AI home |
| SX-1506 (this PR) | Runs: managed AI runs use `npm_config_store_dir` and `pnpm_config_store_dir` (pnpm 11 and later ignore the npm name) both set to `<instance>/runtime/pnpm/store`, `RUSTUP_HOME=<instance>/runtime/rustup` and `CARGO_HOME=<instance>/runtime/cargo`. These Paperclip-owned directories survive run cleanup, so stores and toolchains do not fill each temporary home. Agent env overrides win. Shared defaults stay out of the session fingerprint. Claude and Codex workspace sandboxes mount the selected directories read-only through `sharedToolCacheMounts`. Credentials and provider homes stay per run. No host toolchain is changed. Inside the workspace sandbox these folders are reuse only (see "Shared tool folders in the workspace sandbox" below the table) | Local only. Extends #57 for pnpm and Rust | An upstream release keeps these stores and toolchains out of the managed AI home |
| SX-1386 (this PR) | Heartbeat: a stage hand-off wake (`execution_review_requested`, `execution_approval_requested`, `execution_changes_requested`) that meets an execution blocker is saved as `deferred_issue_execution` instead of a skipped execution wait. It starts through normal admission when the blocking run releases its environment lease (`resumeDeferredExecutionStageWakes`, called from `releaseEnvironmentLeasesForRun` and `resumeQueuedRuns`), only if the task still waits on that participant. The saved row is settled in the same transaction that stores the successor run, so a failed or interrupted start leaves it saved for a retry and a retry never starts a second run. Before, the decision stopped the deciding run, its lease was still held, and the next participant got no run | Local only (NX-1092) | An upstream release saves or resumes stage hand-off wakes the same way |
| SX-1537 (this PR) | Heartbeat: a stage hand-off saved behind a stopped run whose provider process or process group is still exiting (`execution_owner_active` with no lease left) is rechecked in the server every 5 s (`scheduleOwnerExitRecheck`, `recheckOwnerExitWait`), because a process exit has no release hook. After 5 minutes the saved wakes get `executionWait.ownerExitTimedOutAt` and a warning is logged; they stay `deferred_issue_execution` and the `resumeQueuedRuns` sweep keeps retrying them. That sweep now takes the least recently tried tasks first and stamps each try, so wakes that stay blocked cannot starve the rest of its batch of 50. While a hand-off is saved, the execution blocker notice says so. `drainActiveRunExecutions` awaits a recheck already running and arms no recheck timer while it drains. Admission still checks ownership under the issue lock, so no second provider process starts on the conversation. Builds on SX-1386; the installed build before SX-1386 wrote these wakes as `skipped` | Local only. Upstream `master` `043f2514e` still drops this case; upstream `06484b3c4` (#15463) uses the same approach (keep the saved row, recheck later) for a scheduled retry of the same run, not ported | An upstream release saves and retries a wake blocked by an exiting process |
| SX-1597 (this PR) | Database: partial index `activity_log_company_source_issue_idx` on `(company_id, details->>'sourceIssueId')` for `project.created` and `company.skill_created`, so the source-issue branch of `activity.forIssue` (`GET /api/issues/:id/activity`) no longer makes every issue page read all of `activity_log`. Migration 0335 (0307 before the `v2026.1023.0` merge, renumbered after upstream's 0306-0333 with unchanged content), plain `CREATE INDEX IF NOT EXISTS` | Local only. Upstream `master` `4b958ecbd` has the same `OR` query and no index for it. Not raised upstream | An upstream release indexes or rewrites that branch. On that merge drop the fork's 0335 migration, its journal entry and snapshot, and take upstream's |
| SX-1120 (this PR) | Database: index for the `paperclipIssue` branch of `valuesForIssue`, so comment lists do not scan all `heartbeat_runs`. Migration 0334 (0306 before the `v2026.1023.0` merge, renumbered with unchanged content) | On upstream `master` since `e9b6c4d44` (paperclipai/paperclip#16278), also open PR paperclipai/paperclip#12499; not in a stable tag yet (`v2026.1023.0` does not contain it). Nothing to submit: upstream already has the fix | The first upstream release merge that contains #16278. On that merge drop the fork's 0334 migration, its journal entry and snapshot, and take upstream's |
| SX-1361 (this PR) | Runs: `runsForIssue` reads the task run list through `heartbeat_runs.id IN (... UNION ...)` (context issue id plus activity log run ids) instead of an `OR` that scans every run of the company. The company run list reads the run context once per row, takes 200 rows by default and at most 1,000 (route, service, UI client); both agent detail pages fetch an older linked run by id. Since the `v2026.1023.0` merge the UNION matches upstream's new `heartbeat_runs.issue_id` column (migration 0313, indexed), as #16713 does | `runsForIssue`: open upstream PR paperclipai/paperclip#16713 (head `df285a125`). Company run list: on upstream `master` since `ebeac833a` (paperclipai/paperclip#16286), not in a stable tag yet (`v2026.1023.0` still reads the context per column). Nothing to submit | The first upstream release merge that contains both #16713 and #16286. Take upstream's code on a conflict (upstream matches `heartbeat_runs.issue_id`) |
| `2593ef230` | CLI: pruning preserves and reports older install payloads with a live executable or working directory on Linux. Processes the installing user may not inspect (`EACCES`, `EPERM`) are skipped and not protected. Unsupported platforms and failed process checks retain payloads without failing the install | Local only (NX-658) | An upstream release guards payload pruning against live processes and failed inspection |
| `d6ca4706f` | A future scheduled check covers an agent-owned `in_progress` or `in_review` blocker with no user assignee and marks its dependency path live. Checks that cannot fire, overdue, cleared, timed out, exhausted checks and checks owned by uninvokable agents keep the previous attention result | Local only (NX-658) | An upstream release carries the same scheduled-check blocker coverage |
| `25fcf9633` | Gateway: configurable tool timeout, connection stays listed after a tool timeout | Local only (NX-658). Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| `669a157cb` | Gateway: approved execution budget stays fixed, timeout env values bounded | Local only (NX-658). Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| `0d78b3d67` | Gateway: summarize the stream when no message matches the `tools/call` request ID | Local only (NX-658) for the stream summary. The selection by request ID is upstream since `v2026.1001.0` and the fork's own copy was dropped in the `v2026.1005.0` merge. The stream summary is not upstream. As upstream does since `v2026.1023.0` (#15462), a malformed `tools/call` response leaves connection health unchanged | An upstream release carries an equivalent fix |
| `ba2e6f933` | Gateway: known method labels only, skip non-JSON stream events | Local only (NX-658). Port branch `gateway-tool-timeout-upstream` (`014ad6cb0`) is kept as a record, not to be submitted | An upstream release carries an equivalent fix |
| fork PR #24 | Gateway: the 502 error for an oversized tool response includes the byte limit. (The health part, connection health unchanged so its other tools stay listed, is upstream since `v2026.1023.0`.) | Health handling: upstream since `v2026.1023.0` (paperclipai/paperclip#15462, `50b1f95e7`), which also keeps health on invalid JSON and malformed bodies; the fork took upstream's behaviour and hint wording in the `v2026.1023.0` merge. The byte limit in the message is local only | An upstream release names the byte limit in the message |
| fork PR #27 | Tools: oversized discovery and session initialization preserve health status and diagnostics. Health probes advance only the check timestamp to retain the sweep interval. Size errors retain their reason and byte limit in caller errors and failure audits. Catalog refresh still fails and retains cached tools, or no catalog if discovery has never succeeded | Local only (NX-658) | An upstream release carries the same discovery and initialization size handling |
| SX-1603 (this PR) | UI: a pending `ask_user_questions` card stays in the composer dock and counts in the pending-input badge until it is answered, expired or withdrawn, like a confirmation card (`ui/src/components/TaskChatThread.tsx`). A later user comment or a sent message no longer takes it out of the dock; closing the dock moves it to the badge for this mount only. The per-user dismiss store `useDismissedTaskQuestions` (localStorage `paperclip:task-question-dismissals:*`) is removed, so a dismissal saved before the change cannot hide a card. Builds on SX-1581: drops its `currentPendingInputs` filter (dismissed or older than the latest user comment), and the `task-chat-confirmation-and-question` story now expects the newer question on top | Local only (SX-1602). Reverses upstream design from paperclipai/paperclip#15229 and #14613; upstream `master` `043f2514e` still hides these cards | Steven drops the patch, or an upstream release keeps pending questions docked |
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
| SX-2057 (this PR) | `pnpm-lock.yaml`: refreshed after the `v2026.1023.0` merge with `pnpm install --resolution-only --ignore-scripts --no-frozen-lockfile` (220 added lines): the tag's lockfile has no entries for the fork's workspace package `packages/plugins/plugin-execution-flow`, so `pnpm install --frozen-lockfile` failed. The NX-892 entries (`@modelcontextprotocol/sdk`, `light-my-request`) are in the tag's lockfile now, so that row dropped out | Fork-only package, nothing upstream | The fork drops the package, or the next upstream merge refreshes the lockfile again |
| SX-1397 (this PR) | AI connections: repair a false "needs reconnect" mark. Reconnect a Claude subscription with a pasted setup-token (`POST .../ai-connections/:connectionId/setup-token`), "Check again" (`POST .../ai-connections/:connectionId/revalidate`), and a re-check after a board secret-value change. Each clears both the grant mark and the connection health mark in one transaction after a read-only provider check (`server/src/services/ai-credential-check.ts`); see "Repairing a needs reconnect mark" in `doc/connections/AI-CONNECTIONS.md` | Local only (NX-1092) | An upstream release offers an equivalent repair path for a marked AI account |
| SX-1134 (this PR) | Workspaces: a reused shared `project_primary` execution workspace whose cwd differs from the cwd the project's primary workspace now resolves to is rebound to that cwd on the same record, with its project workspace and repo (`resolveSharedProjectPrimaryWorkspaceRebindCwd` in `server/src/services/heartbeat/workspaces.ts`). Before, a task whose shared workspace was saved in the managed `_default` folder failed `missing_git_metadata` after a repo was added to the project. Isolated, worktree, adapter-managed and sandbox workspaces, the agent fallback cwd and native recovery are unchanged | Local only (NX-658). Upstream `master` (`cde944ed7`, 2026-10-20) still restores the persisted cwd as is in `heartbeat/workspace-preparation.ts` | An upstream release rebinds a stale shared project workspace on reuse |
| SX-1431 (this PR) | Plugins: read-only `ctx.issues.listExecutionDecisions` with `issue.execution.read`, company/issue-bound cursor pagination over retained execution decisions, and a bounded projection of current principal names. SDK protocol, worker, host factory and test harness use the same public contract. No schema, route or write-path change | Fork-only extension approved for the execution flow plugin. No upstream PR or npm publication | An upstream release supplies the same scoped read contract, capability and safe principal-label projection |
| Execution flow package (this PR) | Fork-local `packages/plugins/plugin-execution-flow`: read-only execution stage/decision/card view model, four-capability manifest, worker data handler, fixture tests, and root Vitest/stable-runner registration. The `taskDetailView` UI (`ExecutionFlow`: read-only refresh, load more and collapse; sanitized Markdown; host CSS variables only; stylesheet shipped inside the JS bundle) was added in SX-1433 and verified in an isolated test instance only. No installation on any primary instance, host write path, migration, or external read | Local only. No upstream PR or npm publication | The fork drops the execution flow view or an upstream release supplies equivalent read-only behavior |
| SX-1900 (this PR) | Cases: `PUT /cases/:id/documents/:key` returns the document through `caseDocumentResponse` (top-level `key` and `body`, like GET, lock, unlock and restore), and the case page's `upsertDocument` maps the saved document with the request key. Before, the saved document had `key: undefined` and the case document editor crashed with `Cannot read properties of undefined (reading 'trim')` after the first save | Local only (NX-1092) | An upstream release returns `key` and `body` from the case document PUT |
| SX-2922 (this PR; slice 1 of 2 of SX-2878) | AI connections: one Claude usage-limit incident card per shared connection episode. When a `claude_local` run on a direct shared Anthropic connection ends `failed` with the typed `provider_quota` family, `server/src/services/claude-quota-card.ts` creates one host task (origin kind `claude_quota_incident`, `in_review`, assigned to the configured operator user, no agent assignee, no parent, no workspace or review policy) and one `request_confirmation` card (`human_only`, `continuationPolicy: none`, `supersedeOnUserComment: false`, acknowledge or dismiss only). Opt in per company with `PAPERCLIP_CLAUDE_QUOTA_CARD_COMPANY_IDS` (comma separated UUIDs, empty by default) and `PAPERCLIP_CLAUDE_QUOTA_CARD_OPERATOR_USER_ID` (no default); a missing or invalid value disables the feature with a warning and never breaks recovery. `heartbeat.ts` stores non-secret eligibility evidence (ids, key names, never values) in `contextSnapshot.claudeQuotaCardEligibility` before managed auth stripping, only for allowlisted companies; agents with their own login (`CLAUDE_CONFIG_DIR`, API key or token, base URL or cloud routing env, auth args, custom command) are excluded. `completeRun` calls a best-effort, never awaited observer after the terminal write; the existing `reconcileStrandedAssignedIssues` sweep also runs a bounded (50 per company, 48 hours) scan for missed runs. Dedupe is a company-scoped advisory lock per connection plus a durable origin lookup (`originId` is the hashed connection identity, `originFingerprint` the first failed run of the episode); a receipt is merged into the run's `resultJson.claudeQuotaCard`. An episode ends only when a successful managed run on that connection separates two failures, so acknowledgement, restart, the 7 day idempotency key cleanup, other reset text or an unknown reset never add a card. Nothing is switched, retried or rescheduled, and agent configs, connection health and retry rows are untouched. No migration. Slice 2 is the SX-2923 row below | Local only | An upstream release offers an operator notice for a shared account usage limit |
| SX-2923 (this PR; slice 2 of 2 of SX-2878) | AI connections: one-click account switch on the Claude usage-limit card. When the slice 1 card is raised and at least one other healthy Anthropic organization grant is usable by at least one listed agent, the card becomes a `request_checkbox_confirmation` (`minSelected 1`, `maxSelected 1`) whose options are the target accounts: one target is preselected and the accept label is `Switch listed agents to <name>`, several targets start with nothing chosen, the reject label is `Keep current account` and no reason is required. With no compatible target or no eligible agent (own-login agents, more than 200 agents, terminated or pending agents) the card stays acknowledgement only; pending slice 1 cards are unchanged. The bounded `claudeQuotaSwitch` payload (max 200 agents, 20 targets, source and per agent binding, expected last config revision id and a fingerprint of adapter, binding and own-login findings) is accepted only from the server: the public create route and `issueThreadInteractionService.create` reject it unless the actor system id is `claude-quota-card`. The accept route requires a board user who is the addressee, and an `agent_config:update` decision per listed agent, read before the transaction. `acceptRequestConfirmation` runs the new `claudeQuotaSwitch` mutation handler inside the existing acceptance transaction; accepting without the handler (plugin, chat channel, comment resolution) fails closed with 409 `claude_quota_switch_unavailable`, and reject, skip, expiry and withdraw never run it. `claudeQuotaCardService.applyAccountSwitch` re-checks the feature flag, host issue, source hash and bindings, locks the agent rows in id order, skips an agent that is missing, inactive, on another adapter or binding, whose last revision or fingerprint changed (including an A to B to A edit), that the caller cannot edit, or whose `select` for the target fails (reason `target_unavailable[:code]`), and otherwise calls `updateAgentConfigurationInTransaction` with only the merged `runtimeConfig.aiConnection` patch (`recordRevision.source` `claude_quota_card_switch`, `createdByUserId` the resolver). The typed `claudeQuotaSwitch` result (changed agents with revision ids, skipped agents with reasons) is stored in the interaction result and rendered by `IssueThreadInteractionCard.tsx`. Any failure rolls back the acceptance and every revision; no provider call, remote read or secret resolution runs under the locks. The shared checkbox validator no longer requires default selections to reach `minSelected` when `claudeQuotaSwitch` is present. Held tasks keep their recovery time: no wake, monitor or retry edit, no dispatcher call. The next normal run on the new account starts a fresh session through the existing account identity guard (no heartbeat change). No migration | Local only | An upstream release offers a one-click account switch for a shared account usage limit |
| fork PR #3, fork files | `FORK.md`, `.github/workflows/somnex-ci.yml` and `scripts/somnex-ci-server-other.mjs` | Fork-only by design, will not go upstream | The fork is retired |

### Shared tool folders in the workspace sandbox

The shared mise, pnpm, rustup and Cargo folders under `<instance>/runtime/`
(SX-1444, SX-1506) are mounted read-only in the workspace sandbox
(`filesystemScope: workspace`, `claude-local` and `codex-local`; mounts built in
`packages/adapter-utils/src/local-process-sandbox.ts`). This is a decision, not a
gap:

- Inside the sandbox these folders are reuse only. A run can use the tools and
  packages already in them. It cannot install new ones: `mise install`,
  `pnpm install` of a package that is not in the store, `cargo fetch` or
  `cargo build` with new crates, `rustup toolchain install`. These fail with a
  read-only error.
- A warm cache does not promise that a command works. A command can still try to
  write a lock, index or metadata file and fail.
- Paperclip does not retry a failed install without the sandbox and does not make
  the shared folders writable. Do not configure a sandboxed agent with a writable
  shared tool home.
- Only runs without the sandbox fill the shared folders. Until the rustup race
  check (SX-1665, task 5) reports, only one run at a time installs a shared Rust
  toolchain.
- Revisit this if an agent with `filesystemScope: workspace` must install tools
  during runs. That needs a new plan first for a private, per-run tool folder
  (option A of the SX-1665 plan).

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
- After the merge, disable each upstream workflow that the merge added (see
  "Upstream workflows are disabled" under "CI gate").
- Exception: merge a specific upstream `master` commit only when one upstream
  fix is needed early, and record the reason in the PR.

## CI gate

`.github/workflows/somnex-ci.yml` runs on every pull request into `somnex-main` and on every push to `somnex-main` (each merge), so the exact SHA to install has its own run, on
GitHub-hosted runners: `pnpm install --frozen-lockfile`, `pnpm typecheck`,
`pnpm build`, and the suites of `pnpm test:run` split into parallel lanes with
upstream's own shard flags. Upstream's server shards pick files by path rules
and miss a few that the unsharded run includes, so one extra lane ("server
other") runs every server project test file that no shard selects. The list is
computed by `scripts/somnex-ci-server-other.mjs` (fork-only) from vitest's own
collection minus the shards' dry-run selection; `--list` prints it. The
"Git install (node 24)" job (`install_git`) runs the CLI from the commit under
test and runs its `install --repo llwt/paperclip --ref <sha> -y` with the node
major of `.nvmrc`, `npm_config_ignore_scripts=true` and a scratch `HOME` and
`PAPERCLIP_HOME`, then checks that the installed `paperclipai --version` runs and
reports the CLI version (SX-1495). The `somnex-ci` check is green only when
every lane passed.

Until 2026-10-21 the mainline was named `nrwl-main` and the required check `nrwl-ci` (renamed on SX-1119 Step 3). Older PRs, tasks and install notes use those names.

### Upstream workflows are disabled

Every upstream workflow in `.github/workflows/` is disabled in the fork's
Actions settings (21 October 2026, SX-1363). They need upstream secrets,
runners or registry access, or they call upstream `master` (`pr.yml` runs
`pr-trusted.yml@master`), so on the fork they only failed and sent notices.
Only `somnex-ci.yml` (and `nrwl-ci.yml`, for branches made before the rename)
is active. The files stay untouched, so upstream merges stay clean.

- See the state: `gh workflow list --all -R llwt/paperclip`.
- Turn one back on: `gh workflow enable <name or id> -R llwt/paperclip`.
- A workflow file that is new in an upstream merge starts as `active`. After
  each upstream merge, run the list and disable each new upstream workflow
  with `gh workflow disable <name or id> -R llwt/paperclip`.

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

An install is a deployment. It is its own task for the Sr. Engineer, with
Steven's card on the exact SHA (Steven's decisions on SX-1481, 21 October 2026).

**When an install starts.**

- A high-priority fork fix is installed as soon as it is merged: the
  Engineering Lead creates the install task right after the merge.
- Every other merged fix waits for the fixed install at 09:00 and 15:00 UTC on
  weekdays. A routine creates a task for the Engineering Lead at those times.
  When `somnex-main` has merged commits that are not installed, the
  Engineering Lead creates the install task for the head SHA; otherwise the
  routine task is closed with no install.

**One card per install.** Steven's card on the install SHA is the only card.
The smoke checklist has no card for Steven (item 5 is an agent check).

**Only the restart waits.** When Steven accepts the card, steps 0 to 5 start at
once. Only the restart (step 7) waits, for:

- the backup check (step 6);
- the restart window agreed with Nx (NX-1306, 22 October 2026): any time, also
  during working hours, but not at minute :00 to :02 or :30 to :32 of the hour
  (UTC). No check for an Nx merge or install in flight is needed;
- only for an install with a database migration: the Nx notice. Before the
  card is posted, the Engineering Lead creates a notice task for Hog Boss with
  the SHA and the planned time, and the install task is blocked on it until
  Nx Boss has answered. An install with no migration has no notice.

**After the install.** The install task reports the installed SHA, the restart
time (UTC) and any Nx run lost in the restart (run id and task) if it can be
seen. The Sr. Engineer then creates one task with no parent for Hog Boss with
these facts and what changed for Nx; Hog Boss sends it to Nx as an FYI.

0. Test the combined SHA when it has no green `somnex-ci` run of its own (a
   pull request's run tests its own head, not `somnex-main` after a later
   merge). Extract the SHA into the task scratch dir with `git archive`, not a
   new worktree, and run `pnpm install --frozen-lockfile`, `pnpm typecheck`
   and the test files that the new pull requests add or change. Stop on any
   failure.

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
5. Run the install with node 24, not through the `paperclipai` shim:

   ```sh
   N24=/home/steven-bot/.local/share/mise/installs/node/24/bin
   PATH="$N24:$PATH" GH_TOKEN="$(gh auth token)" "$N24/node" \
     /home/steven-bot/.paperclip/cli/current/node_modules/paperclipai/dist/index.js \
     install --repo llwt/paperclip --ref <sha> -y
   ```

   Then check that the new shim names node 24:
   `grep -c 'installs/node/24' /home/steven-bot/.local/bin/paperclipai` prints a
   number above 0. If it prints 0, stop and report before the restart.
6. Check that no database backup is running. A restart during a backup cuts the
   dump off (SX-1455). Run:

   ```sh
   journalctl --user -u paperclipai --since "-2h" --no-pager \
     | grep -E "database backup (starting|complete|failed)|database backups enabled" \
     | tail -1
   ```

   If the last line says "database backup starting", a backup is running (it
   takes about 5 minutes). Wait and run the check again until the last line says
   "complete", "failed" or "backups enabled". Backups start each hour at about
   the same minute; plan the restart away from that minute.
7. `paperclipai service restart`
8. Run the smoke checklist.

Facts about `install --ref` on this host (found on NX-449 and NX-509):

- **Run the install CLI with node 24 (SX-1447, 21 October 2026).** The shim
  `~/.local/bin/paperclipai` hard-codes the node that ran the last install and
  puts its bin dir first on `PATH`. Node 25 and newer ship no `corepack`, and
  `install` runs `corepack enable pnpm`, so an install through a shim pinned to
  node 26 fails ("corepack is not a valid shim"). A `PATH` prefix alone does not
  help: the shim still runs node 26 and writes node 26 into the new shim. Step 5
  runs the CLI with node 24 (the line in `.nvmrc` and the fork CI), which has
  `corepack` and re-pins the shim to node 24. The restart in step 7 then moves
  the server to node 24 too; the install card says so. Use absolute paths:
  agent runs have their own `HOME`, so `~` and `$HOME` do not point at
  `/home/steven-bot` there.
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
2. `paperclipai service restart`, then the smoke checklist. Run the backup check
   of the Install section first, unless the server is already down.
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
5. The UI and cards work, checked by an agent (no card for Steven, SX-1481):
   `GET /` returns 200 HTML and the `/assets/*.js` file it references returns
   200; on a throwaway task, a `request_confirmation` interaction with
   `resolverPolicy: "anyone"` is posted and accepted through
   `POST /api/issues/{id}/interactions/{interactionId}/accept`, and reads
   `accepted` afterwards. Cancel the throwaway task.

`node scripts/somnex-smoke.mjs --sha <sha>` runs items 1, 2 and 5 in one go (fork-only script).

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
