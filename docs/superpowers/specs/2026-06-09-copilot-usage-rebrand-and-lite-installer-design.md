# Copilot CLI usage: visualizer rebrand + lite (tracking-only) installer

Date: 2026-06-09
Status: Approved-by-default (author unavailable; decided autonomously under
autopilot, to be reviewed later)

## Problem / motivation

The usage-tracker engine (`tools/usage-tracker/tracker.js`) records **generic
Copilot CLI activity** — sessions, every tool call (`spans`), subagents, token
counts, and AI-credit snapshots. The only Superpowers-specific coupling is that
the `skill` tool opens a named **phase** (so the dashboard can attribute time to
a skill). In other words, the tool is "Copilot CLI usage tracking" that happens
to *also* understand Superpowers skills, not a Superpowers-only tool.

Two consequences:

1. The **visualizer** is branded "Superpowers Usage", which under-sells what it
   measures (all Copilot CLI usage). Rebrand the product chrome to
   "Copilot CLI usage".
2. Today you can get the tracker two ways: the full Superpowers plugin (skills +
   agents + hooks) or the standalone `setup.sh` (hooks + credit snapshot, **no
   skills**). There is no middle option that gives you tracking **plus** the one
   natural-language reporting skill (`viewing-usage-dashboard`) without the rest
   of the skill library. Add that "lite" install option + a matching uninstall.

## Decisions

### 1. Rebrand scope (visualizer only, branding strings only)

Change the product chrome in the dashboard to "Copilot CLI usage":

- `dashboard.html`: `<title>`, the `<h1>` header.
- `dashboard.js`: the startup log line.

**Keep** the "Superpowers phases (skills)" section heading and the glossary
entries that describe "work outside any superpowers skill". Those rows are
literally Superpowers-skill phases; renaming them to a generic word would make
the dashboard *less* accurate. The rebrand is about what the product *is*
(a Copilot CLI usage view), not about hiding that it understands skills.

### 2. Lite installer: tracking hook + reporting skill, no full plugin

Add a "lite" mode that installs:

- the **tracking hook** (+ headless credit snapshot) — the existing standalone
  `install.js` path, unchanged; and
- **only** the `viewing-usage-dashboard` skill, so a user can say "open my usage
  dashboard" without pulling in the ~30 other skills/agents.

**Mechanism (no repo duplication).** Copilot CLI loads skills only from plugins,
but it can register a **local directory as a marketplace** and install a plugin
from it. The standalone installer already clones the whole fork to
`$COPILOT_HOME/plugin-data/superpowers-usage/src`. The lite installer therefore
*generates* a minimal plugin at install time from that clone:

```
$COPILOT_HOME/plugin-data/superpowers-usage/reporting-plugin/
  .claude-plugin/plugin.json        # name: copilot-usage-reporting
  .claude-plugin/marketplace.json   # local marketplace wrapping the plugin
  skills/viewing-usage-dashboard/   # copied from src/skills/...
```

Then: `copilot plugin marketplace add <dir>` + `copilot plugin install
copilot-usage-reporting@copilot-usage-local`. The skill's existing fallback
("…/plugin-data/superpowers-usage/src/tools/usage-tracker/dashboard.js") locates
`dashboard.js` in the clone, so the minimal plugin carries **no** tracker code —
the skill is the only thing it ships. The canonical skill stays in
`skills/viewing-usage-dashboard/`; the install copies it, so there is no second
source of truth committed to the repo.

**Requirements.** The lite "+skill" step needs `copilot` on PATH (to register
the local marketplace and install). The plain hook install does not. If
`copilot` is missing, the installer still does the hook install and warns that
the reporting skill was skipped.

**Surfaces.**
- `install.js` gains a `--with-reporting-skill` flag (and a
  `--reporting-skill-only` for re-running just that step). It builds the minimal
  plugin and registers it.
- `uninstall.js` reverses it: `copilot plugin uninstall` + `marketplace remove`
  + delete the generated `reporting-plugin/` dir.
- `setup.sh` gains `SUPERPOWERS_USAGE_WITH_SKILL=1` (and/or a `--with-skill`
  arg) that passes `--with-reporting-skill` through to `install.js`.

### Out of scope
- No change to the full-plugin install path (`setup.ps1`, marketplace).
- No renaming of DB columns, env vars (`SUPERPOWERS_USAGE_*`), or the on-disk
  `plugin-data/superpowers-usage/` paths — those are stable identifiers and
  renaming them would break existing installs for no user-visible benefit.

## Testing / e2e

- `node tracker.js --selftest` and the existing `test/` suite still pass.
- Dashboard renders with the new title (HTTP GET the served page, assert
  "Copilot CLI usage").
- e2e with the real `copilot` CLI: run a short non-interactive session with the
  standalone hooks wired, confirm rows land in `usage.db`, start `dashboard.js`,
  and GET the page. For the lite skill: generate the minimal plugin, load it via
  `copilot --plugin-dir`, and confirm `copilot plugin list` / the installed
  skill file is present.
