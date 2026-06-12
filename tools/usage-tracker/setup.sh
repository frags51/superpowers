#!/usr/bin/env bash
#
# Install / update the Superpowers plugin + usage tracking (macOS / Linux).
#
# When the Copilot CLI (`copilot`) is on PATH this script mirrors setup.ps1:
#   1. Registers the `frags51/superpowers` marketplace (idempotent).
#   2. Installs or updates the `superpowers@superpowers-dev` plugin (skills,
#      agents, tracking hooks, and dashboard).
#   3. Wires the AI-credit statusLine snapshot collector — the one thing a
#      plugin manifest cannot set — pointing at the installed plugin's own
#      snapshot.js, so `copilot plugin update` keeps it current.
#   4. Cleans up any artifacts from the older standalone installer so events
#      are not tracked twice.
#
# When `copilot` is not on PATH (or SUPERPOWERS_USAGE_STANDALONE=1) it falls
# back to standalone mode: clones the repo, wires a self-contained hooks file
# + headless snapshot collector (tracking only, no plugin/skills).
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/setup.sh | bash
#
# Usage (local checkout):
#   bash tools/usage-tracker/setup.sh
#
# Environment overrides:
#   COPILOT_HOME                     Copilot config dir            (default: ~/.copilot)
#   SUPERPOWERS_USAGE_STANDALONE=1   force standalone mode even if copilot is on PATH
#   SUPERPOWERS_USAGE_NO_SNAPSHOT=1  install plugin/hooks only; skip the AI-credit statusLine
#   SUPERPOWERS_USAGE_DEBUG=1        show a live ⚡ <AIC> AIC status line (default: hidden)
#   --- standalone-mode only (ignored when copilot is available) ---
#   SUPERPOWERS_USAGE_REPO  git URL to clone   (default: https://github.com/frags51/superpowers.git)
#   SUPERPOWERS_USAGE_REF   branch/tag/commit  (default: main)
#   SUPERPOWERS_USAGE_SRC   where to clone     (default: $COPILOT_HOME/plugin-data/superpowers-usage/src)
#   SUPERPOWERS_USAGE_WITH_SKILL=1  also install the viewing-usage-dashboard skill
set -euo pipefail

COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
MARKETPLACE_SOURCE="frags51/superpowers"
MARKETPLACE_NAME="superpowers-dev"
PLUGIN_NAME="superpowers"
PLUGIN_REF="${PLUGIN_NAME}@${MARKETPLACE_NAME}"

# Standalone-mode vars (only used when copilot is absent or SUPERPOWERS_USAGE_STANDALONE=1)
REPO_URL="${SUPERPOWERS_USAGE_REPO:-https://github.com/frags51/superpowers.git}"
REF="${SUPERPOWERS_USAGE_REF:-main}"
SRC="${SUPERPOWERS_USAGE_SRC:-$COPILOT_HOME/plugin-data/superpowers-usage/src}"
TOOL_SUBDIR="tools/usage-tracker"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }

# 1) Preconditions -----------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || { err "missing required command: $1"; exit 1; }; }
need node

NODE_MAJOR="$(node -p 'parseInt(process.versions.node,10)' 2>/dev/null || echo 0)"
case "$NODE_MAJOR" in (*[!0-9]*|'') NODE_MAJOR=0 ;; esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  if ! command -v sqlite3 >/dev/null 2>&1; then
    err "Node ${NODE_MAJOR} lacks node:sqlite and no sqlite3 CLI fallback was found."
    err "Install Node 22+ or the sqlite3 CLI, then re-run."
    exit 1
  fi
  log "Node ${NODE_MAJOR}: will use the sqlite3 CLI fallback."
fi

# 2) Choose install mode -----------------------------------------------------
USE_PLUGIN=0
if [ "${SUPERPOWERS_USAGE_STANDALONE:-0}" != "1" ] && command -v copilot >/dev/null 2>&1; then
  USE_PLUGIN=1
fi

