#!/usr/bin/env bash
#
# Uninstall the Superpowers plugin + usage tracking (macOS / Linux).
#
# Reverses what setup.sh did, in safe order:
#   1. Strips the AI-credit statusLine snapshot collector (and any stale
#      standalone hooks file) by running the plugin's own uninstall.js WHILE
#      the plugin is still on disk.
#   2. Uninstalls the `superpowers` plugin via the Copilot CLI.
#   3. Removes the `frags51/superpowers` marketplace registration.
#   4. Cleans up any leftover standalone clone directory.
#
# When the plugin is not installed (standalone-only setup), it falls back to
# running `node uninstall.js` from the standalone clone.
#
# Assumes the Copilot CLI (`copilot`) and `node` are on PATH.
#
# Usage (one-liner):
#   curl -fsSL https://raw.githubusercontent.com/frags51/superpowers/main/tools/usage-tracker/uninstall.sh | bash
#
# Usage (local checkout):
#   bash tools/usage-tracker/uninstall.sh
#
# Environment overrides:
#   COPILOT_HOME  Copilot config dir  (default: ~/.copilot)
set -euo pipefail

COPILOT_HOME="${COPILOT_HOME:-$HOME/.copilot}"
MARKETPLACE_NAME="superpowers-dev"
PLUGIN_NAME="superpowers"
PLUGIN_REF="${PLUGIN_NAME}@${MARKETPLACE_NAME}"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarn:\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; }

# Find the installed plugin's tools/usage-tracker directory.
find_tool_dir() {
  local exact="$COPILOT_HOME/installed-plugins/$MARKETPLACE_NAME/$PLUGIN_NAME/tools/usage-tracker"
  if [ -f "$exact/uninstall.js" ]; then echo "$exact"; return; fi
  local root="$COPILOT_HOME/installed-plugins"
  [ -d "$root" ] || return 0
  find "$root" -name "uninstall.js" -path "*/${PLUGIN_NAME}/*/usage-tracker/uninstall.js" 2>/dev/null \
    | head -1 | xargs -I{} dirname {} 2>/dev/null || true
}

# Fallback: strip the statusLine directly from settings.json without node.
remove_status_line_direct() {
  local settings="$COPILOT_HOME/settings.json"
  [ -f "$settings" ] || return 0
  if command -v node >/dev/null 2>&1; then
    node -e "
      const fs = require('fs');
      const p = process.argv[1];
      try {
        const s = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
        delete s.statusLine;
        fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
      } catch(e) { process.stderr.write('warning: ' + e.message + '\n'); }
    " "$settings"
  fi
  local stale="$COPILOT_HOME/hooks/superpowers-usage.json"
  [ -f "$stale" ] && rm -f "$stale"
}

# 1) Strip the statusLine + standalone hooks via uninstall.js -----------------
TOOL_DIR=""
if command -v copilot >/dev/null 2>&1; then
  TOOL_DIR="$(find_tool_dir)"
fi

# Also check the standalone clone as a fallback source for uninstall.js.
STANDALONE_SRC="${SUPERPOWERS_USAGE_SRC:-$COPILOT_HOME/plugin-data/superpowers-usage/src}"
STANDALONE_TOOL="$STANDALONE_SRC/tools/usage-tracker"

if [ -n "$TOOL_DIR" ] && command -v node >/dev/null 2>&1; then
  log "Removing the AI-credit snapshot statusLine (via plugin's uninstall.js)"
  COPILOT_HOME="$COPILOT_HOME" node "$TOOL_DIR/uninstall.js"
elif [ -f "$STANDALONE_TOOL/uninstall.js" ] && command -v node >/dev/null 2>&1; then
  log "Removing the AI-credit snapshot statusLine (via standalone clone's uninstall.js)"
  COPILOT_HOME="$COPILOT_HOME" node "$STANDALONE_TOOL/uninstall.js"
else
  log "Plugin/clone not found or node missing — stripping statusLine directly"
  remove_status_line_direct
fi

# 2) Uninstall the plugin (tolerate "not installed"). -------------------------
if command -v copilot >/dev/null 2>&1; then
  log "Uninstalling plugin $PLUGIN_REF"
  uninstall_out="$(copilot plugin uninstall "$PLUGIN_REF" 2>&1 || true)"
  if echo "$uninstall_out" | grep -qi "error" && ! echo "$uninstall_out" | grep -qi "not installed\|not found"; then
    warn "plugin uninstall: $uninstall_out"
  fi

  # 3) Remove the marketplace registration (tolerate "not found"). ------------
  log "Removing marketplace $MARKETPLACE_NAME"
  mp_out="$(copilot plugin marketplace remove "$MARKETPLACE_NAME" 2>&1 || true)"
  if echo "$mp_out" | grep -qi "error" && ! echo "$mp_out" | grep -qi "not found\|not registered"; then
    warn "marketplace remove: $mp_out"
  fi
else
  warn "copilot not on PATH — skipping plugin + marketplace removal"
fi

# 4) Clean up any leftover standalone clone directory. -----------------------
old_clone="$COPILOT_HOME/plugin-data/superpowers-usage/src"
if [ -d "$old_clone" ]; then
  log "Removing old standalone clone at $old_clone"
  rm -rf "$old_clone"
fi

printf '\n\033[1;32m  Superpowers uninstalled.\033[0m Restart Copilot CLI so the changes take effect.\n'
printf '  Note: usage history in %s/plugin-data/superpowers-usage/usage.db was left in place.\n\n' "$COPILOT_HOME"
