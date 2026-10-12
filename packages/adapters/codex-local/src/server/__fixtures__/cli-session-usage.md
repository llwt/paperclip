# Codex CLI session usage fixture

`cli-session-usage.json` contains only token counters from two consecutive local
CLI runs captured on 2026-10-11 with Codex CLI 0.160.1. The first run started a
new session. The second used `codex exec resume` for the same session.

The `completed` entries retain the input, cached-input and output counters from
each run's `turn.completed.usage` JSONL event. The `requests` entries retain the
corresponding rollout `token_count.info.last_token_usage` counters. Repeated
token-count events with unchanged `total_token_usage` were excluded. There are
27 fresh-run requests and 9 resumed-run requests. No prompts, messages, session
identifiers, user paths, or credentials are retained.

| Counter | Fresh session total | Resumed session total | Resumed request sum |
| --- | ---: | ---: | ---: |
| Input | 2,167,518 | 3,275,949 | 1,108,431 |
| Cached input | 2,063,744 | 3,149,568 | 1,085,824 |
| Output | 10,615 | 14,017 | 3,402 |

The CLI completion counters match the rollout's `total_token_usage`, including
the earlier run. Their difference matches the resumed request sum. Cached input
is already included in input. This fixture establishes cumulative CLI semantics
for version 0.160.1. Other CLI versions were not verified.
