import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyInstall, applyUninstall, buildHooksConfig, HOOKS_FILE_NAME } from '../install.js';

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
