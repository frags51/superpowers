// CLI: list running (and optionally stopped) subagents and what they're doing.
// Usage: node subagents.js [--all] [--session <id>] [--json]
import { openDb, defaultDbPath, nowMs, isMainModule } from './db.js';

export function fmtElapsed(ms) {
  if (ms == null || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function pad(s, n) { s = String(s || ''); return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length); }

export function renderRows({ sessionId, now, running, stoppedCount, total, json, all, stopped }) {
  if (json) {
    return JSON.stringify({ sessionId, running, stopped: stopped || [], total }, null, 2);
  }
  const lines = [];
  lines.push(`RUNNING SUBAGENTS (session ${sessionId || 'n/a'})`);
  if (!running.length) lines.push('  (none running)');
  for (const r of running) {
    const elapsed = fmtElapsed(now - r.started_at);
    const desc = r.description ? `"${r.description}"` : '';
    lines.push(`  \u25B6 ${pad(r.agent_name, 26)} ${pad(desc, 36)} ${elapsed}`);
  }
  if (all && stopped && stopped.length) {
    lines.push('');
    lines.push('STOPPED:');
    for (const r of stopped) {
      const dur = r.duration_reliable && r.duration_ms != null ? fmtElapsed(r.duration_ms) : '   ~  ';
      lines.push(`  \u2713 ${pad(r.agent_name, 26)} ${pad(r.description ? `"${r.description}"` : '', 36)} ${dur}`);
    }
  }
  lines.push('');
  lines.push(`${stoppedCount} stopped this session \u00B7 ${total} total`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const a = { all: false, json: false, session: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--all') a.all = true;
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--session') a.session = argv[++i];
  }
  return a;
}

function resolveSession(db, explicit, env) {
  if (explicit) return explicit;
  if (env.COPILOT_SESSION_ID) return env.COPILOT_SESSION_ID;
  const row = db.get("SELECT session_id FROM subagents WHERE status='running' ORDER BY started_at DESC LIMIT 1", []);
  if (row) return row.session_id;
  const sess = db.get('SELECT session_id FROM sessions ORDER BY started_at DESC LIMIT 1', []);
  return sess ? sess.session_id : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let db;
  try {
    db = openDb(defaultDbPath(process.env));
    const sessionId = resolveSession(db, args.session, process.env);
    const now = nowMs();
    const running = sessionId
      ? db.all("SELECT agent_name, description, started_at FROM subagents WHERE session_id=? AND status='running' ORDER BY started_at", [sessionId])
      : [];
    const stopped = sessionId && args.all
      ? db.all("SELECT agent_name, description, duration_ms, duration_reliable FROM subagents WHERE session_id=? AND status='stopped' ORDER BY started_at", [sessionId])
      : [];
    const stoppedCount = sessionId
      ? (db.get("SELECT COUNT(*) AS c FROM subagents WHERE session_id=? AND status='stopped'", [sessionId]).c)
      : 0;
    const total = sessionId
      ? (db.get('SELECT COUNT(*) AS c FROM subagents WHERE session_id=?', [sessionId]).c)
      : 0;
    process.stdout.write(renderRows({ sessionId, now, running, stopped, stoppedCount, total, json: args.json, all: args.all }) + '\n');
  } catch {
    process.stdout.write('subagents: unable to read usage DB\n');
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
