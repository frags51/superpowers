import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtNum, extractSnapshot, composeLine } from '../statusline.js';

test('fmtNum abbreviates', () => {
  assert.equal(fmtNum(950), '950');
  assert.equal(fmtNum(15000), '15k');
  assert.equal(fmtNum(2_000_000), '2M');
});

test('extractSnapshot pulls cumulative fields from statusObject', () => {
  const s = {
    session_id: 'abc',
    model: { display_name: 'Opus 4.8' },
    context_window: { total_tokens: 15000, current_context_used_percentage: 18 },
    ai_used: { formatted: '0.42' },
    cost: { total_premium_requests: 3 },
  };
  const snap = extractSnapshot(s);
  assert.equal(snap.session_id, 'abc');
  assert.equal(snap.premium_requests, 3);
  assert.equal(snap.context_tokens, 15000);
  assert.equal(snap.context_pct, 18);
  assert.equal(snap.model, 'Opus 4.8');
});

test('composeLine includes running subagent names when present', () => {
  const line = composeLine({
    model: 'Opus 4.8', aiu: '0.42', tokens: 15000, ctxPct: 18, premium: 3,
    running: [{ agent_name: 'superpowers:implementer' }, { agent_name: 'explore' }],
    totalAgents: 3,
    td: { total: 5, done: 2, in_progress: 1, blocked: 1 },
  });
  assert.match(line, /implementer/);
  assert.match(line, /0\.42 AIU/);
  assert.match(line, /2\/5/);
});
