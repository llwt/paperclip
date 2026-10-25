# Execution flow: worker, data model and task page view

Fork-local package `@somnex/paperclip-plugin-execution-flow`, plugin ID
`somnex.execution-flow`. Step B is the read-only worker and normalized data
model; Step C is the task page view. Step A's workspace SDK supplies the execution
history read. No public SDK release or npm publication is needed.

The manifest declares the issue `taskDetailView` slot named **Execution flow**.
Its `ExecutionFlow` export lives in `src/ui/index.tsx` and builds to
`dist/ui/index.js`. **Nothing installs this package automatically.** Install it
only into an isolated, non-primary instance with the host's plugin install route
(local path to this package directory).

## Task page view

The component is read-only. Its only controls are **Refresh**, **Load more**,
**Collapse all** and the per-record disclosure buttons. It shows ordered stages
with configured participants and the current or returned holder, **Recorded
decisions** (native stage decisions, with actor type, name, ID and a timestamp with
time zone), **Stages no longer in the current policy**, and a separate **Task
confirmations** list. A card response is never shown as a stage decision.

Decision and card text is rendered through the SDK `MarkdownBlock`, which
sanitizes it. The view reloads when the task or company changes (the component is
keyed by both, and the worker echoes a `subject` that the view checks, so a late or
mismatched response is discarded), on Refresh, and on window focus or becoming
visible (at most once a second, never while loading or hidden). It never polls and
shows the last refreshed time.

The host loads only the plugin's JavaScript, never its CSS, so the stylesheet is
shipped in the bundle as a `<style id="execution-flow-styles">` element. It uses
the host's semantic CSS variables (`--foreground`, `--border`, `--card`,
`--status-task-icon-*` and so on) and no literal colors, so the root `.dark` class
switches the theme without code here. `react`, `react/jsx-runtime` and
`@paperclipai/plugin-sdk/ui` are provided by the host and are build externals.

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
**Reported head SHA**. A hash can have one optional backtick on each side. The exact
matched excerpt is retained with the normalized hash. Conflicting labeled full hashes
are **Ambiguous**. Repeated case variants
of the same hash are not conflicting. Bare hashes, partial hashes, target
revision IDs, card results, and work products are not SHA evidence. A reported
hash is not verified against GitHub.

Bodies and card text remain plain strings and the view renders them as sanitized
Markdown. The view clears old data on task/company changes, ignores late responses,
refreshes on focus and manual refresh, shows the refresh time, and appends and
deduplicates loaded decision pages by ID. Refresh restarts pagination. The worker
is stateless and never polls or automatically drains history pages.

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
UI tests (jsdom, with a `usePluginData` double that keeps old data on parameter
change like the host does) cover read-only controls, stylesheet injection, separate
decision and card lists, disclosure state, load-more dedupe, task and company
switching with late responses ignored, error and empty states, and a check that the
stylesheet has no literal colors. The worker tests reject access to any host surface other than data registration
and the three read methods, and exercise the workspace SDK harness too.
