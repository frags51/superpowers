// Copilot CLI usage tracker — hook handler & phase state machine.
// Invoked per hook as a fresh process: `node tracker.js <event>` with the
// hook JSON payload on stdin. All "current" state is derived from the DB.
import { readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  openDb, defaultDbPath, nowMs, genId, gitBranch, gitRepo, gitBranchForPath, isMainModule,
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
    resolveFeatureForDir: o.resolveFeatureForDir || ((dir) => gitBranchForPath(dir)),
    resolveRepo: o.resolveRepo || ((cwd) => gitRepo(cwd)),
    transcriptPath: o.transcriptPath || null,
    resolveTranscript: o.resolveTranscript || ((s) => defaultTranscript(s, env)),
  };
}

const sid = (p) => p.sessionId || p.session_id;

// Extract a Copilot session ID from a transcript path that follows the CLI's
// convention: …/session-state/{session-id}/events.jsonl (or …\session-state\…
// on Windows). Returns null when the path doesn't match the pattern.
function childSessionFromTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  const m = transcriptPath.match(/session-state[/\\]([^/\\]+)[/\\]/);
  return m ? m[1] : null;
}

// Copilot CLI sends `timestamp` as a number for Copilot-native events but as an
// ISO-8601 string for Claude-compatible events (PreToolUse, PostToolUse,
// SessionStart, SessionEnd, UserPromptSubmit, SubagentStop). Accept both; fall
// back to wall-clock when absent or unparseable.
const ts = (p) => {
  if (typeof p.timestamp === 'number') return p.timestamp;
  if (typeof p.timestamp === 'string') {
    const n = Date.parse(p.timestamp);
    if (!Number.isNaN(n)) return n;
  }
  return nowMs();
};

// Copilot CLI delivers hook payloads in two shapes depending on the event's
// origin. Events that mirror a Claude Code hook — PreToolUse, PostToolUse,
// SubagentStop, SessionStart, SessionEnd, UserPromptSubmit — arrive in
// snake_case (`tool_name`, `tool_input`, `transcript_path`, `agent_name`,
// `stop_reason`, ...) alongside a `hook_event_name` field. Copilot-native
// events (e.g. subagentStart) arrive in camelCase. Synthetic payloads from the
// tests and `--selftest` are already camelCase. Map the snake_case keys onto
// the camelCase names the handlers read so a single code path serves every
// shape. Existing camelCase keys always win, so already-normalized payloads
// pass through unchanged.
function normalizePayload(p) {
  if (!p || typeof p !== 'object') return p;
  const out = { ...p };
  const alias = (camel, snake) => {
    if (out[camel] === undefined && out[snake] !== undefined) out[camel] = out[snake];
  };
  alias('sessionId', 'session_id');
  alias('toolName', 'tool_name');
  alias('toolInput', 'tool_input');
  alias('toolCallId', 'tool_call_id');
  alias('transcriptPath', 'transcript_path');
  alias('agentName', 'agent_name');
  alias('agentDisplayName', 'agent_display_name');
  alias('agentDescription', 'agent_description');
  alias('stopReason', 'stop_reason');
  return out;
}

