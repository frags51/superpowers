// Installer for the superpowers usage tracker.
//
// Installs two things into the Copilot CLI:
//   * hooks file   -> $COPILOT_HOME/hooks/superpowers-usage.json
//       Records sessions/tasks/phases/spans/subagents from lifecycle events.
//   * statusLine   -> settings.json (points at snapshot.js)
//       A HEADLESS collector: it prints nothing (no visible status line) and
//       only records cumulative usage snapshots (AI credits/premium/cost), which
//       are the sole source of per-phase credit deltas. A plugin manifest cannot
//       set statusLine, so it is wired here.
//
// When the superpowers plugin is installed via /plugin, the hooks also load from
// the plugin's hooks/hooks.json; this installer is still needed for the snapshot
// statusLine (and provides a standalone hooks file for non-plugin installs).
//
// Flags:
//   --no-snapshot   install only the hooks file (skip the snapshot statusLine)
//   --hooks-only    alias for --no-snapshot
//   --hooks         accepted for backward compatibility (no-op; hooks always install)
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { isMainModule } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const HOOKS_FILE_NAME = 'superpowers-usage.json';
const HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'subagentStart',
  'subagentStop',
  'sessionEnd',
];

export function applyInstall(settings, snapshotPath) {
  settings.statusLine = { type: 'command', command: `node "${snapshotPath}"` };
  return settings;
}
export function applyUninstall(settings) {
  delete settings.statusLine;
  return settings;
}

// Self-contained Copilot CLI hooks config (camelCase event keys, absolute paths).
// Each event runs `node <trackerPath> <event>`; the hook payload arrives on stdin.
export function buildHooksConfig(trackerPath) {
  const cmd = (event) => ({
    type: 'command',
    bash: `node "${trackerPath}" ${event}`,
    powershell: `node "${trackerPath}" ${event}`,
    timeoutSec: 5,
  });
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [cmd(ev)];
  return { version: 1, hooks };
}

function loadJsonc(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch { return {}; }
}

function installSnapshot(copilotHome) {
  const settingsPath = join(copilotHome, 'settings.json');
  const snapshotPath = join(HERE, 'snapshot.js');
  const settings = loadJsonc(settingsPath);
  if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.usage-backup');
  applyInstall(settings, snapshotPath);
  mkdirSync(copilotHome, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return settingsPath;
}

function installHooksFile(copilotHome) {
  const trackerPath = join(HERE, 'tracker.js');
  const hooksDir = join(copilotHome, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hooksPath = join(hooksDir, HOOKS_FILE_NAME);
  writeFileSync(hooksPath, JSON.stringify(buildHooksConfig(trackerPath), null, 2) + '\n');
  return hooksPath;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const wantSnapshot = !args.has('--no-snapshot') && !args.has('--hooks-only');
  const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), '.copilot');

  console.log('Superpowers usage tracker installer');
  const hooksPath = installHooksFile(COPILOT_HOME);
  console.log(`  hooks            -> ${hooksPath}`);
  if (wantSnapshot) {
    const p = installSnapshot(COPILOT_HOME);
    console.log(`  snapshot (hidden)-> ${p}`);
    console.log('  (no visible status line; it only records AI-credit usage snapshots)');
  } else {
    console.log('  snapshot         -> (skipped; AI-credit usage will not be recorded)');
  }
  console.log('Restart Copilot CLI so the changes take effect.');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
