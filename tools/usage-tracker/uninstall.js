// Uninstaller: remove the statusLine setting (restores from backup if present).
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { applyUninstall } from './install.js';

function loadJsonc(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch { return {}; }
}

function main() {
  const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), '.copilot');
  const settingsPath = join(COPILOT_HOME, 'settings.json');
  const backup = settingsPath + '.usage-backup';
  if (existsSync(backup)) {
    copyFileSync(backup, settingsPath);
  } else if (existsSync(settingsPath)) {
    const settings = loadJsonc(settingsPath);
    applyUninstall(settings);
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }
  console.log('Superpowers usage tracker statusLine removed. Restart Copilot CLI.');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main();
