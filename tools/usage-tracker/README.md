# Superpowers Usage Tracker

Hook-driven usage tracking for the **GitHub Copilot CLI**, shipped with the
superpowers plugin. It records — per **feature / task / phase** of the
development workflow — how much **AI credit** and **token** usage and
**wall-clock time** each part consumes, tagged with datetime, into a SQLite
schema built for ad-hoc analysis. It also surfaces a live list of **subagents
and what each is working on**.

## What it records

The Copilot CLI fires lifecycle hooks; `tracker.js` turns them into rows:

- **sessions** — one per CLI session (cwd, repo, branch, model).
- **tasks** — one per user-prompt turn. `feature` = the git branch.
- **phases** — one per `skill` activation (brainstorming, writing-plans,
  requesting-code-review, …) plus an implicit `root` phase per task. Carries the
  AI-credit/premium/cost deltas and output-token sums for that phase.
- **spans** — child tool invocations under a phase.
- **subagents** — every dispatched subagent with its `description` (what it is
  working on), start/stop, and a *reliable-only* duration.
- **usage_snapshots** — raw cumulative usage captured by the statusline, the
  source for phase deltas.

See the full schema and rationale in
`docs/superpowers/specs/2026-06-08-superpowers-usage-tracking-design.md`
(in the parent `agentharness` repo).

## How usage is attributed

No hook carries token/credit data, so:

- **Credits / premium / cost**: `statusline.js` snapshots the CLI's cumulative
  `statusObject` figures on every render into `usage_snapshots`. A phase's usage
  is the **delta** of snapshots across its time window.
- **Tokens**: summed from the session transcript (`events.jsonl`). The local
  transcript exposes **output** tokens only, so `input_tokens` is reserved
  (NULL) locally; `output_tokens`/`total_tokens` are populated.

## Install

Tracking **hooks** load automatically when the plugin is installed via
`/plugin`. The **statusline** must be wired once (a plugin manifest cannot set
it):

```bash
node vendor/superpowers/tools/usage-tracker/install.js   # sets settings.json statusLine
node vendor/superpowers/tools/usage-tracker/uninstall.js # reverts it
```

Restart Copilot CLI after installing so hooks and the statusline load.

## Subagents CLI

```bash
node vendor/superpowers/tools/usage-tracker/subagents.js [--all] [--session <id>] [--json]
```

```
RUNNING SUBAGENTS (session 69eaae7a…)
  ▶ superpowers:implementer   "Implement Task 3: schema.sql"      00:01:42
  ▶ explore                   "Find hook payload fields"          00:00:18

3 stopped this session · 5 total
```

- Default: running subagents for the current session (from `$COPILOT_SESSION_ID`,
  else the newest session with running agents).
- `--all` also lists stopped agents; `--json` emits machine-readable output.

## Configuration

| Env var | Effect | Default |
| --- | --- | --- |
| `SUPERPOWERS_USAGE_DISABLE=1` | Disable all tracking writes (hooks no-op). | off |
| `SUPERPOWERS_USAGE_NO_PROMPT=1` | Don't store prompt excerpts (store NULL). | off |
| `SUPERPOWERS_USAGE_DB` | Override the DB path. | `$COPILOT_HOME/plugin-data/superpowers-usage/usage.db` |
| `COPILOT_HOME` | Base config dir. | `~/.copilot` |

Prompt excerpts are at most the first 120 characters; full prompt text is never
stored.

## Quick analysis

```bash
DB="${COPILOT_HOME:-$HOME/.copilot}/plugin-data/superpowers-usage/usage.db"

# Credits per skill
sqlite3 "$DB" "SELECT skill, ROUND(SUM(aiu_delta),3) FROM phases GROUP BY skill ORDER BY 2 DESC;"

# Time per phase by feature (ms)
sqlite3 "$DB" "SELECT feature, skill, SUM(duration_ms) FROM phases GROUP BY feature, skill;"

# Output tokens per feature per day
sqlite3 "$DB" "SELECT feature, date(started_at/1000,'unixepoch') d, SUM(total_tokens) FROM phases GROUP BY feature, d;"

# Subagent latency (reliable pairings only)
sqlite3 "$DB" "SELECT agent_name, AVG(duration_ms) FROM subagents WHERE duration_reliable=1 GROUP BY agent_name;"

# Most expensive tasks by credits
sqlite3 "$DB" "SELECT task_id, feature, ROUND(SUM(aiu_delta),3) c FROM phases GROUP BY task_id ORDER BY c DESC LIMIT 10;"
```

## Tests

Zero-dependency, using Node's built-in test runner:

```bash
cd vendor/superpowers && node --test 'tools/usage-tracker/test/*.test.js'
node tools/usage-tracker/tracker.js --selftest
```

## Known limitations

- **Subagent pairing:** `subagentStop` carries no agent id. When multiple
  subagents of the **same** name run concurrently, the duration cannot be
  attributed reliably; such rows get `duration_reliable=0` and a NULL
  `duration_ms`, and are **excluded from all latency/perf analysis**. Counts and
  descriptions remain correct. Always filter on `duration_reliable=1` for timing.
- **Output tokens only** locally (input tokens aren't in `events.jsonl`).
- **Snapshot cadence** bounds credit/cost delta precision to statusline render
  frequency; token sums are exact.
- The built-in **`general-purpose`** subagent historically does not emit
  subagent hooks, so those background tasks are not counted; `explore`, `task`,
  `code-review`, and plugin agents are.
- Requires `node` (with `node:sqlite`, Node 22+) or a `sqlite3` CLI fallback.

## Runtime

Pure Node, no npm dependencies. Prefers built-in `node:sqlite`; falls back to
the `sqlite3` CLI when unavailable.
