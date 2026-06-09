#!/usr/bin/env bash
#
# Remote installer for the Superpowers usage tracker.
#
# Downloads this tool (a clone of the frags51/superpowers fork) onto the current
# machine and installs it into the GitHub Copilot CLI: writes a self-contained
# hooks file so usage/subagent tracking runs WITHOUT needing the full plugin
# installed via /plugin, plus a headless usage-snapshot collector (no visible
# status line) that records AI-credit usage.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/frags51/superpowers/ghcp-native/tools/usage-tracker/setup.sh | bash
#
# Usage (local checkout):
#   bash tools/usage-tracker/setup.sh
#
# Environment overrides:
#   COPILOT_HOME            Copilot config dir            (default: ~/.copilot)
#   SUPERPOWERS_USAGE_REPO  git URL to clone              (default: https://github.com/frags51/superpowers.git)
#   SUPERPOWERS_USAGE_REF   branch/tag/commit to install  (default: ghcp-native)
#   SUPERPOWERS_USAGE_SRC   where to clone the source     (default: $COPILOT_HOME/plugin-data/superpowers-usage/src)
#   SUPERPOWERS_USAGE_NO_SNAPSHOT=1   install hooks only (skip AI-credit snapshots)
set -euo pipefail

REPO_URL="${SUPERPOWERS_USAGE_REPO:-https://github.com/frags51/superpowers.git}"
REF="${SUPERPOWERS_USAGE_REF:-ghcp-native}"
COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
SRC="${SUPERPOWERS_USAGE_SRC:-$COPILOT_HOME/plugin-data/superpowers-usage/src}"
TOOL_SUBDIR="tools/usage-tracker"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }

# 1) Preconditions -----------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || { err "missing required command: $1"; exit 1; }; }
need git
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

# 2) Fetch the source --------------------------------------------------------
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

# 3) Verify the tool runs on this machine ------------------------------------
log "Verifying the tracker runs here"
node "$TOOL_DIR/tracker.js" --selftest

# 4) Install into Copilot ----------------------------------------------------
INSTALL_FLAGS=""
if [ "${SUPERPOWERS_USAGE_NO_SNAPSHOT:-0}" = "1" ]; then
  INSTALL_FLAGS="--no-snapshot"
fi
log "Installing into Copilot ($COPILOT_HOME)"
COPILOT_HOME="$COPILOT_HOME" node "$TOOL_DIR/install.js" $INSTALL_FLAGS

# 5) Done --------------------------------------------------------------------
cat <<EOF

$(printf '\033[1;32m✓ Superpowers usage tracker installed.\033[0m')

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

This installs usage TRACKING only (hooks + headless credit snapshots). It does
NOT install the superpowers plugin, so the natural-language skills (e.g. asking
Copilot to "open my usage dashboard") are not enabled by this script. To install
the full plugin (skills + agents), in a Copilot CLI session run:
       /plugin marketplace add frags51/superpowers
       /plugin install superpowers@superpowers-dev
   Update it later with:   /plugin update superpowers
   Or load it for one session without installing:
       copilot --plugin-dir "$TOOL_DIR/../.."

EOF
