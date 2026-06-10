// Headless usage-snapshot collector.
//
// Wired as the Copilot CLI `statusLine` command — the ONLY way to receive the
// cumulative usage `statusObject` (AI credits, premium requests, cost, model).
// It records a `usage_snapshots` row (the source for phase credit/cost deltas)
// and prints a brief status line showing the session's cumulative AI credits.
import { readFileSync } from 'node:fs';
import { openDb, defaultDbPath, nowMs, isMainModule } from './db.js';

// Build the brief status-line text shown in the Copilot CLI: a ⚡ icon plus the
// session's cumulative AI credits (AIC). Prefers the CLI's pre-formatted value,
// falling back to the raw number. Returns '' when no AIC is available (e.g. an
// empty statusObject), so the status line simply stays blank.
export function formatStatusLine(s) {
  const used = s && s.ai_used;
  if (!used) return '';
  let label = null;
  if (used.formatted != null && String(used.formatted).trim() !== '') {
    label = String(used.formatted).trim();
  } else if (used.value != null && Number.isFinite(Number(used.value))) {
    label = Number(used.value).toLocaleString();
  }
  if (label == null) return '';
  return `⚡ ${label} AIC`;
}

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
  // Display the cumulative AI credits in the status line (blank if unavailable).
  const line = formatStatusLine(s);
  if (line) process.stdout.write(line + '\n');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
