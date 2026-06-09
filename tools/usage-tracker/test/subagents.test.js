import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtElapsed, renderRows } from '../subagents.js';

test('fmtElapsed formats mm:ss / hh:mm:ss', () => {
  assert.equal(fmtElapsed(102000), '01:42');
  assert.equal(fmtElapsed(3723000), '01:02:03');
});

test('renderRows shows running agents with descriptions', () => {
  const out = renderRows({
    sessionId: 'abc123',
    now: 200000,
    running: [
      { agent_name: 'superpowers:implementer', description: 'Implement Task 3', started_at: 100000 },
    ],
    stoppedCount: 3,
    total: 5,
    json: false,
  });
  assert.match(out, /superpowers:implementer/);
  assert.match(out, /Implement Task 3/);
  assert.match(out, /3 stopped/);
  assert.match(out, /5 total/);
});

test('renderRows json mode emits parseable JSON', () => {
  const out = renderRows({ sessionId: 'a', now: 1, running: [], stoppedCount: 0, total: 0, json: true });
  const parsed = JSON.parse(out);
  assert.equal(parsed.total, 0);
  assert.ok(Array.isArray(parsed.running));
});
