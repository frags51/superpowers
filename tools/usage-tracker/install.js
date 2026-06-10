// Installer for the superpowers usage tracker.
//
// Installs two things into the Copilot CLI:
//   * hooks file   -> $COPILOT_HOME/hooks/superpowers-usage.json
//       Records sessions/tasks/phases/spans/subagents from lifecycle events.
//   * statusLine   -> settings.json (points at snapshot.js)
//       A HEADLESS collector: by default it prints nothing (no visible status
//       line) and only records cumulative usage snapshots (AI credits/premium/
//       cost), which are the sole source of per-phase credit deltas. With the
//       `--debug` flag it is wired with `--debug` so the snapshot ALSO renders a
//       brief `⚡ <AIC> AIC` status line. A plugin manifest cannot set
//       statusLine, so it is wired here.
//
// When the superpowers plugin is installed via /plugin, the hooks also load from
// the plugin's hooks/hooks.json; this installer is still needed for the snapshot
// statusLine (and provides a standalone hooks file for non-plugin installs).
//
// Flags:
//   --snapshot-only install only the statusLine snapshot collector (skip the
//                   standalone hooks file — used when the plugin is installed
//                   via `copilot plugin`, since the plugin already provides hooks)
//   --statusline-only  alias for --snapshot-only
//   --no-snapshot   install only the hooks file (skip the snapshot statusLine)
//   --hooks-only    alias for --no-snapshot
//   --hooks         accepted for backward compatibility (no-op; hooks always install)
//   --debug         wire the snapshot to also show a live `⚡ <AIC> AIC` status
//                   line (default: the status line stays empty)
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { isMainModule } from './db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const HOOKS_FILE_NAME = 'superpowers-usage.json';

// The "lite" reporting install: a minimal, self-contained plugin that ships ONLY
// the viewing-usage-dashboard skill (plus the dashboard files it needs to run),
// so a user can open the usage dashboard by natural language without installing
// the whole Superpowers skill library. It declares no hooks — tracking is
// provided by the standalone hooks file — so installing it never double-counts.
export const REPORTING_PLUGIN_NAME = 'copilot-usage-reporting';
export const REPORTING_MARKETPLACE_NAME = 'copilot-usage-local';
export const REPORTING_SKILL = 'viewing-usage-dashboard';
// Minimal set of files dashboard.js needs at runtime (it + its local imports and
// the static assets they read). Copied next to the skill so the skill's primary
// "<plugin-root>/tools/usage-tracker/dashboard.js" path resolves on any machine.
export const DASHBOARD_FILES = ['dashboard.js', 'report.js', 'db.js', 'dashboard.html', 'schema.sql'];
const HOOK_EVENTS = [
  'sessionStart',
  'userPromptSubmitted',
  'preToolUse',
  'postToolUse',
  'subagentStart',
  'subagentStop',
  'sessionEnd',
];

export function applyInstall(settings, snapshotPath, { debug = false } = {}) {
  const command = `node "${snapshotPath}"${debug ? ' --debug' : ''}`;
  settings.statusLine = { type: 'command', command };
  return settings;
}
export function applyUninstall(settings) {
  delete settings.statusLine;
  return settings;
}

