// Headless usage-snapshot collector.
//
// Wired as the Copilot CLI `statusLine` command — the ONLY way to receive the
// cumulative usage `statusObject` (AI credits, premium requests, cost, model).
// It records a `usage_snapshots` row (the source for phase credit/cost deltas).
// By default it prints NOTHING, so there is no visible status line. When invoked
// with `--debug` (wired by `install.js --debug`), it also prints a brief status
// line with the captured telemetry — cumulative AI credits plus any premium
// requests, cost, context usage, and model (e.g.
// `⚡ 12.34 AIC · 3 prem · $0.50 · 18% ctx · Opus 4.8`).
import { readFileSync } from 'node:fs';
import { openDb, defaultDbPath, nowMs, isMainModule } from './db.js';

// Exact cumulative AIU from the statusObject's `ai_used`. The Copilot CLI v1.x
// reports `total_nano_aiu` (AIU * 1e9); older builds exposed a raw `value`. The
// `formatted` string is lossy (e.g. "<0.01", rounded values) and must never be
// used as the numeric source, or per-phase deltas drift / go NaN.
const NANO_PER_AIU = 1e9;

// Read the session's events.jsonl and extract a usage snapshot from the
// `session.shutdown` event that Copilot CLI always writes at session end —
// including --autopilot / -p / --acp modes where the statusLine command is
// never invoked (so usage_snapshots would otherwise stay empty).
//
// capturedAt defaults to now; callers can pass the session's ended_at timestamp
// so the snapshot falls within the correct phase window for snapshotDelta.
//
// Returns null when the file is unreadable or has no session.shutdown event
// (e.g. the process was killed before it could write the final event).
export function readShutdownSnapshot(transcriptPath, sessionId, capturedAt = nowMs()) {
  if (!transcriptPath) return null;
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return null; }

  // Scan lines in reverse — session.shutdown is always the final event.
  const lines = raw.split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== 'session.shutdown') continue;
    const d = obj.data || {};
    const nanoAiu = d.totalNanoAiu;
    const aiu = nanoAiu != null && Number.isFinite(Number(nanoAiu))
      ? Number(nanoAiu) / NANO_PER_AIU : null;
    if (aiu == null) return null;

    // Sum cost_total across all model entries (each has requests.cost).
    let cost_total = null;
    if (d.modelMetrics && typeof d.modelMetrics === 'object') {
      let sum = 0;
      for (const m of Object.values(d.modelMetrics)) {
        const c = m?.requests?.cost;
        if (c != null && Number.isFinite(Number(c))) sum += Number(c);
      }
      if (sum > 0) cost_total = sum;
    }

    return {
      session_id: sessionId,
      captured_at: capturedAt,
      aiu,
      premium_requests: d.totalPremiumRequests != null ? Number(d.totalPremiumRequests) : null,
      cost_total,
    };
  }
  return null;
}

// Scan a session transcript for in-process subagent lifecycle events
// (`subagent.started` / `subagent.completed`). The Copilot CLI runs `task`-tool
// subagents inside the parent session and tags their hook activity with the
// subagent's `agentId` (== the tool-call id, e.g. `toolu_bdrk_…`) as a phantom
// `session_id`. These phantom sessions have no `usage_snapshots`, so they show
// 0 AIC. The parent transcript is the only place that records each subagent's
// id, agent name, and start/stop timestamps — which the report uses to attribute
// AIC from the PARENT session's cumulative snapshots over the subagent's window.
//
// Returns [{ agentId, agentName, startedAt, endedAt }]; endedAt is null for a
// subagent that started but has no completion event (still running / killed).
export function subagentWindowsFromTranscript(transcriptPath) {
  if (!transcriptPath) return [];
  let raw;
  try { raw = readFileSync(transcriptPath, 'utf8'); } catch { return []; }
  const wins = new Map(); // agentId -> { agentName, startedAt, endedAt }
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'subagent.started' && o.type !== 'subagent.completed') continue;
    const d = o.data || {};
    const agentId = o.agentId || d.toolCallId;
    if (!agentId) continue;
    const t = Date.parse(o.timestamp);
    if (Number.isNaN(t)) continue;
    const w = wins.get(agentId) || { agentName: null, startedAt: null, endedAt: null };
    if (d.agentName && !w.agentName) w.agentName = d.agentName;
    if (o.type === 'subagent.started') w.startedAt = t;
    else w.endedAt = t;
    wins.set(agentId, w);
  }
  return [...wins.entries()].map(([agentId, w]) => ({ agentId, ...w }));
}


// wired with `--debug`. Leads with the session's cumulative AI credits (the
// exact value from `aiuFromStatus`, never the lossy `formatted` string) and
// appends the rest of the captured telemetry — premium requests, cost, context
// usage, and model — including only the fields actually present. Returns '' when
// no AI credits are available, so the status line simply stays blank.
export function formatStatusLine(s) {
  const snap = extractSnapshot(s);
  if (snap.aiu == null) return '';
  const parts = [`⚡ ${Number(snap.aiu).toLocaleString()} AIC`];
  if (snap.premium_requests != null) parts.push(`${Number(snap.premium_requests).toLocaleString()} prem`);
  if (snap.cost_total != null) parts.push(`$${Number(snap.cost_total).toFixed(2)}`);
  if (snap.context_pct != null) parts.push(`${Math.round(Number(snap.context_pct))}% ctx`);
  if (snap.model) parts.push(String(snap.model));
  return parts.join(' · ');
}

// Exact cumulative AIU from the statusObject's `ai_used`. The Copilot CLI v1.x
// reports `total_nano_aiu` (AIU * 1e9); older builds exposed a raw `value`. The
// `formatted` string is lossy (e.g. "<0.01", rounded values) and must never be
// used as the numeric source, or per-phase deltas drift / go NaN.
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
