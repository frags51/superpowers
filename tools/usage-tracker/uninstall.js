// Uninstaller: remove the statusLine setting (restoring from backup if present),
// the standalone hooks file, and the lite reporting-skill plugin if present.
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  applyUninstall, HOOKS_FILE_NAME,
  reportingPluginDir, reportingPluginRef,
  REPORTING_MARKETPLACE_NAME, runCopilot, copilotAvailable,
} from './install.js';
import { isMainModule } from './db.js';

function loadJsonc(file) {
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
  } catch { return {}; }
}

// Remove the generated reporting-skill plugin: uninstall it from Copilot, drop
// the local marketplace, then delete the generated directory. Only acts when the
// generated directory exists, so standalone (hook-only) uninstalls stay silent.
function removeReportingPlugin(copilotHome) {
  const dir = reportingPluginDir(copilotHome);
  if (!existsSync(dir)) return;
  if (copilotAvailable()) {
    runCopilot(['plugin', 'uninstall', reportingPluginRef()]);
    runCopilot(['plugin', 'marketplace', 'remove', REPORTING_MARKETPLACE_NAME]);
  }
  rmSync(dir, { recursive: true, force: true });
  console.log('Removed the Copilot CLI usage reporting skill plugin.');
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
  removeReportingPlugin(COPILOT_HOME);
  console.log('Copilot CLI usage tracker removed (statusLine + standalone hooks). Restart Copilot CLI.');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
