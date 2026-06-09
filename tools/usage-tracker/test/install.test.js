import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyInstall, applyUninstall } from '../install.js';

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
