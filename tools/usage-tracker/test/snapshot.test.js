import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSnapshot, formatStatusLine } from '../snapshot.js';

// Mirrors the Copilot CLI v1.x statusObject: AI usage is reported as
// `ai_used.total_nano_aiu` (AIU * 1e9), with `formatted` being a lossy display
// string. premium_requests lives at `cost.total_premium_requests`.
test('extractSnapshot reads AIU from ai_used.total_nano_aiu (current CLI schema)', () => {
  const s = {
    session_id: 'abc',
    model: { display_name: 'Opus 4.8' },
    context_window: { total_tokens: 15000, current_context_used_percentage: 18 },
    ai_used: { total_nano_aiu: 420000000, formatted: '0.42' },
    cost: { total_premium_requests: 3 },
  };
  const snap = extractSnapshot(s);
  assert.equal(snap.session_id, 'abc');
  assert.equal(snap.aiu, 0.42);
  assert.equal(snap.premium_requests, 3);
  assert.equal(snap.context_tokens, 15000);
  assert.equal(snap.context_pct, 18);
  assert.equal(snap.model, 'Opus 4.8');
});

// The lossy `formatted` string must never be used as the numeric source:
// "<0.01" -> NaN, and rounded values drift. Only total_nano_aiu is exact.
test('extractSnapshot uses exact nano value, not the lossy formatted string', () => {
  const snap = extractSnapshot({
    session_id: 'x',
    ai_used: { total_nano_aiu: 5000000, formatted: '<0.01' },
  });
  assert.equal(snap.aiu, 0.005);
});

// Backward compatibility: older CLIs exposed a raw numeric `ai_used.value`.
test('extractSnapshot falls back to legacy ai_used.value', () => {
  const snap = extractSnapshot({ session_id: 'x', ai_used: { value: 1.25 } });
  assert.equal(snap.aiu, 1.25);
});

test('extractSnapshot tolerates an empty statusObject', () => {
  const snap = extractSnapshot({});
  assert.equal(snap.session_id, null);
  assert.equal(snap.aiu, null);
  assert.equal(snap.model, null);
});

test('formatStatusLine renders the AIC with a ⚡ icon', () => {
  assert.equal(formatStatusLine({ ai_used: { formatted: '0.42', value: 0.42 } }), '⚡ 0.42 AIC');
});

test('formatStatusLine falls back to the numeric value', () => {
  assert.equal(formatStatusLine({ ai_used: { value: 1234.5 } }), `⚡ ${(1234.5).toLocaleString()} AIC`);
});

test('formatStatusLine uses the exact AIU (total_nano_aiu), not lossy formatted', () => {
  // 420000000 nano = 0.42 AIU; formatted "<0.01" would be wrong/lossy.
  assert.equal(formatStatusLine({ ai_used: { total_nano_aiu: 420000000, formatted: '<0.01' } }), '⚡ 0.42 AIC');
});

test('formatStatusLine appends premium, cost, context %, and model when present', () => {
  const line = formatStatusLine({
    ai_used: { total_nano_aiu: 12340000000 },
    cost: { total_premium_requests: 3, total: 0.5 },
    context_window: { current_context_used_percentage: 18.4 },
    model: { display_name: 'Opus 4.8' },
  });
  assert.equal(line, '⚡ 12.34 AIC · 3 prem · $0.50 · 18% ctx · Opus 4.8');
});

test('formatStatusLine omits fields that are absent', () => {
  const line = formatStatusLine({ ai_used: { total_nano_aiu: 1000000000 }, model: { id: 'gpt-5' } });
  assert.equal(line, '⚡ 1 AIC · gpt-5');
});

test('formatStatusLine is blank when no AI credits are present', () => {
  assert.equal(formatStatusLine({}), '');
  assert.equal(formatStatusLine({ ai_used: {} }), '');
  assert.equal(formatStatusLine({ ai_used: { formatted: '  ' } }), '');
});
