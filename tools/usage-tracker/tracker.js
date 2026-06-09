// Copilot CLI usage tracker — hook handler & phase state machine.
// Invoked per hook as a fresh process: `node tracker.js <event>` with the
// hook JSON payload on stdin. All "current" state is derived from the DB.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDb, defaultDbPath, nowMs, genId, gitBranch, gitRepo, isMainModule,
} from './db.js';
import { snapshotDelta, sumOutputTokens, toolMatchKey } from './usage.js';

const EXCERPT_LEN = 120;

function defaultTranscript(sessionId, env) {
  const home = env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || '.', '.copilot');
  return join(home, 'session-state', sessionId, 'events.jsonl');
}

function normalizeOpts(o = {}) {
  const env = o.env || process.env;
  return {
    env,
    resolveFeature: o.resolveFeature || ((cwd) => gitBranch(cwd)),
    resolveRepo: o.resolveRepo || ((cwd) => gitRepo(cwd)),
    transcriptPath: o.transcriptPath || null,
    resolveTranscript: o.resolveTranscript || ((s) => defaultTranscript(s, env)),
  };
}

const sid = (p) => p.sessionId || p.session_id;
const ts = (p) => (typeof p.timestamp === 'number' ? p.timestamp : nowMs());

// Copilot CLI tool hooks deliver arguments under `toolArgs`; accept the older
// `toolInput`/`arguments` shapes too for robustness.
const toolArgsOf = (p) => (p.toolArgs ?? p.toolInput ?? p.arguments ?? {});

function activeTask(db, s) {
  return db.get('SELECT * FROM tasks WHERE session_id=? AND ended_at IS NULL ORDER BY turn_index DESC LIMIT 1', [s]);
}
function activePhase(db, s) {
  return db.get("SELECT * FROM phases WHERE session_id=? AND status='active' ORDER BY seq DESC LIMIT 1", [s]);
}

function transcriptFor(s, opts) {
  return opts.transcriptPath || opts.resolveTranscript(s);
}

function finalizePhaseUsage(db, phase, opts) {
  const snaps = db.all(
    'SELECT captured_at, aiu, premium_requests, cost_total FROM usage_snapshots WHERE session_id=? AND captured_at<=? ORDER BY captured_at',
    [phase.session_id, phase.ended_at],
  );
  const d = snapshotDelta(snaps, phase.started_at, phase.ended_at);
  const t = sumOutputTokens(transcriptFor(phase.session_id, opts), phase.started_at, phase.ended_at);
  db.run(
    'UPDATE phases SET aiu_delta=?, premium_delta=?, cost_delta=?, input_tokens=?, output_tokens=?, total_tokens=? WHERE phase_id=?',
    [d.aiu_delta, d.premium_delta, d.cost_delta, t.input_tokens, t.output_tokens, t.total_tokens, phase.phase_id],
  );
}

function closePhase(db, phase, at, opts) {
  if (!phase || phase.status === 'closed') return;
  const dur = at != null && phase.started_at != null ? at - phase.started_at : null;
  db.run("UPDATE phases SET ended_at=?, duration_ms=?, status='closed' WHERE phase_id=?", [at, dur, phase.phase_id]);
  const updated = db.get('SELECT * FROM phases WHERE phase_id=?', [phase.phase_id]);
  finalizePhaseUsage(db, updated, opts);
}

function closeOpenSpans(db, s, at) {
  const open = db.all('SELECT * FROM spans WHERE session_id=? AND ended_at IS NULL', [s]);
  for (const sp of open) {
    const dur = at != null && sp.started_at != null ? at - sp.started_at : null;
    db.run('UPDATE spans SET ended_at=?, duration_ms=? WHERE span_id=?', [at, dur, sp.span_id]);
  }
}

function closeTask(db, s, at, opts) {
  closeOpenSpans(db, s, at);
  let ph;
  while ((ph = activePhase(db, s))) closePhase(db, ph, at, opts);
  const task = activeTask(db, s);
  if (task) {
    const dur = at != null && task.started_at != null ? at - task.started_at : null;
    db.run('UPDATE tasks SET ended_at=?, duration_ms=? WHERE task_id=?', [at, dur, task.task_id]);
  }
}

function openPhase(db, task, s, feature, skill, kind, at) {
  const seqRow = db.get('SELECT COALESCE(MAX(seq), -1) AS m FROM phases WHERE task_id=?', [task.task_id]);
  const seq = (seqRow.m ?? -1) + 1;
  const id = genId();
  db.run(
    "INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, started_at, status) VALUES (?,?,?,?,?,?,?,?, 'active')",
    [id, task.task_id, s, feature, skill, kind, seq, at],
  );
  return db.get('SELECT * FROM phases WHERE phase_id=?', [id]);
}

