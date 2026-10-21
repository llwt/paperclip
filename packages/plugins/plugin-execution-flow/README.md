# Execution flow: worker and data model

Fork-local package `@somnex/paperclip-plugin-execution-flow`, plugin ID
`somnex.execution-flow`. This is Step B: the read-only worker and normalized data
model. Step A's workspace SDK supplies the execution history read. No public SDK
release or npm publication is needed.

The manifest reserves the issue `taskDetailView` slot named **Execution flow** and
its `ExecutionFlow` export. The UI entrypoint is declared to satisfy the manifest
contract, but is not built in this step. Step C supplies that component. **Do not
install this package yet.** No installation or live instance verification was
performed as part of this step.

## Read contract

The worker registers just `execution-flow` through `ctx.data.register`. Call it
with the host-authorized `companyId`, an `issueId`, and an optional opaque
`cursor`. It reads the issue, then one decision page (50 records) and the issue's
interactions. It passes the cursor unchanged. The issue read resolves identifiers
to the canonical issue UUID for both subsequent reads.

The only manifest capabilities are:

- `issues.read`
- `issue.execution.read`
- `issue.interactions.read`
- `ui.detailTab.register`

There are no actions, state/database writes, jobs, event handlers, or network
calls. The package uses `@paperclipai/plugin-sdk: workspace:*`. Workers are trusted
host code; capabilities restrict host operations rather than sandboxing code.

`buildExecutionFlow` returns three independent sections:

- `execution`: current ordered stages, every configured candidate, recorded
  participant, actual current holder, return assignee, and consistency warnings.
  Completed IDs mean **Completed**. Only a retained verdict means **Approved**.
  Changes requested puts the holder back with the return assignee, even when the
  state still records a reviewer participant.
- `history`: this requested page of **Recorded decisions**, its continuation
  cursor, and decisions grouped by current or removed stage ID. Repeated verdicts
  keep their own IDs. Removed stages appear under **Stages no longer in the
  current policy**. Missing policy fields leave history unclassified. Names are
  current labels from the bounded host projection; missing labels fall back to
  stable principal IDs. No member-directory read is made.
- `confirmations`: separate **Task confirmations**, with real status, outcome,
  target, timestamp, and actual resolver. Checkbox selections and each item
  verdict's resolver are retained. Tool, secret, and connection authorization
  cards, connection intents, question forms, and task suggestions are omitted.
  Cards never change native stage progress.

Explicit null execution fields mean no configured policy/state. Absent SDK fields
mean **Execution data unavailable**. A failed or unsupported history call means
**Decision history unavailable**, with `hasMore: null`; current stages remain.
A failed interaction call means **Task confirmations unavailable** independently.
An unavailable/foreign issue or failed issue read rejects the handler; the future
view must show that error rather than an empty successful result.

History is retained records only, never a complete all-time audit. Deletion and
policy replacement can remove context. `hasMore: false` means the returned page
has no continuation, not that every historical decision still exists.

## SHA evidence

The default is **Not recorded**. Only a full 40-hex value explicitly labeled
`Head SHA:` in a decision's own body or a card's own prompt/details becomes
**Reported head SHA**. The exact matched excerpt is retained with the normalized
hash. Conflicting labeled full hashes are **Ambiguous**. Repeated case variants
of the same hash are not conflicting. Bare hashes, partial hashes, target
revision IDs, card results, and work products are not SHA evidence. A reported
hash is not verified against GitHub.

Bodies and card text remain plain strings. The future component must render them
as text or sanitized SDK Markdown. It must clear old data on task/company changes,
ignore late requests, refresh on focus/manual refresh, show refresh time, and
append/deduplicate loaded decision pages by ID. Refresh restarts pagination. The
worker is stateless and never polls or automatically drains history pages.

## Development and checks

The repository CLI scaffold created this package. The generated folder was renamed
to `plugin-execution-flow`. Unused starter actions, events, and UI were removed.

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @somnex/paperclip-plugin-execution-flow test
pnpm --filter @somnex/paperclip-plugin-execution-flow typecheck
pnpm --filter @somnex/paperclip-plugin-execution-flow build
pnpm test:run
```

Package tests are registered in root `vitest.config.ts` and in the stable runner's
non-server project list, so both the root gate and its workspace CI lane execute
them. Fixtures cover no/two/four stages, repeated types and decisions, candidates
and actual holders, human escalation, changes requested, completed-without-verdict,
policy replacement, missing fields/names, partial failures, card statuses and
resolvers, authorization-card exclusion, pagination, and conservative SHA evidence.
The worker tests reject access to any host surface other than data registration
and the three read methods, and exercise the workspace SDK harness too.
