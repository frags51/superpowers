import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSnapshot } from '../snapshot.js';

test('extractSnapshot pulls cumulative fields from statusObject', () => {
  const s = {
    session_id: 'abc',
    model: { display_name: 'Opus 4.8' },
    context_window: { total_tokens: 15000, current_context_used_percentage: 18 },
    ai_used: { formatted: '0.42', value: 0.42 },
    cost: { total_premium_requests: 3, total: 0.5 },
  };
  const snap = extractSnapshot(s);
  assert.equal(snap.session_id, 'abc');
  assert.equal(snap.aiu, 0.42);
  assert.equal(snap.premium_requests, 3);
  assert.equal(snap.cost_total, 0.5);
  assert.equal(snap.context_tokens, 15000);
  assert.equal(snap.context_pct, 18);
  assert.equal(snap.model, 'Opus 4.8');
});

test('extractSnapshot tolerates an empty statusObject', () => {
  const snap = extractSnapshot({});
  assert.equal(snap.session_id, null);
  assert.equal(snap.aiu, null);
  assert.equal(snap.model, null);
});
