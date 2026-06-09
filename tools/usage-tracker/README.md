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
- **spans** — child tool invocations under a phase, each with its
  **`duration_ms`** (tool-use latency). Because the Copilot CLI tool hooks carry
  no shared call id, a `preToolUse` is paired with its `postToolUse` by a fast
  args fingerprint (`match_key = fnv1a(toolName + canonicalJson(toolArgs))`),
  falling back to tool name. Approximate but cheap; identical concurrent
  name+args calls may swap durations.
- **subagents** — every dispatched subagent with its `description` (what it is
  working on), start/stop, and a *reliable-only* duration.
- **usage_snapshots** — raw cumulative usage captured by a **headless snapshot
  collector** (wired as a no-output `statusLine`), the source for phase credit
  deltas. There is **no visible status line**.

See the full schema and rationale in
`docs/superpowers/specs/2026-06-08-superpowers-usage-tracking-design.md`
(in the parent `agentharness` repo).

## Dashboard

A zero-dependency local web UI to explore the data:

    node vendor/superpowers/tools/usage-tracker/dashboard.js --open
    # --open launches the default browser; otherwise open the printed URL
    # (default http://localhost:7493/, auto-incrementing if the port is busy)

Options: `--open` (open the browser), `--port <n>`, and a positional
`path/to/usage.db` (defaults to the standard DB). It has two pages, a
**Timeline** filter, and a **Refresh** button at the top that regenerates the
report straight from `usage.db`:

- **Timeline** — restricts every chart to a time window: **Last 1 day**,
  **Last 1 week**, **Last 1 month**, **All time**, or a **Custom range** of
  dates. The window is applied server-side via `from`/`to` (millisecond)
  query params on `/api/report`.
- **Usage** — a collapsible infographic: **repo → branch → skill**, showing AI
  credit usage, duration (in seconds), and the **start time** at each level.
- **Stats** — top tools (calls + durations), superpowers **phase analysis** per
  skill (runs, total/avg time, credits, tokens), and subagent activity — each
  with **Started** / **Last active** timestamps.

When the plugin is installed, you can also just ask Copilot to "open my usage
dashboard" — the **`viewing-usage-dashboard`** skill starts the server and opens
the page for you.

## How usage is attributed

No hook carries token/credit data, so:

- **Credits / premium / cost**: the headless `snapshot.js` (wired as a no-output
  `statusLine`) records the CLI's cumulative `statusObject` figures into
  `usage_snapshots`. A phase's usage is the **delta** of snapshots across its
  time window.
- **Tokens**: summed from the session transcript (`events.jsonl`). The local
  transcript exposes **output** tokens only, so `input_tokens` is reserved
  (NULL) locally; `output_tokens`/`total_tokens` are populated.

## Install

> **What the installer does vs. the plugin.** The installer / `setup.*` scripts
> wire **usage tracking only** — the lifecycle hooks and the headless AI-credit
> snapshot collector. They do **not** register the `superpowers` plugin
> (marketplace `superpowers-dev`) in Copilot CLI, so the natural-language
> **skills** (e.g. the `viewing-usage-dashboard` skill that opens the dashboard
> by asking) are not enabled by these scripts. Tracking and the dashboard
> (`node dashboard.js --open`) work standalone. To also get the skills/agents,
> install the plugin in a Copilot CLI session:
>
>     /plugin marketplace add frags51/superpowers
>     /plugin install superpowers@superpowers-dev

Tracking **hooks** load automatically when the superpowers plugin is installed
via `/plugin`. Run the installer once to write the standalone hooks file and the
headless snapshot collector (which records AI-credit usage with no visible
status line — a plugin manifest cannot set it):

    node vendor/superpowers/tools/usage-tracker/install.js
    # hooks only, no credit snapshots:
    node vendor/superpowers/tools/usage-tracker/install.js --no-snapshot
    # revert with:
    node vendor/superpowers/tools/usage-tracker/uninstall.js

## Installing & updating the plugin (skills + agents)

