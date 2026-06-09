// Installer for the superpowers usage tracker.
//
// Two install surfaces:
//   * statusLine  -> settings.json (a plugin manifest cannot set this)
//   * hooks file  -> $COPILOT_HOME/hooks/superpowers-usage.json
//
// When the superpowers plugin is installed via /plugin, the tracking hooks load
// automatically from the plugin's hooks/hooks.json and you only need the
// statusLine (`node install.js`). On a machine WITHOUT the plugin (e.g. a remote
// install of just this tool), pass `--hooks` to also write a self-contained
// hooks file with absolute paths so tracking works standalone.
//
// Flags:
//   --hooks         also write the standalone hooks file (statusLine + hooks)
//   --hooks-only    write only the hooks file (skip statusLine)
//   --no-statusline skip the statusLine (hooks only)
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

export function applyInstall(settings, statuslinePath) {
  settings.statusLine = { type: 'command', command: `node "${statuslinePath}"` };
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

function installStatusline(copilotHome) {
  const settingsPath = join(copilotHome, 'settings.json');
  const statuslinePath = join(HERE, 'statusline.js');
  const settings = loadJsonc(settingsPath);
  if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.usage-backup');
  applyInstall(settings, statuslinePath);
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
  const wantHooks = args.has('--hooks') || args.has('--hooks-only');
  const wantStatusline = !args.has('--hooks-only') && !args.has('--no-statusline');
  const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), '.copilot');

  console.log('Superpowers usage tracker installer');
  if (wantStatusline) {
    const p = installStatusline(COPILOT_HOME);
    console.log(`  statusLine -> ${p}`);
  }
  if (wantHooks) {
    const p = installHooksFile(COPILOT_HOME);
    console.log(`  hooks      -> ${p}`);
  } else {
    console.log('  hooks      -> (skipped; loaded from the plugin when installed via /plugin)');
    console.log('               re-run with --hooks for a standalone install.');
  }
  console.log('Restart Copilot CLI so the changes take effect.');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