function openTask(db, s, p, opts, promptExcerpt) {
  const maxRow = db.get('SELECT COALESCE(MAX(turn_index), -1) AS m FROM tasks WHERE session_id=?', [s]);
  const turn = (maxRow.m ?? -1) + 1;
  const taskId = `${s}:${turn}`;
  const feature = opts.resolveFeature(p.cwd);
  const at = ts(p);
  db.run(
    'INSERT INTO tasks (task_id, session_id, feature, turn_index, prompt_excerpt, started_at) VALUES (?,?,?,?,?,?)',
    [taskId, s, feature, turn, promptExcerpt, at],
  );
  const task = db.get('SELECT * FROM tasks WHERE task_id=?', [taskId]);
  openPhase(db, task, s, feature, null, 'root', at);
  return task;
}

function ensureActiveTask(db, s, p, opts) {
  const task = activeTask(db, s);
  if (task) return task;
  return openTask(db, s, p, opts, null);
}

function closeSpan(db, p, success) {
  const s = sid(p);
  const at = ts(p);
  const key = toolMatchKey(p.toolName, toolArgsOf(p));
  let span;
  if (p.toolCallId) {
    span = db.get('SELECT * FROM spans WHERE tool_call_id=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [p.toolCallId]);
  }
  if (!span) {
    span = db.get('SELECT * FROM spans WHERE session_id=? AND match_key=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [s, key]);
  }
  if (!span) {
    span = db.get('SELECT * FROM spans WHERE session_id=? AND name=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', [s, p.toolName]);
  }
  if (!span) return;
  const dur = at != null && span.started_at != null ? at - span.started_at : null;
  db.run('UPDATE spans SET ended_at=?, duration_ms=?, success=? WHERE span_id=?', [at, dur, success, span.span_id]);
}

const HANDLERS = {
  sessionStart(db, p, opts) {
    const s = sid(p);
    const at = ts(p);
    const feature = opts.resolveFeature(p.cwd);
    const repo = opts.resolveRepo(p.cwd);
    const transcript = p.transcriptPath || opts.resolveTranscript(s);
    db.run(
      `INSERT INTO sessions (session_id, cwd, repo, branch, transcript_path, started_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(session_id) DO UPDATE SET cwd=excluded.cwd, repo=excluded.repo, branch=excluded.branch, transcript_path=excluded.transcript_path`,
      [s, p.cwd, repo, feature, transcript, at],
    );
    closeOpenSpans(db, s, at);
    let ph;
    while ((ph = activePhase(db, s))) closePhase(db, ph, at, opts);
    db.run("UPDATE subagents SET status='stopped', stop_reason='stale', ended_at=? WHERE session_id=? AND status='running'", [at, s]);
  },

  userPromptSubmitted(db, p, opts) {
    const s = sid(p);
    const at = ts(p);
    closeTask(db, s, at, opts);
    let excerpt = null;
    if (opts.env.SUPERPOWERS_USAGE_NO_PROMPT !== '1') {
      const text = p.prompt || p.userPrompt || p.message || p.content || '';
      excerpt = text ? String(text).slice(0, EXCERPT_LEN) : null;
    }
    openTask(db, s, p, opts, excerpt);
  },

  preToolUse(db, p, opts) {
    const s = sid(p);
    const at = ts(p);
    const task = ensureActiveTask(db, s, p, opts);
    const toolName = p.toolName;
    const input = toolArgsOf(p);
    if (toolName === 'skill') {
      const cur = activePhase(db, s);
      if (cur) closePhase(db, cur, at, opts);
      openPhase(db, task, s, task.feature, input.skill || input.name || 'unknown', 'skill', at);
    }
    const phase = activePhase(db, s);
    let detail = null;
    if (toolName === 'task') {
      const a = input.agent_type || input.agentType || '';
      const d = input.description || '';
      detail = [a, d].filter(Boolean).join(': ') || null;
    } else if (toolName === 'skill') {
      detail = input.skill || null;
    }
    db.run(
      "INSERT INTO spans (span_id, phase_id, task_id, session_id, kind, name, detail, tool_call_id, started_at, match_key) VALUES (?,?,?,?, 'tool', ?,?,?,?,?)",
      [genId(), phase ? phase.phase_id : null, task.task_id, s, toolName, detail, p.toolCallId || null, at, toolMatchKey(toolName, input)],
    );
  },

  postToolUse(db, p) { closeSpan(db, p, 1); },
  postToolUseFailure(db, p) { closeSpan(db, p, 0); },

  subagentStart(db, p, opts) {
    const s = sid(p);
    const at = ts(p);
    const task = activeTask(db, s);
    const phase = activePhase(db, s);
    db.run(
      "INSERT INTO subagents (subagent_id, session_id, task_id, phase_id, agent_name, agent_display_name, description, transcript_path, started_at, status) VALUES (?,?,?,?,?,?,?,?,?, 'running')",
      [genId(), s, task ? task.task_id : null, phase ? phase.phase_id : null,
        p.agentName, p.agentDisplayName || null, p.agentDescription || null, p.transcriptPath || null, at],
    );
  },

  subagentStop(db, p) {
    const s = sid(p);
    const at = ts(p);
    const running = db.all(
      "SELECT * FROM subagents WHERE session_id=? AND agent_name=? AND status='running' ORDER BY started_at DESC",
      [s, p.agentName],
    );
    if (running.length === 0) return;
    const target = running[0];
    const reliable = running.length === 1 ? 1 : 0;
    const dur = reliable ? at - target.started_at : null;
    db.run(
      "UPDATE subagents SET status='stopped', stop_reason=?, ended_at=?, duration_ms=?, duration_reliable=? WHERE subagent_id=?",
      [p.stopReason || null, at, dur, reliable, target.subagent_id],
    );
  },

  sessionEnd(db, p, opts) {
    const s = sid(p);
    const at = ts(p);
    closeTask(db, s, at, opts);
    db.run("UPDATE subagents SET status='stopped', stop_reason=COALESCE(stop_reason,'session_end'), ended_at=COALESCE(ended_at,?) WHERE session_id=? AND status='running'", [at, s]);
    db.run("UPDATE sessions SET ended_at=?, end_reason='end' WHERE session_id=?", [at, s]);
  },
};

export function handle(event, payload, db, opts) {
  const o = normalizeOpts(opts);
  const fn = HANDLERS[event];
  if (!fn) return;
  fn(db, payload, o);
}

// --- CLI entry ---
function readStdin() {
  try { return readFileSync(0, 'utf8'); } catch { return ''; }
}

function selftest() {
  const dbPath = join(tmpdir(), `sp-selftest-${genId()}.db`);
  const db = openDb(dbPath);
  const opts = { env: {}, resolveFeature: () => 'feat', resolveRepo: () => 'repo', transcriptPath: '/no/file' };
  try {
    handle('sessionStart', { sessionId: 'x', timestamp: 0, cwd: '/x' }, db, opts);
    handle('userPromptSubmitted', { sessionId: 'x', timestamp: 1, cwd: '/x', prompt: 'hi' }, db, opts);
    handle('preToolUse', { sessionId: 'x', timestamp: 2, cwd: '/x', toolName: 'skill', toolInput: { skill: 'brainstorming' } }, db, opts);
    handle('sessionEnd', { sessionId: 'x', timestamp: 3, cwd: '/x' }, db, opts);
    const ph = db.get("SELECT status FROM phases WHERE skill='brainstorming'", []);
    if (!ph || ph.status !== 'closed') throw new Error('selftest: phase not closed');
    console.log('tracker selftest OK');
  } finally {
    db.close();
    try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
  }
}

function main() {
  const arg = process.argv[2] || '';
  if (arg === '--selftest') return selftest();
  if (process.env.SUPERPOWERS_USAGE_DISABLE === '1') return;
  let payload = {};
  try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
  if (!(payload.sessionId || payload.session_id)) return;
  let db;
  try {
    db = openDb(defaultDbPath(process.env));
    handle(arg, payload, db, { env: process.env });
  } catch {
    /* best effort: never block the session */
  } finally {
    try { db && db.close(); } catch { /* ignore */ }
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  const arg = process.argv[2] || '';
  if (arg === '--selftest') {
    // Selftest reports real failures via a non-zero exit (used by tests/CI).
    main();
  } else {
    // Hook mode is FAIL-OPEN: a usage-tracking hook must never block or deny the
    // user's tool. preToolUse hooks are fail-closed in Copilot CLI — any non-zero
    // exit, timeout, or unhandled rejection would DENY the tool — so we guarantee
    // a clean exit 0 no matter what happens.
    process.exitCode = 0;
    process.on('uncaughtException', () => process.exit(0));
    process.on('unhandledRejection', () => process.exit(0));
    try {
      Promise.resolve().then(main).catch(() => process.exit(0));
    } catch {
      process.exit(0);
    }
  }
}
