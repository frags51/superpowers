import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyInstall, applyUninstall, buildHooksConfig, HOOKS_FILE_NAME } from '../install.js';

test('applyInstall sets statusLine; applyUninstall restores', () => {
  const before = { theme: 'dark' };
  const after = applyInstall({ ...before }, '/abs/statusline.js');
  assert.equal(after.statusLine.type, 'command');
  assert.match(after.statusLine.command, /statusline\.js/);
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
  assert.equal(entry.bash, 'node "/abs/tracker.js" sessionStart');
  assert.equal(entry.powershell, 'node "/abs/tracker.js" sessionStart');
  assert.equal(entry.timeoutSec, 5);
  // each event passes its own name as the argument
  assert.equal(cfg.hooks.subagentStop[0].bash, 'node "/abs/tracker.js" subagentStop');
});

test('HOOKS_FILE_NAME is the standalone hooks filename', () => {
  assert.equal(HOOKS_FILE_NAME, 'superpowers-usage.json');
});