# Helper: find the installed plugin's tools/usage-tracker directory.
find_tool_dir() {
  local exact="$COPILOT_HOME/installed-plugins/$MARKETPLACE_NAME/$PLUGIN_NAME/tools/usage-tracker"
  if [ -f "$exact/install.js" ]; then echo "$exact"; return; fi
  local root="$COPILOT_HOME/installed-plugins"
  [ -d "$root" ] || return 0
  find "$root" -name "install.js" -path "*/${PLUGIN_NAME}/*/usage-tracker/install.js" 2>/dev/null \
    | head -1 | xargs -I{} dirname {} 2>/dev/null || true
}

# 3a) Plugin-based install (mirrors setup.ps1) --------------------------------
if [ "$USE_PLUGIN" -eq 1 ]; then
  log "Copilot CLI found — installing via plugin"

  # Register marketplace (idempotent — tolerate "already registered").
  log "Registering marketplace $MARKETPLACE_SOURCE"
  mp_out="$(copilot plugin marketplace add "$MARKETPLACE_SOURCE" 2>&1 || true)"
  if echo "$mp_out" | grep -qi "error" && ! echo "$mp_out" | grep -qi "already"; then
    err "Failed to register marketplace: $mp_out"; exit 1
  fi

  # Install or update the plugin.
  installed="$(copilot plugin list 2>/dev/null || true)"
  if echo "$installed" | grep -qF "$PLUGIN_REF"; then
    log "Updating plugin $PLUGIN_REF"
    copilot plugin update "$PLUGIN_REF"
  else
    log "Installing plugin $PLUGIN_REF"
    copilot plugin install "$PLUGIN_REF"
  fi

  # Locate the freshly installed plugin's usage-tracker directory.
  TOOL_DIR="$(find_tool_dir)"
  if [ -z "$TOOL_DIR" ]; then
    err "Could not find the installed plugin's usage-tracker under $COPILOT_HOME/installed-plugins"
    exit 1
  fi

  # Wire the statusLine snapshot collector (the part a plugin manifest cannot do).
  if [ "${SUPERPOWERS_USAGE_NO_SNAPSHOT:-0}" = "1" ]; then
    log "Skipping the AI-credit snapshot statusLine (SUPERPOWERS_USAGE_NO_SNAPSHOT=1)"
    STATUS_LINE_SUMMARY="(skipped; AI-credit usage will not be recorded)"
  else
    log "Wiring the AI-credit snapshot statusLine"
    SNAPSHOT_FLAGS="--snapshot-only"
    [ "${SUPERPOWERS_USAGE_DEBUG:-0}" = "1" ] && SNAPSHOT_FLAGS="$SNAPSHOT_FLAGS --debug"
    COPILOT_HOME="$COPILOT_HOME" node "$TOOL_DIR/install.js" $SNAPSHOT_FLAGS
    STATUS_LINE_SUMMARY="$TOOL_DIR/snapshot.js"
  fi

  # Remove legacy standalone artifacts to avoid double-tracking.
  stale_hooks="$COPILOT_HOME/hooks/superpowers-usage.json"
  old_clone="$COPILOT_HOME/plugin-data/superpowers-usage/src"
  if [ -f "$stale_hooks" ]; then
    log "Removing stale standalone hooks file (the plugin now provides hooks)"
    rm -f "$stale_hooks"
  fi
  if [ -d "$old_clone" ]; then
    log "Removing old standalone clone at $old_clone"
    rm -rf "$old_clone"
  fi

  cat <<EOF

$(printf '\033[1;32m✓ Superpowers installed/updated.\033[0m')

  plugin     : $PLUGIN_REF
  copilot    : $COPILOT_HOME
  statusLine : $STATUS_LINE_SUMMARY

Next steps:
  1. Restart Copilot CLI so the plugin + statusLine load.
  2. Ask Copilot to "open my usage dashboard", or run it directly:
       node "$TOOL_DIR/dashboard.js" --open
  3. List active subagents any time with:
       node "$TOOL_DIR/subagents.js" --all
  4. Uninstall with:
       curl -fsSL https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/uninstall.sh | bash

