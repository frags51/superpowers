// Installer: wire the statusLine setting to this plugin's statusline.js.
// Hooks ship with the plugin (auto-loaded on /plugin install); this script is
// only needed for the statusLine, which a plugin manifest cannot set.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

export function applyInstall(settings, statuslinePath) {
  settings.statusLine = { type: 'command', command: `node "${statuslinePath}"` };
  return settings;
}
export function applyUninstall(settings) {
  delete settings.statusLine;
  return settings;
}

function loadJsonc(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch { return {}; }
}

function main() {
  const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), '.copilot');
  const settingsPath = join(COPILOT_HOME, 'settings.json');
  const statuslinePath = join(HERE, 'statusline.js');
  const settings = loadJsonc(settingsPath);
  if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.usage-backup');
  applyInstall(settings, statuslinePath);
  mkdirSync(COPILOT_HOME, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log('Superpowers usage tracker installed.');
  console.log(`  statusLine -> ${settingsPath}`);
  console.log('Tracking hooks load automatically when the plugin is installed via /plugin.');
  console.log('Restart Copilot CLI so the statusLine takes effect.');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
