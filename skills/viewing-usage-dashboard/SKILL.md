---
name: viewing-usage-dashboard
description: Use when the user asks to see, open, or view their Copilot usage dashboard, AI credit/token usage, time spent per repo/branch/skill, tool-usage stats, or the superpowers usage report - starts the local dashboard server and opens it in the browser
---

# Viewing the Usage Dashboard

## Overview

Opens the superpowers **usage dashboard** — a local web page showing AI credit
usage and time spent, broken down by repo → branch → skill, plus tool-usage and
phase stats. Data comes from the usage-tracker database
(`$COPILOT_HOME/plugin-data/superpowers-usage/usage.db`).

## What to do

Run the dashboard server with `--open` so it launches the page in the default
browser. The dashboard lives at `tools/usage-tracker/dashboard.js` inside this
plugin.

1. **Locate `dashboard.js`.** It is at `<plugin-root>/tools/usage-tracker/dashboard.js`.
   The plugin root is the directory two levels above this skill
   (`skills/viewing-usage-dashboard/`). If you cannot resolve the plugin root,
   find it with `glob` for `**/usage-tracker/dashboard.js`, or fall back to the
   standalone install location
   `$COPILOT_HOME/plugin-data/superpowers-usage/src/tools/usage-tracker/dashboard.js`.

2. **Start the server in the background and open the browser.** Use an async
   `bash` session (the server is long-lived):

   ```bash
   node "<path>/tools/usage-tracker/dashboard.js" --open
   ```

   It prints the URL (default `http://localhost:7493/`, auto-incrementing if the
   port is busy) and opens it. `--open` works cross-platform (macOS `open`,
   Windows `start`, Linux `xdg-open`).

3. **Tell the user the URL** in case the browser did not auto-open, and remind
   them they can use the **Refresh** button on the page to regenerate the report
   from the latest data. Leave the server running; it can be stopped with
   Ctrl+C (or by stopping the background shell).

## Notes

- The server is **read-only** and **local-only** (binds `localhost`); it
  re-queries `usage.db` on every request, so Refresh always shows current data.
- If the page shows "No usage recorded yet", the tracker hooks have not recorded
  anything for the current database yet — that is expected on a fresh install.
- To point at a specific database or port:
  `node "<path>/dashboard.js" --open --port 8080 /path/to/usage.db`.