// Self-contained Copilot CLI hooks config (camelCase event keys, absolute paths).
// Each event runs the tracker with the event name; the hook payload arrives on
// stdin. These commands are FAIL-OPEN: preToolUse hooks are fail-closed in
// Copilot CLI (a non-zero exit / timeout DENIES the tool), so every command
// swallows output and always exits 0 — a usage-tracking hook must never block.
export function buildHooksConfig(trackerPath) {
  const cmd = (event) => ({
    type: 'command',
    bash: `node "${trackerPath}" ${event} >/dev/null 2>&1; exit 0`,
    powershell: `try { node "${trackerPath}" ${event} *> $null } catch { }; exit 0`,
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

function installSnapshot(copilotHome, { debug = false } = {}) {
  const settingsPath = join(copilotHome, 'settings.json');
  const snapshotPath = join(HERE, 'snapshot.js');
  const settings = loadJsonc(settingsPath);
  if (existsSync(settingsPath)) copyFileSync(settingsPath, settingsPath + '.usage-backup');
  applyInstall(settings, snapshotPath, { debug });
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

// --- Lite reporting-skill plugin ------------------------------------------

// Where the generated minimal reporting plugin lives (under plugin-data, never
// committed to the repo — it is rebuilt from source on every install).
export function reportingPluginDir(copilotHome) {
  return join(copilotHome, 'plugin-data', 'superpowers-usage', 'reporting-plugin');
}

function readSourceVersion(srcRoot) {
  try {
    const j = JSON.parse(readFileSync(join(srcRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    return j.version || '0.0.0';
  } catch { return '0.0.0'; }
}

// The plugin.json + marketplace.json for the generated reporting plugin. Pure so
// it can be unit-tested without touching the filesystem.
export function reportingPluginManifests(version = '0.0.0') {
  const description =
    'Copilot CLI usage reporting — the viewing-usage-dashboard skill that opens the local usage dashboard. Companion to the standalone usage tracker.';
  const plugin = { name: REPORTING_PLUGIN_NAME, description, version, license: 'MIT' };
  const marketplace = {
    name: REPORTING_MARKETPLACE_NAME,
    description: 'Local marketplace for the Copilot CLI usage reporting skill.',
    owner: { name: 'Copilot CLI usage tracker' },
    plugins: [{ name: REPORTING_PLUGIN_NAME, description, version, source: './' }],
  };
  return { plugin, marketplace };
}

// Generate the self-contained reporting plugin on disk. Copies the canonical
// viewing-usage-dashboard skill and the minimal dashboard runtime so the plugin
// works whether installed from a local checkout or the standalone clone. Returns
// the plugin directory.
export function buildReportingPlugin({ copilotHome, srcRoot = join(HERE, '..', '..'), toolDir = HERE } = {}) {
  const dir = reportingPluginDir(copilotHome);
  rmSync(dir, { recursive: true, force: true });

  const skillDst = join(dir, 'skills', REPORTING_SKILL);
  mkdirSync(skillDst, { recursive: true });
  cpSync(join(srcRoot, 'skills', REPORTING_SKILL), skillDst, { recursive: true });

  const toolDst = join(dir, 'tools', 'usage-tracker');
  mkdirSync(toolDst, { recursive: true });
  for (const f of DASHBOARD_FILES) copyFileSync(join(toolDir, f), join(toolDst, f));

  const { plugin, marketplace } = reportingPluginManifests(readSourceVersion(srcRoot));
  mkdirSync(join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify(plugin, null, 2) + '\n');
  writeFileSync(join(dir, '.claude-plugin', 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
  return dir;
}

// Run a `copilot` subcommand, capturing output. Returns {ok, out} instead of
// throwing so callers can tolerate idempotent "already registered" errors and a
// missing CLI. Exported so the uninstaller reuses the exact same invocation.
export function runCopilot(args, exec = execFileSync) {
  try {
    const out = exec('copilot', args, { stdio: 'pipe', encoding: 'utf8' });
    return { ok: true, out: out || '' };
  } catch (e) {
    const out = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`;
    return { ok: false, out, code: e && e.code };
  }
}

export function copilotAvailable(run = runCopilot) {
  return run(['--version']).ok;
}

export function reportingPluginRef() {
  return `${REPORTING_PLUGIN_NAME}@${REPORTING_MARKETPLACE_NAME}`;
}

// Register the generated plugin as a local marketplace and install it. Tolerant
// of being re-run (idempotent "already" messages). Returns the plugin ref.
export function registerReportingPlugin(dir, run = runCopilot) {
  const ref = reportingPluginRef();
  const mp = run(['plugin', 'marketplace', 'add', dir]);
  if (!mp.ok && !/already/i.test(mp.out)) throw new Error(`marketplace add failed: ${mp.out}`);
  const inst = run(['plugin', 'install', ref]);
  if (!inst.ok && !/already/i.test(inst.out)) throw new Error(`plugin install failed: ${inst.out}`);
  return ref;
}

// Resolve install mode from CLI args. Returns which artifacts to write:
//   wantHooks          -> the standalone $COPILOT_HOME/hooks/superpowers-usage.json
//   wantSnapshot       -> the statusLine snapshot collector in settings.json
//   wantReportingSkill -> the lite viewing-usage-dashboard plugin
//   debug              -> wire the snapshot to show a live `⚡ <AIC> AIC` line
export function parseMode(argv) {
  const args = new Set(argv);
  const snapshotOnly = args.has('--snapshot-only') || args.has('--statusline-only');
  const hooksOnly = args.has('--no-snapshot') || args.has('--hooks-only');
  const reportingOnly = args.has('--reporting-skill-only');
  const wantReportingSkill = reportingOnly || args.has('--with-reporting-skill');
  return {
    wantHooks: !snapshotOnly && !reportingOnly,
    wantSnapshot: !hooksOnly && !reportingOnly,
    wantReportingSkill,
    debug: args.has('--debug'),
  };
}

function main() {
  const { wantHooks, wantSnapshot, wantReportingSkill, debug } = parseMode(process.argv.slice(2));
  const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), '.copilot');

  console.log('Copilot CLI usage tracker installer');
  if (wantHooks) {
    const hooksPath = installHooksFile(COPILOT_HOME);
    console.log(`  hooks            -> ${hooksPath}`);
  } else {
    console.log('  hooks            -> (skipped; the installed plugin provides tracking hooks)');
  }
  if (wantSnapshot) {
    const p = installSnapshot(COPILOT_HOME, { debug });
    if (debug) {
      console.log(`  snapshot (debug) -> ${p}`);
      console.log('  (status line shows live AI-credit usage: ⚡ <AIC> AIC)');
    } else {
      console.log(`  snapshot (hidden)-> ${p}`);
      console.log('  (no visible status line; it only records AI-credit usage snapshots)');
    }
  } else {
    console.log('  snapshot         -> (skipped; AI-credit usage will not be recorded)');
  }
  if (wantReportingSkill) {
    const dir = buildReportingPlugin({ copilotHome: COPILOT_HOME });
    console.log(`  reporting plugin -> ${dir}`);
    if (copilotAvailable()) {
      const ref = registerReportingPlugin(dir);
      console.log(`  reporting skill  -> installed ${ref}`);
    } else {
      console.log('  reporting skill  -> built, but `copilot` is not on PATH; register it with:');
      console.log(`       copilot plugin marketplace add "${dir}"`);
      console.log(`       copilot plugin install ${REPORTING_PLUGIN_NAME}@${REPORTING_MARKETPLACE_NAME}`);
    }
  }
  console.log('Restart Copilot CLI so the changes take effect.');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
