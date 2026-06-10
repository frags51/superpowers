# Superpowers Usage Tracker

Hook-driven usage tracking for the **GitHub Copilot CLI**, shipped with the
superpowers plugin. It records — per **feature / task / phase** of the
development workflow — how much **AI credit** and **token** usage and
**wall-clock time** each part consumes, tagged with datetime, into a SQLite
schema built for ad-hoc analysis. It also surfaces a live list of **subagents
and what each is working on**.

## What it records

The Copilot CLI fires lifecycle hooks; `tracker.js` turns them into rows:

- **sessions** — one per CLI session (cwd, repo, branch, model). `branch` is the
  branch of the session's `cwd` at start.
- **tasks** — one per user-prompt turn. `feature` = the git branch the task works
  in. It starts as the session branch, but if the agent writes into a different
  git **worktree** during the task (detected from `edit`/`create` paths or a
  `bash` `cd`), the task and its phases are re-attributed to that worktree's
  branch. This keeps the dashboard's `repo → branch → skill` tree drillable when
  a session spawns worktrees instead of switching `cwd`. Reads never move the
  branch, and once a task is attributed to a worktree branch a later write back
  in the session branch will not flip it.
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
- **usage_snapshots** — raw cumulative usage captured by a **snapshot
  collector** (wired as the `statusLine`), the source for phase credit deltas.
  The status line shows the session's cumulative **AI credits** (e.g. `⚡ 12.34
  AIC`).

See the full schema and rationale in
`docs/superpowers/specs/2026-06-08-superpowers-usage-tracking-design.md`
(in the parent `agentharness` repo).

## Dashboard

A zero-dependency local web UI to explore the data:

    node vendor/superpowers/tools/usage-tracker/dashboard.js --open
    # --open launches the default browser; otherwise open the printed URL
    # (default http://localhost:7493/; if the port is busy it assumes a
    #  dashboard is already running there, warns, and exits)

Options: `--open` (open the browser), `--port <n>`, and a positional
`path/to/usage.db` (defaults to the standard DB). It has three pages, a
**Timeline** filter, and a **Refresh** button at the top that regenerates the
report straight from `usage.db`:

- **Timeline** — restricts every chart to a time window: **Last 1 hour**,
  **Last 1 day**, **Last 1 week**, **Last 1 month**, **All time**, or a
  **Custom range**. The custom range uses **date-and-time** pickers
  (`datetime-local`), so you can filter to a precise moment, not just a whole
  day. The window is applied server-side via `from`/`to` (millisecond) query
  params on `/api/report`.
The dashboard focuses on two metrics throughout — **AI credits (AIC**, shown
floored to a whole number) and **duration** (adaptive `12.3s` / `M:SS` /
`H:MM:SS`). The headline chips summarise **Sessions**, **Phases**, **Subagents**,
**AI credits**, and **Total time**.

- **Usage** — a collapsible infographic: **repo → branch → skill**, showing AIC
  and duration with the **start time** at each level, ordered **most-recently
  active first**. A **📦 Repos** dropdown (shown when more than one repo is
  present) lets you tick exactly which repositories to display. A **"What do
  these labels mean?"** callout explains the tree's placeholders: `(unknown
  repo)` / `(no branch)` (no git repo or branch detected), `(root)` (work
  outside any skill — the implicit root phase), and `unknown` (a skill activated
  whose name could not be resolved).
- **Sessions** — the same phase data pivoted by **session → skill**, **newest
  first**: one collapsible entry per agent run. Each session shows its
  Copilot-generated **title** as the headline (sourced at read time from
  Copilot's own session store — see *Session titles* below), with the git
  **repo / branch** and **model** alongside it, AIC + duration, and a **brief
  summary** of tool calls (count + time in tools) and subagents (count, with any
  still running), then its `skill` phases underneath with AIC + duration each.
  Sessions with no title yet fall back to showing `repo / branch`.

Both the Usage and Sessions pages **paginate at 20 entries** (controls appear
only once a page overflows), and their duration bars are scaled to the longest
entry **on the current page** — so a single long-running outlier no longer
flattens every other bar to the minimum width.
- **Stats** — three overall tables for analysing usage by dimension. **Top
  tools** focuses on tool-use latency: per-tool **count**, **P75** and **P95**
  duration (the percentiles that matter for latency, computed nearest-rank), the
  **Total (sum)** of duration, and **Last active**. **Phases (skills)** shows
  runs, total/avg duration, and **AIC** per skill. **Subagents** shows total,
  running, **total/avg/max reliable duration**, and each agent's **share** of
  subagent time. Every column is **click-to-sort** (toggle asc/desc; e.g. rank
  tools by P95 or subagents by Max duration), and a single **filter box** narrows
  all three tables by name so you can isolate one tool, skill, or agent.

When the plugin is installed, you can also just ask Copilot to "open my usage
dashboard" — the **`viewing-usage-dashboard`** skill starts the server and opens
the page for you.

## How usage is attributed

No hook carries token/credit data, so:

- **Credits / premium / cost**: the `snapshot.js` collector (wired as the
  `statusLine`) records the CLI's cumulative `statusObject` figures into
  `usage_snapshots` and renders the session's AI credits in the status line
  (`⚡ <AIC> AIC`). A phase's usage is the **delta** of snapshots across its
  time window.
- **Tokens**: summed from the session transcript (`events.jsonl`). The local
  transcript exposes **output** tokens only, so `input_tokens` is reserved
  (NULL) locally; `output_tokens`/`total_tokens` are populated.

### Session titles (read-time enrichment)

The hooks never see a session title, so the dashboard/report enriches sessions
**at read time** from Copilot CLI's own session store — a separate SQLite file
at `$COPILOT_HOME/session-store.db` (default `~/.copilot/session-store.db` on
macOS/Linux, `%USERPROFILE%\.copilot\session-store.db` on Windows; the same
relative path on every platform). Its `sessions` table carries a
Copilot-generated `summary` (e.g. *"Align Windows and Mac Setup Scripts"*) which
becomes the session's **title**, joined by `session_id`.

This read is **optional and fail-open**: it never touches the hot hook path,
opens the store **read-only**, and on any failure (missing file, locked DB,
schema drift across CLI versions, no sqlite backend) it simply yields no titles
— the Sessions page then falls back to `repo / branch`. Because the `summary` is
generated asynchronously by the CLI, very new sessions may not have a title yet.

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
snapshot collector (which records AI-credit usage and shows it in the status
line — a plugin manifest cannot set it):

    node vendor/superpowers/tools/usage-tracker/install.js
    # hooks only, no credit snapshots:
    node vendor/superpowers/tools/usage-tracker/install.js --no-snapshot
    # statusLine only (when the plugin already provides the hooks):
    node vendor/superpowers/tools/usage-tracker/install.js --snapshot-only
    # revert with:
    node vendor/superpowers/tools/usage-tracker/uninstall.js

## Installing & updating the plugin (skills + agents)

On **Windows**, the one-liner below (`setup.ps1`) does all of this for you. To do
it by hand on any platform, use either the non-interactive `copilot plugin` CLI
or the `/plugin` slash commands in a session. (The macOS/Linux `setup.sh` script
installs standalone tracking only and does not register the plugin.)

**Install (persistent).** Non-interactive, from any shell:

    copilot plugin marketplace add frags51/superpowers
    copilot plugin install superpowers@superpowers-dev

or interactively, in a Copilot CLI session:

    /plugin marketplace add frags51/superpowers      # or a local path to a checkout
    /plugin install superpowers@superpowers-dev

`/plugin marketplace add` accepts either a GitHub `owner/repo` or a **local
directory** that contains `.claude-plugin/marketplace.json` (e.g. the clone the
setup script makes at `$COPILOT_HOME/plugin-data/superpowers-usage/src`).

**Update an already-installed plugin.** Non-interactive:

    copilot plugin update superpowers@superpowers-dev

or, in a Copilot CLI session:

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

### Windows: one command to install or update (recommended)

On Windows, a single PowerShell command installs **or updates** the whole setup —
the plugin (skills, agents, tracking hooks, dashboard) via the Copilot CLI, plus
the headless AI-credit `statusLine` collector that a plugin manifest cannot
register. `irm` downloads the script text and `iex` runs it (the PowerShell
equivalent of `curl | bash`):

```powershell
irm https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/setup.ps1 | iex
```

Re-run the **same** command any time to update — it detects an existing install
and runs `copilot plugin update` instead of `install`. It assumes the Copilot
CLI (`copilot`) and `node` are on PATH. Restart Copilot CLI afterward. What it does:

1. `copilot plugin marketplace add frags51/superpowers` (idempotent).
2. `copilot plugin install superpowers@superpowers-dev` — or `update` if the
   plugin is already installed.
3. Wires the snapshot `statusLine` to the freshly installed plugin's own
   `snapshot.js`, so `copilot plugin update` keeps it current.
4. Removes leftovers from the older standalone installer (its
   `superpowers-usage.json` hooks file and clone dir) so events aren't tracked
   twice.

**Uninstall** (removes the statusLine, the plugin, and the marketplace; your
recorded `usage.db` history is left in place):

```powershell
irm https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/uninstall.ps1 | iex
```

From a local checkout you can run the scripts directly (they honor `COPILOT_HOME`,
default `%USERPROFILE%\.copilot`, and `SUPERPOWERS_USAGE_NO_SNAPSHOT=1` to install
the plugin only and skip wiring the credit `statusLine`):

    powershell -File setup.ps1
    powershell -File uninstall.ps1


### Install on another machine, tracking only (macOS / Linux)

To set this up on a different machine — downloading the tool and wiring both the
hooks and the headless credit snapshotter **without** installing the full plugin —
run the remote installer. It clones the fork, self-tests, and installs into
Copilot:

    curl -fsSL https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.sh | bash

Or, from a local checkout:

    bash vendor/superpowers/tools/usage-tracker/setup.sh

> **Windows:** there is no standalone (no-plugin) installer — use the
> `setup.ps1` one-liner in the section above, which installs the plugin via the
> Copilot CLI and wires the snapshot statusLine.

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
| `SUPERPOWERS_USAGE_WITH_SKILL=1` | also install the `viewing-usage-dashboard` reporting skill (needs `copilot` on PATH) | off |

Uninstall a standalone install with:

    node "$COPILOT_HOME/plugin-data/superpowers-usage/src/tools/usage-tracker/uninstall.js"

> If you later install the superpowers plugin via `/plugin` on the same machine,
> remove the standalone hooks file first (`uninstall.js`) so events aren't
> recorded twice.

For a machine that should record events but not AI-credit usage, `node
install.js --no-snapshot` writes only the hooks file (no statusLine collector).

### Tracking + the reporting skill, without the full plugin

The standalone install records usage but ships no skills, so you cannot ask
Copilot to "open my usage dashboard" in natural language. To get the tracking
hooks **plus only** the `viewing-usage-dashboard` skill — without the rest of
the Superpowers library — run the standalone installer with
`SUPERPOWERS_USAGE_WITH_SKILL=1`:

    SUPERPOWERS_USAGE_WITH_SKILL=1 bash vendor/superpowers/tools/usage-tracker/setup.sh
    # or, against an existing standalone install:
    node vendor/superpowers/tools/usage-tracker/install.js --with-reporting-skill
    # only the skill (skip the hooks/snapshot — e.g. they are already installed):
    node vendor/superpowers/tools/usage-tracker/install.js --reporting-skill-only

This generates a minimal, self-contained single-skill plugin under
`$COPILOT_HOME/plugin-data/superpowers-usage/reporting-plugin/` (the skill plus
just the dashboard files it needs — **no** tracking hooks, so events are never
double-counted) and installs it via a local Copilot marketplace. It requires
`copilot` on PATH; if the CLI is missing the installer still wires tracking and
prints the two commands to register the skill later. `uninstall.js` removes the
plugin, its local marketplace, and the generated directory. (On **Windows**, the
`setup.ps1` one-liner installs the full plugin, which already includes this
skill, so there is no separate lite option there.)

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

## Performance

A minimal, zero-dependency benchmark of the hot paths:

```bash
node tools/usage-tracker/bench.js          # human-readable table
node tools/usage-tracker/bench.js --json   # machine-readable
node tools/usage-tracker/bench.js --quick  # fewer iterations
```

It measures three things:

1. **In-process `handle()` per event** — the tracker logic alone.
2. **Subprocess hook latency** — `node tracker.js preToolUse` and `node
   snapshot.js` end-to-end (the real per-call cost; spawned fresh per hook).
3. **`buildReport()`** over a seeded DB (the on-demand dashboard/report cost).

Indicative results (Node 25, warm disk; absolute numbers vary by machine):

| Path | median | notes |
|------|-------:|-------|
| `handle('preToolUse')` | ~0.6 ms | includes worktree-branch resolution |
| `handle('postToolUse')` | ~0.3 ms | span close |
| `handle('userPromptSubmitted')` | ~1.4 ms | closes prior task, finalizes phases |
| `tracker.js preToolUse` (subprocess) | ~48 ms | **dominated by Node startup (~46 ms)** |
| `snapshot.js` (subprocess) | ~47 ms | same; Node startup dominates |
| `buildReport()` over 800 phases / 4800 spans | ~1.3 ms | on demand only |

**Takeaway:** the tracker's own work is sub-millisecond per hook; the
user-visible cost is the fixed Node process-startup tax (~46 ms) that any
hook-based tool pays. The DB work and the worktree-branch reattribution add
well under 1 ms, and the hooks are fail-open so they never block a tool.

## Known limitations

- **Subagent pairing:** `subagentStop` carries no agent id. When multiple
  subagents of the **same** name run concurrently, the duration cannot be
  attributed reliably; such rows get `duration_reliable=0` and a NULL
  `duration_ms`, and are **excluded from all latency/perf analysis**. Counts and
  descriptions remain correct. Always filter on `duration_reliable=1` for timing.
- **Output tokens only** locally (input tokens aren't in `events.jsonl`).
- **Snapshot cadence** bounds credit/cost delta precision to how often the CLI
  re-renders the statusLine; token sums are exact.
- The built-in **`general-purpose`** subagent historically does not emit
  subagent hooks, so those background tasks are not counted; `explore`, `task`,
  `code-review`, and plugin agents are.
- Requires `node` (with `node:sqlite`, Node 22+) or a `sqlite3` CLI fallback.

## Runtime

Pure Node, no npm dependencies. Prefers built-in `node:sqlite`; falls back to
the `sqlite3` CLI when unavailable.
