// Headless usage-snapshot collector.
//
// Wired as the Copilot CLI `statusLine` command — the ONLY way to receive the
// cumulative usage `statusObject` (AI credits, premium requests, cost, model).
// It records a `usage_snapshots` row and prints NOTHING, so there is no visible
// status line; phase credit/cost deltas are derived from these snapshots.
import { readFileSync } from 'node:fs';
import { openDb, defaultDbPath, nowMs, isMainModule } from './db.js';

export function extractSnapshot(s) {
  const cw = s.context_window || {};
  const cost = s.cost || {};
  return {
    session_id: s.session_id || null,
    captured_at: nowMs(),
    aiu: s.ai_used && s.ai_used.value != null ? Number(s.ai_used.value)
      : s.ai_used && s.ai_used.formatted != null ? Number(s.ai_used.formatted) : null,
    premium_requests: cost.total_premium_requests != null ? Number(cost.total_premium_requests) : null,
    cost_total: cost.total != null ? Number(cost.total) : null,
    context_tokens: cw.total_tokens != null ? Number(cw.total_tokens) : null,
    context_pct: (cw.current_context_used_percentage ?? cw.used_percentage) ?? null,
    model: (s.model && (s.model.display_name || s.model.id)) || null,
  };
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  let s = {};
  try { s = JSON.parse(raw || '{}'); } catch { s = {}; }
  const snap = extractSnapshot(s);
  if (snap.session_id) {
    try {
      const db = openDb(defaultDbPath(process.env));
      try {
        db.run(
          'INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total, context_tokens, context_pct, model) VALUES (?,?,?,?,?,?,?,?)',
          [snap.session_id, snap.captured_at, snap.aiu, snap.premium_requests, snap.cost_total, snap.context_tokens, snap.context_pct, snap.model],
        );
        if (snap.model) db.run('UPDATE sessions SET model=? WHERE session_id=?', [snap.model, snap.session_id]);
      } finally { db.close(); }
    } catch { /* tracking is best-effort; never disrupt the session */ }
  }
  // Intentionally print nothing: the status line stays empty.
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
