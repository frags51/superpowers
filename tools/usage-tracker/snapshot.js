// Headless usage-snapshot collector.
//
// Wired as the Copilot CLI `statusLine` command — the ONLY way to receive the
// cumulative usage `statusObject` (AI credits, premium requests, cost, model).
// It records a `usage_snapshots` row (the source for phase credit/cost deltas).
// By default it prints NOTHING, so there is no visible status line. When invoked
// with `--debug` (wired by `install.js --debug`), it also prints a brief status
// line showing the session's cumulative AI credits (e.g. `⚡ 12.34 AIC`).
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

// Exact cumulative AIU from the statusObject's `ai_used`. The Copilot CLI v1.x
// reports `total_nano_aiu` (AIU * 1e9); older builds exposed a raw `value`. The
// `formatted` string is lossy (e.g. "<0.01", rounded values) and must never be
// used as the numeric source, or per-phase deltas drift / go NaN.
const NANO_PER_AIU = 1e9;
export function aiuFromStatus(used) {
  if (!used) return null;
  if (used.total_nano_aiu != null && Number.isFinite(Number(used.total_nano_aiu))) {
    return Number(used.total_nano_aiu) / NANO_PER_AIU;
  }
  if (used.value != null && Number.isFinite(Number(used.value))) {
    return Number(used.value);
  }
  return null;
}

export function extractSnapshot(s) {
  const cw = s.context_window || {};
  const cost = s.cost || {};
  return {
    session_id: s.session_id || null,
    captured_at: nowMs(),
    aiu: aiuFromStatus(s.ai_used),
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
  // Only with `--debug` do we show the cumulative AI credits in the status line;
  // otherwise stay silent so the status line is unaffected (the default UX).
  if (process.argv.includes('--debug')) {
    const line = formatStatusLine(s);
    if (line) process.stdout.write(line + '\n');
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