// Copilot CLI tool hooks deliver arguments under `toolArgs`; accept the older
// `toolInput`/`arguments` shapes too for robustness.
//
// The live CLI delivers `toolArgs` as a JSON-encoded *string*
// (e.g. `'{"skill":"test-driven-development"}'`), not a nested object. Parse it
// so downstream field access works: the phase/skill name (`input.skill`), the
// subagent attribution (`input.agent_type`/`input.description`), and the
// worktree-branch detection (`input.path`/`input.command`) all read object
// fields. Synthetic/legacy payloads that already pass an object pass through
// unchanged. A non-JSON or non-object value normalizes to `{}` so callers never
// see a primitive.
function parseToolArgs(v) {
  if (typeof v === 'string') {
    if (v === '') return {};
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return v && typeof v === 'object' ? v : {};
}
const toolArgsOf = (p) => parseToolArgs(p.toolArgs ?? p.toolInput ?? p.arguments ?? {});

// Tools that express "I am working here": file writers and shell `cd`. Reads
// (view/grep/glob) are deliberately excluded so that incidentally reading a
// file outside the worktree never redefines the task's branch.
const WORK_TOOLS = new Set(['edit', 'create', 'bash']);

// Best-effort working directory for a work-defining tool call. Returns null when
// no directory can be inferred (caller then leaves the feature untouched).
function workDirFromArgs(toolName, args) {
  if (!args || typeof args !== 'object') return null;
  if (typeof args.path === 'string' && args.path) return dirname(args.path);
  if (toolName === 'bash' && typeof args.command === 'string') {
    const m = args.command.match(/\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
    if (m) return m[1] || m[2] || m[3] || null;
  }
  return null;
}

// Resolve the git branch of the directory a work-defining tool acts on. Used to
// follow the agent into a git worktree even though the session cwd never moves.
function detectWorkBranch(toolName, args, opts) {
  if (!WORK_TOOLS.has(toolName)) return null;
  const dir = workDirFromArgs(toolName, args);
  if (!dir) return null;
  try {
    return opts.resolveFeatureForDir(dir);
  } catch {
    return null;
  }
}

// Re-attribute a task (and all its phases) to the branch the agent is actually
// working in. Sticky away from the session branch: a worktree branch wins and a
// later write back in the session branch (e.g. a submodule bump) won't flip it.
function reconcileFeature(db, task, s, toolName, args, opts) {
  const branch = detectWorkBranch(toolName, args, opts);
  if (!branch) return;
  const sess = db.get('SELECT branch FROM sessions WHERE session_id=?', [s]);
  const sessionBranch = sess ? sess.branch : null;
  if (branch === sessionBranch) return;
  if (branch === task.feature) return;
  db.run('UPDATE tasks SET feature=? WHERE task_id=?', [branch, task.task_id]);
  db.run('UPDATE phases SET feature=? WHERE task_id=?', [branch, task.task_id]);
}

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

  // Roll in AIC from child sessions whose subagents were active during this phase.
  // A child Copilot session's AIC counter is session-scoped (starts at 0), so
  // snapshotDelta naturally zero-baselines when the child started after the
  // parent phase began — the common case.
  const children = db.all(
    'SELECT child_session_id FROM subagents WHERE phase_id=? AND child_session_id IS NOT NULL',
    [phase.phase_id],
  );
  for (const { child_session_id } of children) {
    const childSnaps = db.all(
      'SELECT captured_at, aiu, premium_requests, cost_total FROM usage_snapshots WHERE session_id=? ORDER BY captured_at',
      [child_session_id],
    );
    if (!childSnaps.length) continue;
    const cd = snapshotDelta(childSnaps, phase.started_at, phase.ended_at);
    const add = (a, b) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));
    d.aiu_delta = add(d.aiu_delta, cd.aiu_delta);
    d.premium_delta = add(d.premium_delta, cd.premium_delta);
    d.cost_delta = add(d.cost_delta, cd.cost_delta);
  }

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
    // If userPromptSubmitted already opened a task before sessionStart arrived
    // (kick-off-style sessions), reopen a root phase so usage is attributed.
    const existingTask = activeTask(db, s);
    if (existingTask) openPhase(db, existingTask, s, existingTask.feature, null, 'root', at);
    db.run("UPDATE subagents SET status='stopped', stop_reason='stale', ended_at=? WHERE session_id=? AND status='running'", [at, s]);
    // Late-bind: when subagentStart fired with a transcript_path but
    // childSessionFromTranscript could not extract a session ID (non-standard
    // path), link this session to the waiting subagent row now that we know s.
    if (transcript) {
      db.run(
        "UPDATE subagents SET child_session_id=? WHERE transcript_path=? AND child_session_id IS NULL AND status='running'",
        [s, transcript],
      );
    }
    // Auto-link for bash-spawned Copilot CLI (scenario 2): if there is exactly
    // one open bash span tagged 'copilot-cli' in another session that started
    // before this sessionStart, synthesize a subagent record so finalizePhaseUsage
    // can roll up the child's usage into the parent's phase delta.  We require
    // exactly one candidate to avoid mis-attribution when multiple parent sessions
    // are running concurrently.  This is safe to call even for sessions that
    // already registered a proper subagent link via transcript path — the INSERT
    // is guarded by `child_session_id IS NULL` on the existing row so it never
    // double-links.
    const bashCandidates = db.all(
      "SELECT * FROM spans WHERE name='bash' AND detail='copilot-cli' AND ended_at IS NULL AND session_id != ? AND started_at <= ?",
      [s, at],
    );
    if (bashCandidates.length === 1) {
      const sp = bashCandidates[0];
      // Only create the synthetic subagent if this span isn't already linked to
      // a child session (handles the case where the same bash invocation fires
      // two sessionStart events, e.g. re-init after a restart).
      const alreadyLinked = db.get(
        'SELECT subagent_id FROM subagents WHERE session_id=? AND started_at=? AND child_session_id IS NOT NULL',
        [sp.session_id, sp.started_at],
      );
      if (!alreadyLinked) {
        db.run(
          "INSERT INTO subagents (subagent_id, session_id, task_id, phase_id, agent_name, description, child_session_id, started_at, status) VALUES (?,?,?,?, 'copilot-bash', 'auto-linked from bash invocation', ?,?, 'running')",
          [genId(), sp.session_id, sp.task_id, sp.phase_id, s, sp.started_at],
        );
      }
    }
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
    reconcileFeature(db, task, s, toolName, input, opts);
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
    } else if (toolName === 'bash') {
      // Tag bash spans that invoke the Copilot CLI binary so sessionStart can
      // auto-link the resulting child session to this parent (scenario 2: copilot
      // launched via bash rather than the task tool).
      // Match `copilot` only when it is the executable being invoked: at the
      // start of the command (or after && || ; ( \n), optionally preceded by a
      // path prefix like `./` or `/usr/bin/`.  This avoids matching the word
      // "copilot" in comments, arguments, or package names like
      // `@github/copilot-language-server`.
      const cmd = input.command || '';
      if (/(?:^|[;&|(\n])\s*(?:[^\s;|&()\n]*[/\\])?copilot(?:\s|--|$)/.test(cmd)) {
        detail = 'copilot-cli';
      }
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
    // Extract the child Copilot session ID from the transcript path so parent
    // phases can roll up child usage without any cooperation from the child process.
    const childSessionId = childSessionFromTranscript(p.transcriptPath);
    db.run(
      "INSERT INTO subagents (subagent_id, session_id, task_id, phase_id, agent_name, agent_display_name, description, transcript_path, child_session_id, started_at, status) VALUES (?,?,?,?,?,?,?,?,?,?, 'running')",
      [genId(), s, task ? task.task_id : null, phase ? phase.phase_id : null,
        p.agentName, p.agentDisplayName || null, p.agentDescription || null, p.transcriptPath || null, childSessionId, at],
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
  fn(db, normalizePayload(payload), o);
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
