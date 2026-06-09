import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(HERE, '..', 'tracker.js');

// Runs tracker.js as a real subprocess with the given event + stdin, returns the
// exit code (0 = allowed; non-zero would DENY the tool under preToolUse).
function runHook(event, stdin, extraEnv = {}) {
  try {
    execFileSync('node', [TRACKER, event], {
      input: stdin,
      env: { ...process.env, SUPERPOWERS_USAGE_DB: join(tmpdir(), `sp-failopen-${randomUUID()}.db`), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return 0;
  } catch (e) {
    return e.status == null ? 1 : e.status;
  }
}

test('hook exits 0 on a normal payload', () => {
  assert.equal(runHook('preToolUse', JSON.stringify({ sessionId: 's', timestamp: 1, cwd: '/x', toolName: 'grep', toolArgs: { p: 1 } })), 0);
});

test('hook exits 0 on malformed JSON stdin', () => {
  assert.equal(runHook('preToolUse', 'not json at all {{{'), 0);
});

test('hook exits 0 on empty stdin', () => {
  assert.equal(runHook('preToolUse', ''), 0);
});

test('hook exits 0 on an unknown event', () => {
  assert.equal(runHook('totallyBogusEvent', JSON.stringify({ sessionId: 's', timestamp: 1 })), 0);
});

test('hook exits 0 even when the DB path is unwritable', () => {
  assert.equal(
    runHook('sessionStart', JSON.stringify({ sessionId: 's', timestamp: 1, cwd: '/x' }), { SUPERPOWERS_USAGE_DB: '/nonexistent-root-dir/cannot/usage.db' }),
    0,
  );
});

test('hook produces no stdout (empty = allow)', () => {
  const out = execFileSync('node', [TRACKER, 'preToolUse'], {
    input: JSON.stringify({ sessionId: 's', timestamp: 1, cwd: '/x', toolName: 'grep', toolArgs: {} }),
    env: { ...process.env, SUPERPOWERS_USAGE_DB: join(tmpdir(), `sp-failopen-${randomUUID()}.db`) },
    encoding: 'utf8',
  });
  assert.equal(out, '');
});