The `setup.*` scripts do **not** register the plugin in Copilot CLI (there is no
non-interactive plugin-install command, and the scripts deliberately don't
hand-edit Copilot's `config.json`). Use the supported `/plugin` flow:

**Install (persistent).** In a Copilot CLI session:

    /plugin marketplace add frags51/superpowers      # or a local path to a checkout
    /plugin install superpowers@superpowers-dev

`/plugin marketplace add` accepts either a GitHub `owner/repo` or a **local
directory** that contains `.claude-plugin/marketplace.json` (e.g. the clone the
setup script makes at `$COPILOT_HOME/plugin-data/superpowers-usage/src`).

**Update an already-installed plugin.** In a Copilot CLI session:

    /plugin update superpowers

- If you added the marketplace from **GitHub**, this re-fetches the latest from
  `frags51/superpowers`.
- If you added it from a **local path**, update that checkout first (e.g. re-run
  the setup script, which does `git fetch` + checkout, or `git -C <path> pull`),
  then run `/plugin update superpowers` to re-copy it into the plugin cache.

**Load without installing (per session).** No marketplace needed:

    copilot --plugin-dir /path/to/superpowers-checkout

This loads the plugin's skills and agents for that one session only.

Restart Copilot CLI after installing so the hooks load.


### Install on another machine (no plugin required)

To set this up on a different machine — downloading the tool and wiring both the
hooks and the headless credit snapshotter without installing the full plugin —
run the remote installer. It clones the fork, self-tests, and installs into
Copilot:

    curl -fsSL https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.sh | bash

Or, from a local checkout:

    bash vendor/superpowers/tools/usage-tracker/setup.sh

#### Windows

**Recommended — PowerShell** (the equivalent of `curl | bash`; `irm` downloads
the script and `iex` runs it):

```powershell
irm https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.ps1 | iex
```

> **Do not pipe a `.cmd` into `cmd`** (e.g. `curl … | cmd`). A batch script only
> runs correctly from a **file** — piping it over stdin breaks `for /f`,
> `setlocal`, and `exit /b`, and causes `curl: (23)` write errors. Use the
> PowerShell one-liner above, or **download the `.cmd` then run it.**

Download and run the batch installer from **cmd.exe**:

```bat
curl.exe -fsSL -o "%TEMP%\sp-setup.cmd" https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.cmd && "%TEMP%\sp-setup.cmd"
```

> Note: `%TEMP%` is **cmd.exe** syntax. In PowerShell use `$env:TEMP` (and the
> call operator `&` to run the saved path), or just use the `irm | iex`
> one-liner above.

Or, from a local checkout (defaults `COPILOT_HOME` to `%USERPROFILE%\.copilot`):

    setup.cmd        # or:  powershell -File setup.ps1

The same `SUPERPOWERS_USAGE_*` / `COPILOT_HOME` environment overrides apply.

This writes a **self-contained hooks file** at
`$COPILOT_HOME/hooks/superpowers-usage.json` (absolute paths, all lifecycle
events) plus the headless credit snapshotter, then prints next steps. Restart
Copilot CLI afterward. Overrides via environment:

| Env var | Purpose | Default |
| --- | --- | --- |
| `COPILOT_HOME` | Copilot config dir | `~/.copilot` |
| `SUPERPOWERS_USAGE_REPO` | git URL to clone | `https://github.com/frags51/superpowers.git` |
| `SUPERPOWERS_USAGE_REF` | branch/tag/commit | `ghcp-native` |
| `SUPERPOWERS_USAGE_SRC` | where to clone | `$COPILOT_HOME/plugin-data/superpowers-usage/src` |
| `SUPERPOWERS_USAGE_NO_SNAPSHOT=1` | install hooks only (skip credit snapshots) | off |

Uninstall a standalone install with:

    node "$COPILOT_HOME/plugin-data/superpowers-usage/src/tools/usage-tracker/uninstall.js"

> If you later install the superpowers plugin via `/plugin` on the same machine,
> remove the standalone hooks file first (`uninstall.js`) so events aren't
> recorded twice.

For a machine that should record events but not AI-credit usage, `node
install.js --no-snapshot` writes only the hooks file (no statusLine collector).

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

# Tool-use latency by tool (avg/max ms)
sqlite3 "$DB" "SELECT name, COUNT(*) n, ROUND(AVG(duration_ms)) avg_ms, MAX(duration_ms) max_ms FROM spans WHERE kind='tool' AND duration_ms IS NOT NULL GROUP BY name ORDER BY avg_ms DESC;"

# Time spent in tools per phase/skill
sqlite3 "$DB" "SELECT p.skill, SUM(s.duration_ms) tool_ms FROM spans s JOIN phases p ON s.phase_id=p.phase_id WHERE s.duration_ms IS NOT NULL GROUP BY p.skill ORDER BY tool_ms DESC;"

# Most expensive tasks by credits
sqlite3 "$DB" "SELECT task_id, feature, ROUND(SUM(aiu_delta),3) c FROM phases GROUP BY task_id ORDER BY c DESC LIMIT 10;"
```

## Reliability (fail-open)

Copilot CLI runs `preToolUse` hooks **fail-closed**: if a hook command exits
non-zero or times out, the tool it guards is **denied**. A usage-tracking hook
must never block your work, so every tracking command is **fail-open** — it
swallows output and **always exits 0**, regardless of whether `node` is present,
the database is locked, or the tracker throws. (`tracker.js` also installs
`uncaughtException`/`unhandledRejection` guards in hook mode.) The worst case is
a missed data point, never a blocked tool. The `failopen.test.js` suite asserts
exit 0 across malformed input, unknown events, and an unwritable database.

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
- **Snapshot cadence** bounds credit/cost delta precision to how often the CLI
  re-renders the (headless) statusLine; token sums are exact.
- The built-in **`general-purpose`** subagent historically does not emit
  subagent hooks, so those background tasks are not counted; `explore`, `task`,
  `code-review`, and plugin agents are.
- Requires `node` (with `node:sqlite`, Node 22+) or a `sqlite3` CLI fallback.

## Runtime

Pure Node, no npm dependencies. Prefers built-in `node:sqlite`; falls back to
the `sqlite3` CLI when unavailable.
