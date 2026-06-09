import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRange } from '../dashboard.js';

test('parseRange reads from/to millisecond bounds', () => {
  const r = parseRange('/api/report?from=1000&to=2000&t=5');
  assert.equal(r.from, 1000);
  assert.equal(r.to, 2000);
});

test('parseRange treats missing/invalid bounds as open', () => {
  assert.deepEqual(parseRange('/api/report'), { from: undefined, to: undefined });
  assert.deepEqual(parseRange('/api/report?from=abc'), { from: undefined, to: undefined });
  assert.equal(parseRange('/api/report?from=1500').from, 1500);
  assert.equal(parseRange('/api/report?from=1500').to, undefined);
});
