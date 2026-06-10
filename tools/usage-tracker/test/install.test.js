import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyInstall, applyUninstall, buildHooksConfig, HOOKS_FILE_NAME, parseMode,
  reportingPluginManifests, reportingPluginDir, reportingPluginRef,
  buildReportingPlugin, registerReportingPlugin, DASHBOARD_FILES,
  REPORTING_PLUGIN_NAME, REPORTING_MARKETPLACE_NAME, REPORTING_SKILL,
} from '../install.js';

test('parseMode defaults to installing both hooks file and snapshot', () => {
  assert.deepEqual(parseMode([]), { wantHooks: true, wantSnapshot: true, wantReportingSkill: false });
});

test('parseMode --snapshot-only installs the statusLine only (no hooks file)', () => {
  assert.deepEqual(parseMode(['--snapshot-only']), { wantHooks: false, wantSnapshot: true, wantReportingSkill: false });
  assert.deepEqual(parseMode(['--statusline-only']), { wantHooks: false, wantSnapshot: true, wantReportingSkill: false });
});

test('parseMode --no-snapshot / --hooks-only installs the hooks file only', () => {
  assert.deepEqual(parseMode(['--no-snapshot']), { wantHooks: true, wantSnapshot: false, wantReportingSkill: false });
  assert.deepEqual(parseMode(['--hooks-only']), { wantHooks: true, wantSnapshot: false, wantReportingSkill: false });
});

test('parseMode --hooks is a no-op (both still install)', () => {
  assert.deepEqual(parseMode(['--hooks']), { wantHooks: true, wantSnapshot: true, wantReportingSkill: false });
});

test('parseMode --with-reporting-skill adds the skill alongside hooks + snapshot', () => {
  assert.deepEqual(parseMode(['--with-reporting-skill']), { wantHooks: true, wantSnapshot: true, wantReportingSkill: true });
});

test('parseMode --reporting-skill-only installs only the reporting skill', () => {
  assert.deepEqual(parseMode(['--reporting-skill-only']), { wantHooks: false, wantSnapshot: false, wantReportingSkill: true });
});

test('applyInstall sets statusLine; applyUninstall restores', () => {
  const before = { theme: 'dark' };
  const after = applyInstall({ ...before }, '/abs/snapshot.js');
  assert.equal(after.statusLine.type, 'command');
  assert.match(after.statusLine.command, /snapshot\.js/);
  assert.equal(after.theme, 'dark');

  const restored = applyUninstall({ ...after });
  assert.equal(restored.statusLine, undefined);
  assert.equal(restored.theme, 'dark');
});

test('buildHooksConfig wires all lifecycle events with absolute tracker path', () => {
  const cfg = buildHooksConfig('/abs/tracker.js');
  assert.equal(cfg.version, 1);
  const keys = Object.keys(cfg.hooks).sort();
  assert.deepEqual(keys, [
    'postToolUse', 'preToolUse', 'sessionEnd', 'sessionStart',
    'subagentStart', 'subagentStop', 'userPromptSubmitted',
  ]);
  const entry = cfg.hooks.sessionStart[0];
  assert.equal(entry.type, 'command');
  // fail-open: commands reference the tracker, pass the event, and force exit 0
  assert.match(entry.bash, /node "\/abs\/tracker\.js" sessionStart/);
  assert.match(entry.bash, /exit 0$/);
  assert.match(entry.powershell, /node "\/abs\/tracker\.js" sessionStart/);
  assert.match(entry.powershell, /exit 0$/);
  assert.equal(entry.timeoutSec, 5);
  assert.match(cfg.hooks.subagentStop[0].bash, /tracker\.js" subagentStop/);
});

test('HOOKS_FILE_NAME is the standalone hooks filename', () => {
  assert.equal(HOOKS_FILE_NAME, 'superpowers-usage.json');
});

test('reportingPluginManifests describes a single-skill plugin + local marketplace', () => {
  const { plugin, marketplace } = reportingPluginManifests('1.2.3');
  assert.equal(plugin.name, REPORTING_PLUGIN_NAME);
  assert.equal(plugin.version, '1.2.3');
  assert.equal(marketplace.name, REPORTING_MARKETPLACE_NAME);
  assert.deepEqual(marketplace.plugins.map((p) => p.name), [REPORTING_PLUGIN_NAME]);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.plugins[0].version, '1.2.3');
});

test('reportingPluginRef joins plugin and marketplace', () => {
  assert.equal(reportingPluginRef(), `${REPORTING_PLUGIN_NAME}@${REPORTING_MARKETPLACE_NAME}`);
});

test('buildReportingPlugin generates a self-contained skill plugin (no hooks)', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-reporting-'));
  try {
    const dir = buildReportingPlugin({ copilotHome: home });
    assert.equal(dir, reportingPluginDir(home));
    // manifests present
    assert.ok(existsSync(join(dir, '.claude-plugin', 'plugin.json')));
    assert.ok(existsSync(join(dir, '.claude-plugin', 'marketplace.json')));
    // the reporting skill is copied
    assert.ok(existsSync(join(dir, 'skills', REPORTING_SKILL, 'SKILL.md')));
    // dashboard runtime is self-contained so <plugin-root>/tools/usage-tracker/dashboard.js resolves
    for (const f of DASHBOARD_FILES) {
      assert.ok(existsSync(join(dir, 'tools', 'usage-tracker', f)), `missing ${f}`);
    }
    // it declares NO hooks (tracking comes from the standalone hooks file)
    assert.ok(!existsSync(join(dir, 'hooks')));
    const plugin = JSON.parse(readFileSync(join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, REPORTING_PLUGIN_NAME);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('buildReportingPlugin rebuilds cleanly when re-run', () => {
  const home = mkdtempSync(join(tmpdir(), 'sp-reporting-'));
  try {
    buildReportingPlugin({ copilotHome: home });
    const dir = buildReportingPlugin({ copilotHome: home });
    assert.ok(existsSync(join(dir, 'skills', REPORTING_SKILL, 'SKILL.md')));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('registerReportingPlugin adds the local marketplace then installs, tolerating "already"', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return { ok: false, out: 'marketplace already registered' };
  };
  const ref = registerReportingPlugin('/tmp/plugin-dir', run);
  assert.equal(ref, reportingPluginRef());
  assert.deepEqual(calls[0], ['plugin', 'marketplace', 'add', '/tmp/plugin-dir']);
  assert.deepEqual(calls[1], ['plugin', 'install', ref]);
});

test('registerReportingPlugin throws on a genuine marketplace failure', () => {
  const run = () => ({ ok: false, out: 'boom: permission denied' });
  assert.throws(() => registerReportingPlugin('/tmp/plugin-dir', run), /marketplace add failed/);
});
