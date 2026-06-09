import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { snapshotDelta, sumOutputTokens } from '../usage.js';

test('snapshotDelta computes deltas across a window', () => {
  const rows = [
    { captured_at: 100, aiu: 1.0, premium_requests: 2, cost_total: 0.5 },
    { captured_at: 200, aiu: 1.5, premium_requests: 3, cost_total: 0.7 },
    { captured_at: 300, aiu: 2.0, premium_requests: 5, cost_total: 1.0 },
  ];
  const d = snapshotDelta(rows, 150, 300);
  assert.equal(d.aiu_delta, 1.0);
  assert.equal(d.premium_delta, 3);
  assert.equal(Math.round(d.cost_delta * 100), 50);
});

test('snapshotDelta returns nulls when no snapshots in range', () => {
  const d = snapshotDelta([], 0, 10);
  assert.equal(d.aiu_delta, null);
  assert.equal(d.premium_delta, null);
  assert.equal(d.cost_delta, null);
});

test('sumOutputTokens sums assistant.message outputTokens in window', () => {
  const path = join(tmpdir(), `sp-tx-${randomUUID()}.jsonl`);
  const lines = [
    { type: 'assistant.message', timestamp: '2026-06-09T00:00:01.000Z', data: { outputTokens: 10 } },
    { type: 'assistant.message', timestamp: '2026-06-09T00:00:02.000Z', data: { outputTokens: 5 } },
    { type: 'assistant.message', timestamp: '2026-06-09T00:00:09.000Z', data: { outputTokens: 100 } },
    { type: 'user.message',      timestamp: '2026-06-09T00:00:02.500Z', data: {} },
  ].map((o) => JSON.stringify(o)).join('\n');
  writeFileSync(path, lines);
  try {
    const start = Date.parse('2026-06-09T00:00:00.000Z');
    const end = Date.parse('2026-06-09T00:00:03.000Z');
    const t = sumOutputTokens(path, start, end);
    assert.equal(t.output_tokens, 15);
    assert.equal(t.input_tokens, null);
    assert.equal(t.total_tokens, 15);
  } finally {
    rmSync(path, { force: true });
  }
});

test('sumOutputTokens tolerates a missing transcript', () => {
  const t = sumOutputTokens('/no/such/file.jsonl', 0, 10);
  assert.equal(t.output_tokens, null);
  assert.equal(t.total_tokens, null);
});
