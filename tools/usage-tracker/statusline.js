// Copilot HUD status line + usage snapshot writer.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openDb, defaultDbPath, nowMs, isMainModule } from './db.js';

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
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

function shortName(n) { return String(n || '').split(':').pop(); }

export function composeLine({ model, aiu, tokens, ctxPct, premium, running, totalAgents, td }) {
  const usage = [`\u2728 ${aiu} AIU`, `\u{1F522} ${fmtNum(tokens)} tok` + (ctxPct != null ? ` (${ctxPct}% ctx)` : '')];
  if (premium) usage.push(`\u26A1 ${premium} prem`);
  let agents;
  if (running && running.length) {
    const names = running.map((r) => shortName(r.agent_name)).join(',');
    const seg = `\u{1F916} ${running.length}\u25B6 ${names}`;
    agents = seg.length <= 40 ? seg : `\u{1F916} ${running.length}\u25B6/${totalAgents}`;
  } else {
    agents = totalAgents > 0 ? `\u{1F916} 0\u25B6/${totalAgents}` : `\u{1F916} 0`;
  }
  let todos = `\u2705 ${td.done}/${td.total}`;
  if (td.total === 0) todos = `\u2705 0`;
  else {
    if (td.in_progress) todos += ` (${td.in_progress}\u25B6)`;
    if (td.blocked) todos += ` (${td.blocked}\u26D4)`;
  }
  const sep = '  \u00B7  ';
  return [`\u2318 ${model}`, usage.join(' '), agents, todos].join(sep);
}

function readTodos(sessionId, env) {
  const home = env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || '.', '.copilot');
  const db = join(home, 'session-state', sessionId, 'session.db');
  const td = { total: 0, done: 0, in_progress: 0, pending: 0, blocked: 0 };
  if (!sessionId || !existsSync(db)) return td;
  try {
    const out = execFileSync('sqlite3', [db, "SELECT status||'\t'||COUNT(*) FROM todos GROUP BY status;"], { encoding: 'utf8', timeout: 2000 });
    out.trim().split('\n').filter(Boolean).forEach((line) => {
      const [st, c] = line.split('\t');
      const n = parseInt(c, 10) || 0;
      if (st in td) td[st] += n;
      td.total += n;
    });
  } catch { /* table may not exist yet */ }
  return td;
}

function main() {
  let raw = '';
  try { raw = readFileSync(0, 'utf8'); } catch { /* ignore */ }
  let s = {};
  try { s = JSON.parse(raw || '{}'); } catch { s = {}; }
  const sessionId = s.session_id || null;
  const snap = extractSnapshot(s);

  let running = [];
  let totalAgents = 0;
  if (sessionId) {
    try {
      const db = openDb(defaultDbPath(process.env));
      try {
        db.run(
          'INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total, context_tokens, context_pct, model) VALUES (?,?,?,?,?,?,?,?)',
          [snap.session_id, snap.captured_at, snap.aiu, snap.premium_requests, snap.cost_total, snap.context_tokens, snap.context_pct, snap.model],
        );
        if (snap.model) db.run('UPDATE sessions SET model=? WHERE session_id=?', [snap.model, sessionId]);
        running = db.all("SELECT agent_name FROM subagents WHERE session_id=? AND status='running' ORDER BY started_at", [sessionId]);
        const tot = db.get('SELECT COUNT(*) AS c FROM subagents WHERE session_id=?', [sessionId]);
        totalAgents = tot ? tot.c : 0;
      } finally { db.close(); }
    } catch { /* tracking optional */ }
  }

  const line = composeLine({
    model: (s.model && (s.model.display_name || s.model.id)) || 'model',
    aiu: (s.ai_used && s.ai_used.formatted) || '0',
    tokens: snap.context_tokens || 0,
    ctxPct: snap.context_pct,
    premium: snap.premium_requests || 0,
    running, totalAgents,
    td: readTodos(sessionId, process.env),
  });
  process.stdout.write(line + '\n');
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
