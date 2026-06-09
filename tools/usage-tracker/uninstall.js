// Uninstaller: remove the statusLine setting (restoring from backup if present)
// and the standalone hooks file.
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { applyUninstall, HOOKS_FILE_NAME } from './install.js';
import { isMainModule } from './db.js';

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
  const hooksPath = join(COPILOT_HOME, 'hooks', HOOKS_FILE_NAME);
  try { rmSync(hooksPath, { force: true }); } catch { /* not present */ }
  console.log('Superpowers usage tracker removed (statusLine + standalone hooks). Restart Copilot CLI.');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