EOF
  exit 0
fi

# 3b) Standalone fallback (copilot not on PATH) --------------------------------
log "copilot not found on PATH — falling back to standalone tracking install"
need git

# Fetch the source.
if [ -d "$SRC/.git" ]; then
  log "Updating existing checkout at $SRC"
  git -C "$SRC" fetch --depth 1 origin "$REF"
  git -C "$SRC" checkout -q FETCH_HEAD
else
  log "Cloning $REPO_URL ($REF) -> $SRC"
  mkdir -p "$(dirname "$SRC")"
  rm -rf "$SRC"
  git clone --depth 1 --branch "$REF" "$REPO_URL" "$SRC" 2>/dev/null \
    || { # REF may be a commit sha (can't --branch a sha): clone then checkout
         git clone "$REPO_URL" "$SRC"
         git -C "$SRC" checkout -q "$REF"; }
fi

TOOL_DIR="$SRC/$TOOL_SUBDIR"
[ -f "$TOOL_DIR/install.js" ] || { err "install.js not found at $TOOL_DIR — wrong ref or repo?"; exit 1; }

# Verify the tool runs on this machine.
log "Verifying the tracker runs here"
node "$TOOL_DIR/tracker.js" --selftest

# Install into Copilot.
INSTALL_FLAGS=""
[ "${SUPERPOWERS_USAGE_NO_SNAPSHOT:-0}" = "1" ] && INSTALL_FLAGS="--no-snapshot"
[ "${SUPERPOWERS_USAGE_WITH_SKILL:-0}" = "1" ] && INSTALL_FLAGS="$INSTALL_FLAGS --with-reporting-skill"
[ "${SUPERPOWERS_USAGE_DEBUG:-0}" = "1" ]       && INSTALL_FLAGS="$INSTALL_FLAGS --debug"
log "Installing into Copilot ($COPILOT_HOME)"
COPILOT_HOME="$COPILOT_HOME" node "$TOOL_DIR/install.js" $INSTALL_FLAGS

if [ "${SUPERPOWERS_USAGE_WITH_SKILL:-0}" = "1" ]; then
  SKILL_NOTE='This also installed the viewing-usage-dashboard reporting skill (a
minimal single-skill plugin), so you can ask Copilot to "open my usage
dashboard" without the rest of the Superpowers library. For the FULL plugin
(all skills + agents), install the Copilot CLI then re-run this script, or
in a Copilot CLI session run:'
else
  SKILL_NOTE='This installs usage TRACKING only (hooks + headless credit snapshots). It does
NOT install any skills. Install the Copilot CLI and re-run this script to get
the full plugin (all skills + agents), or in a Copilot CLI session run:'
fi
cat <<EOF

$(printf '\033[1;32m✓ Copilot CLI usage tracker installed (standalone mode).\033[0m')

  source     : $TOOL_DIR
  copilot    : $COPILOT_HOME
  hooks file : $COPILOT_HOME/hooks/superpowers-usage.json
  database   : ${SUPERPOWERS_USAGE_DB:-$COPILOT_HOME/plugin-data/superpowers-usage/usage.db}

Next steps:
  1. Restart Copilot CLI so the hooks load (tracking is headless — no status line).
  2. Open the dashboard (credit/time infographic + stats):
       node "$TOOL_DIR/dashboard.js" --open    # or visit the printed URL
  3. List active subagents any time with:
       node "$TOOL_DIR/subagents.js" --all
  4. Uninstall with:
       COPILOT_HOME="$COPILOT_HOME" node "$TOOL_DIR/uninstall.js"

$SKILL_NOTE
       /plugin marketplace add frags51/superpowers
       /plugin install superpowers@superpowers-dev
   Update it later with:   /plugin update superpowers
   Or load it for one session without installing:
       copilot --plugin-dir "$TOOL_DIR/../.."

EOF
