import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openDb } from '../db.js';
import { handle } from '../tracker.js';
import { readShutdownSnapshot } from '../snapshot.js';

function freshDb() {
  const path = join(tmpdir(), `sp-trk-${randomUUID()}.db`);
  return { db: openDb(path), path };
}
const opts = (over = {}) => ({
  env: {},
  resolveFeature: () => 'feat-x',
  resolveRepo: () => 'agentharness',
  transcriptPath: null,
  ...over,
});

test('full lifecycle: session -> prompt -> skill phase -> tool span', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-1';
    handle('sessionStart', { sessionId: sid, timestamp: 1000, cwd: '/x' }, db, opts());
    assert.equal(db.get('SELECT branch FROM sessions WHERE session_id=?', [sid]).branch, 'feat-x');

    handle('userPromptSubmitted', { sessionId: sid, timestamp: 1100, cwd: '/x', prompt: 'Build the thing please' }, db, opts());
    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.turn_index, 0);
    assert.equal(task.feature, 'feat-x');
    assert.equal(task.prompt_excerpt, 'Build the thing please');
    const root = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [sid]);
    assert.equal(root.status, 'active');

    handle('preToolUse', { sessionId: sid, timestamp: 1200, cwd: '/x', toolName: 'skill', toolInput: { skill: 'brainstorming' } }, db, opts());
    assert.equal(db.get('SELECT status FROM phases WHERE phase_id=?', [root.phase_id]).status, 'closed');
    const ph = db.get("SELECT * FROM phases WHERE session_id=? AND skill='brainstorming'", [sid]);
    assert.equal(ph.kind, 'skill');
    assert.equal(ph.status, 'active');

    handle('preToolUse', { sessionId: sid, timestamp: 1300, cwd: '/x', toolName: 'grep', toolInput: {}, toolCallId: 'tc1' }, db, opts());
    let span = db.get('SELECT * FROM spans WHERE tool_call_id=?', ['tc1']);
    assert.equal(span.phase_id, ph.phase_id);
    assert.equal(span.ended_at, null);

    handle('postToolUse', { sessionId: sid, timestamp: 1350, toolName: 'grep', toolCallId: 'tc1' }, db, opts());
    span = db.get('SELECT * FROM spans WHERE tool_call_id=?', ['tc1']);
    assert.equal(span.success, 1);
    assert.equal(span.duration_ms, 50);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('second prompt closes prior task and increments turn_index', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-2';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/x', prompt: 'one' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 20, cwd: '/x', prompt: 'two' }, db, opts());
    const tasks = db.all('SELECT * FROM tasks WHERE session_id=? ORDER BY turn_index', [sid]);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].ended_at, 20);
    assert.equal(tasks[1].turn_index, 1);
    assert.equal(tasks[1].ended_at, null);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('subagent reliable when only one of its name runs', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-3';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    handle('subagentStart', { sessionId: sid, timestamp: 100, cwd: '/x', agentName: 'explore', agentDisplayName: 'Explore', agentDescription: 'Find hook payloads' }, db, opts());
    handle('subagentStop', { sessionId: sid, timestamp: 250, agentName: 'explore', stopReason: 'end_turn' }, db, opts());
    const sa = db.get("SELECT * FROM subagents WHERE session_id=? AND agent_name='explore'", [sid]);
    assert.equal(sa.description, 'Find hook payloads');
    assert.equal(sa.status, 'stopped');
    assert.equal(sa.duration_reliable, 1);
    assert.equal(sa.duration_ms, 150);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('subagent duration unreliable & NULL under same-name concurrency', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-4';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    handle('subagentStart', { sessionId: sid, timestamp: 100, cwd: '/x', agentName: 'task', agentDescription: 'A' }, db, opts());
    handle('subagentStart', { sessionId: sid, timestamp: 110, cwd: '/x', agentName: 'task', agentDescription: 'B' }, db, opts());
    handle('subagentStop', { sessionId: sid, timestamp: 300, agentName: 'task', stopReason: 'end_turn' }, db, opts());
    const stopped = db.all("SELECT * FROM subagents WHERE agent_name='task' AND status='stopped'", []);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].duration_reliable, 0);
    assert.equal(stopped[0].duration_ms, null);
    const running = db.all("SELECT * FROM subagents WHERE agent_name='task' AND status='running'", []);
    assert.equal(running.length, 1);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('phase usage finalized from snapshots + transcript on close', () => {
  const { db, path } = freshDb();
  const tx = join(tmpdir(), `sp-trk-tx-${randomUUID()}.jsonl`);
  writeFileSync(tx, [
    JSON.stringify({ type: 'assistant.message', timestamp: new Date(1250).toISOString(), data: { outputTokens: 7 } }),
    JSON.stringify({ type: 'assistant.message', timestamp: new Date(1280).toISOString(), data: { outputTokens: 3 } }),
  ].join('\n'));
  try {
    const sid = 's-5';
    handle('sessionStart', { sessionId: sid, timestamp: 1000, cwd: '/x' }, db, opts({ transcriptPath: tx }));
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 1100, cwd: '/x', prompt: 'p' }, db, opts({ transcriptPath: tx }));
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)', [sid, 1150, 1.0, 1, 0.10]);
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)', [sid, 1290, 1.6, 3, 0.40]);
    handle('preToolUse', { sessionId: sid, timestamp: 1200, cwd: '/x', toolName: 'skill', toolInput: { skill: 'writing-plans' } }, db, opts({ transcriptPath: tx }));
    handle('sessionEnd', { sessionId: sid, timestamp: 1300, cwd: '/x' }, db, opts({ transcriptPath: tx }));
    const ph = db.get("SELECT * FROM phases WHERE skill='writing-plans'", []);
    assert.equal(ph.status, 'closed');
    assert.equal(Math.round(ph.aiu_delta * 10), 6);
    assert.equal(ph.premium_delta, 2);
    assert.equal(ph.output_tokens, 10);
    assert.equal(ph.input_tokens, null);
    assert.equal(db.get('SELECT end_reason FROM sessions WHERE session_id=?', [sid]).end_reason, 'end');
  } finally {
    db.close();
    rmSync(path, { force: true });
    rmSync(tx, { force: true });
  }
});

test('overlapping tools paired by args hash when no toolCallId', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-6';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    // two different tools open, neither carries a toolCallId (real CLI shape)
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/x', toolName: 'grep', toolArgs: { pattern: 'foo' } }, db, opts());
    handle('preToolUse', { sessionId: sid, timestamp: 110, cwd: '/x', toolName: 'view', toolArgs: { path: '/a' } }, db, opts());
    // view finishes first, then grep — name-only matching could mis-pair; hash must not
    handle('postToolUse', { sessionId: sid, timestamp: 160, toolName: 'view', toolArgs: { path: '/a' } }, db, opts());
    handle('postToolUse', { sessionId: sid, timestamp: 230, toolName: 'grep', toolArgs: { pattern: 'foo' } }, db, opts());
    const grep = db.get("SELECT * FROM spans WHERE name='grep'", []);
    const view = db.get("SELECT * FROM spans WHERE name='view'", []);
    assert.equal(view.duration_ms, 50);   // 160 - 110
    assert.equal(grep.duration_ms, 130);  // 230 - 100
    assert.equal(view.success, 1);
    assert.equal(grep.success, 1);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('skill phase detected from toolArgs (real CLI field name)', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-7';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/x', toolName: 'skill', toolArgs: { skill: 'systematic-debugging' } }, db, opts());
    const ph = db.get("SELECT * FROM phases WHERE session_id=? AND skill='systematic-debugging'", [sid]);
    assert.equal(ph.kind, 'skill');
    assert.equal(ph.status, 'active');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: the LIVE Copilot CLI delivers `toolArgs` as a JSON-encoded *string*
// (verified against CLI 1.0.60 with a capture hook), not a nested object. Earlier
// tests only exercised the object shape, so a string payload silently dropped the
// skill name (phase -> 'unknown'), the task detail, and worktree detection.
test('toolArgs arriving as a JSON string (real CLI shape) is parsed', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-str';
    const o = wtOpts({ '/wt/feat-x': 'feat-x' });
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/repo', prompt: 'p' }, db, o);

    // skill phase: skill name must be read out of the stringified args
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/repo', toolName: 'skill', toolArgs: '{"skill":"test-driven-development"}' }, db, o);
    const ph = db.get("SELECT * FROM phases WHERE session_id=? AND skill='test-driven-development'", [sid]);
    assert.ok(ph, 'skill phase should be labeled, not "unknown"');
    assert.equal(ph.kind, 'skill');

    // task span: detail must combine agent_type + description from the string
    handle('preToolUse', { sessionId: sid, timestamp: 110, cwd: '/repo', toolName: 'task', toolArgs: '{"agent_type":"explore","description":"Probe reply test"}' }, db, o);
    const taskSpan = db.get("SELECT detail FROM spans WHERE session_id=? AND name='task'", [sid]);
    assert.equal(taskSpan.detail, 'explore: Probe reply test');

    // worktree detection: edit path in the string must re-attribute the branch
    handle('preToolUse', { sessionId: sid, timestamp: 120, cwd: '/repo', toolName: 'edit', toolArgs: '{"path":"/wt/feat-x/src/a.js"}' }, db, o);
    const task = db.get('SELECT feature FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'feat-x');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Sessions start in `master` but the agent creates a git worktree on a feature
// branch and works there. The session cwd never changes, so the branch must be
// inferred from where the agent actually writes (edit/create paths, bash `cd`).
const wtOpts = (mapping, over = {}) => ({
  env: {},
  resolveFeature: () => 'master',
  resolveRepo: () => 'agentharness',
  resolveFeatureForDir: (dir) => {
    for (const [needle, branch] of Object.entries(mapping)) {
      if (dir.includes(needle)) return branch;
    }
    return 'master';
  },
  transcriptPath: null,
  ...over,
});

test('edit into a worktree path re-attributes the task and its phases', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-wt-1';
    const o = wtOpts({ '/wt/feat-x': 'feat-x' });
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/repo', prompt: 'p' }, db, o);
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/repo', toolName: 'edit', toolArgs: { path: '/wt/feat-x/src/a.js' } }, db, o);

    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'feat-x');
    const phases = db.all('SELECT feature FROM phases WHERE task_id=?', [task.task_id]);
    assert.ok(phases.length >= 1);
    for (const ph of phases) assert.equal(ph.feature, 'feat-x');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('bash `cd` into a worktree re-attributes the branch', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-wt-2';
    const o = wtOpts({ '/wt/feat-y': 'feat-y' });
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/repo', prompt: 'p' }, db, o);
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/repo', toolName: 'bash', toolArgs: { command: 'cd /wt/feat-y && npm test' } }, db, o);

    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'feat-y');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('a read (view) in another branch does not move the feature', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-wt-3';
    const o = wtOpts({ '/wt/feat-z': 'feat-z' });
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/repo', prompt: 'p' }, db, o);
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/repo', toolName: 'view', toolArgs: { path: '/wt/feat-z/a.js' } }, db, o);

    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'master');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('attribution is sticky: a later write back in the session branch does not flip it', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-wt-4';
    const o = wtOpts({ '/wt/feat-x': 'feat-x' });
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/repo', prompt: 'p' }, db, o);
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/repo', toolName: 'edit', toolArgs: { path: '/wt/feat-x/src/a.js' } }, db, o);
    // later, bump a submodule pointer back in the master checkout
    handle('preToolUse', { sessionId: sid, timestamp: 200, cwd: '/repo', toolName: 'edit', toolArgs: { path: '/repo/sub' } }, db, o);

    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'feat-x');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('writing in the session branch never changes the feature', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-wt-5';
    const o = wtOpts({}); // everything resolves to 'master'
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/repo', prompt: 'p' }, db, o);
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/repo', toolName: 'edit', toolArgs: { path: '/repo/src/a.js' } }, db, o);

    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'master');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// End-to-end with the REAL default resolver (no injection) against a real git
// worktree. Proves the branch is resolved even for a not-yet-created file/dir
// inside the worktree (the resolver climbs to the nearest existing ancestor).
test('real worktree: editing a new file under a worktree re-attributes the branch', () => {
  const { db, path } = freshDb();
  const root = mkdtempSync(join(tmpdir(), 'sp-wt-'));
  const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '-b', 'master', repo]);
    git(repo, ['config', 'user.email', 't@t']);
    git(repo, ['config', 'user.name', 't']);
    writeFileSync(join(repo, 'f'), 'a');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-qm', 'init']);
    const wt = join(root, 'wt-featx');
    git(repo, ['worktree', 'add', '-q', wt, '-b', 'feat-x']);

    const sid = 's-wt-real';
    const o = { env: {} }; // default resolvers => real git
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: repo }, db, o);
    assert.equal(db.get('SELECT branch FROM sessions WHERE session_id=?', [sid]).branch, 'master');
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: repo, prompt: 'p' }, db, o);
    // src/ does not exist yet in the worktree — resolver must climb to wt root.
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: repo, toolName: 'edit', toolArgs: { path: join(wt, 'src', 'a.js') } }, db, o);

    const task = db.get('SELECT feature FROM tasks WHERE session_id=?', [sid]);
    assert.equal(task.feature, 'feat-x');
  } finally {
    db.close();
    rmSync(path, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('args-hash matching survives same-args duplicate (approx, no crash)', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-8';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    handle('preToolUse', { sessionId: sid, timestamp: 100, cwd: '/x', toolName: 'bash', toolArgs: { command: 'ls' } }, db, opts());
    handle('preToolUse', { sessionId: sid, timestamp: 120, cwd: '/x', toolName: 'bash', toolArgs: { command: 'ls' } }, db, opts());
    handle('postToolUse', { sessionId: sid, timestamp: 200, toolName: 'bash', toolArgs: { command: 'ls' } }, db, opts());
    handle('postToolUse', { sessionId: sid, timestamp: 260, toolName: 'bash', toolArgs: { command: 'ls' } }, db, opts());
    const spans = db.all("SELECT * FROM spans WHERE name='bash' ORDER BY started_at", []);
    assert.equal(spans.length, 2);
    // both closed, both durations non-negative (exact pairing is approximate)
    for (const sp of spans) {
      assert.notEqual(sp.ended_at, null);
      assert.ok(sp.duration_ms >= 0);
    }
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: GitHub Copilot CLI delivers Claude-compatible hook payloads to a
// plugin's hooks.json in snake_case (`session_id`, `tool_name`, `tool_input`,
// `transcript_path`, `agent_name`, `stop_reason`) with an ISO-8601 string
// `timestamp`, not the camelCase shape the handlers historically read. Captured
// from CLI 1.0.60 with a payload-logging tracker. Before normalization,
// `p.toolName` was undefined, so the span INSERT threw ("cannot be bound to
// SQLite parameter 5") and every skill phase / tool span / worktree
// re-attribution was silently dropped (fail-open swallowed the error).
test('real plugin payloads (snake_case + ISO timestamp) record skill phase and span', () => {
  const { db, path } = freshDb();
  try {
    const s = 'e75fd03a';
    handle('sessionStart', { hook_event_name: 'SessionStart', session_id: s, timestamp: '2026-06-09T20:18:40.609Z', cwd: '/x', source: 'new' }, db, opts());
    handle('userPromptSubmitted', { hook_event_name: 'UserPromptSubmit', session_id: s, timestamp: '2026-06-09T20:18:40.521Z', cwd: '/x', prompt: 'Invoke the using-superpowers skill.' }, db, opts());

    const task = db.get('SELECT * FROM tasks WHERE session_id=?', [s]);
    assert.equal(task.prompt_excerpt, 'Invoke the using-superpowers skill.');
    assert.equal(task.feature, 'feat-x');

    handle('preToolUse', { hook_event_name: 'PreToolUse', session_id: s, timestamp: '2026-06-09T20:18:45.005Z', cwd: '/x', tool_name: 'skill', tool_input: { skill: 'using-superpowers' } }, db, opts());
    const ph = db.get("SELECT * FROM phases WHERE session_id=? AND skill='using-superpowers'", [s]);
    assert.ok(ph, 'skill phase should be opened from tool_input.skill');
    assert.equal(ph.kind, 'skill');
    assert.equal(ph.status, 'active');

    const span = db.get("SELECT * FROM spans WHERE session_id=? AND name='skill'", [s]);
    assert.ok(span, 'a span must be recorded for the skill tool');
    assert.equal(span.detail, 'using-superpowers');
    assert.equal(span.phase_id, ph.phase_id);
    // ISO timestamp parsed to epoch ms, not wall-clock fallback.
    assert.equal(span.started_at, Date.parse('2026-06-09T20:18:45.005Z'));

    handle('postToolUse', { hook_event_name: 'PostToolUse', session_id: s, timestamp: '2026-06-09T20:18:45.081Z', cwd: '/x', tool_name: 'skill', tool_input: { skill: 'using-superpowers' } }, db, opts());
    const closed = db.get("SELECT * FROM spans WHERE session_id=? AND name='skill'", [s]);
    assert.equal(closed.success, 1);
    assert.notEqual(closed.ended_at, null);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: the SubagentStop payload is snake_case (`agent_name`,
// `stop_reason`) while subagentStart is Copilot-native camelCase. The stop
// handler matches the running subagent by name, so without normalization
// `p.agentName` was undefined and the subagent never got marked stopped.
test('real subagent payloads: camelCase start + snake_case stop pair correctly', () => {
  const { db, path } = freshDb();
  try {
    const s = 'sub-real';
    handle('sessionStart', { sessionId: s, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: s, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    // subagentStart arrives camelCase with a numeric timestamp.
    handle('subagentStart', { sessionId: s, timestamp: 100, cwd: '/x', agentName: 'explore', agentDisplayName: 'Explore Agent', agentDescription: 'desc', transcriptPath: '/t.jsonl' }, db, opts());
    let sub = db.get('SELECT * FROM subagents WHERE session_id=?', [s]);
    assert.equal(sub.agent_name, 'explore');
    assert.equal(sub.status, 'running');
    // subagentStop arrives snake_case with an ISO timestamp.
    handle('subagentStop', { hook_event_name: 'SubagentStop', session_id: s, timestamp: '2026-06-09T20:19:01.317Z', cwd: '/x', agent_name: 'explore', agent_display_name: 'Explore Agent', stop_reason: 'end_turn' }, db, opts());
    sub = db.get('SELECT * FROM subagents WHERE session_id=?', [s]);
    assert.equal(sub.status, 'stopped');
    assert.equal(sub.stop_reason, 'end_turn');
    assert.equal(sub.duration_reliable, 1);
    assert.equal(sub.duration_ms, Date.parse('2026-06-09T20:19:01.317Z') - 100);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: worktree branch re-attribution reads `path`/`command` out of the
// tool input. With snake_case `tool_input` unread, detection never fired and a
// worktree task stayed mis-attributed to the session branch.
test('real plugin payload: edit path in tool_input re-attributes worktree branch', () => {
  const { db, path } = freshDb();
  try {
    const s = 'wt-real';
    const o = wtOpts({ '/wt/feat-x': 'feat-x' });
    handle('sessionStart', { hook_event_name: 'SessionStart', session_id: s, timestamp: '2026-06-09T20:18:40.000Z', cwd: '/repo' }, db, o);
    handle('userPromptSubmitted', { hook_event_name: 'UserPromptSubmit', session_id: s, timestamp: '2026-06-09T20:18:41.000Z', cwd: '/repo', prompt: 'p' }, db, o);
    handle('preToolUse', { hook_event_name: 'PreToolUse', session_id: s, timestamp: '2026-06-09T20:18:42.000Z', cwd: '/repo', tool_name: 'edit', tool_input: { path: '/wt/feat-x/src/a.js' } }, db, o);
    const task = db.get('SELECT feature FROM tasks WHERE session_id=?', [s]);
    assert.equal(task.feature, 'feat-x');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: in kick-off-style sessions the CLI fires userPromptSubmitted
// *before* sessionStart (the session is created by the prompt itself).
// sessionStart was closing the phase opened by userPromptSubmitted and never
// reopening one, so all AIU snapshots captured between sessionStart and
// sessionEnd were silently dropped (aiu_delta=0 despite real usage).
test('late sessionStart reopens root phase so AIU is not dropped', () => {
  const { db, path } = freshDb();
  try {
    const s = 'kickoff-1';
    const T0 = 1_781_068_558_565;

    // userPromptSubmitted fires first — opens task + root phase.
    handle('userPromptSubmitted', { sessionId: s, timestamp: T0, cwd: '/x', prompt: 'Do the thing' }, db, opts());
    const phase0 = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [s]);
    assert.ok(phase0, 'root phase should exist after userPromptSubmitted');
    assert.equal(phase0.status, 'active');

    // sessionStart arrives 2 s later (late delivery).
    const T1 = T0 + 2000;
    handle('sessionStart', { sessionId: s, timestamp: T1, cwd: '/x' }, db, opts());

    // The original phase should be closed.
    const closed = db.get('SELECT status FROM phases WHERE phase_id=?', [phase0.phase_id]);
    assert.equal(closed.status, 'closed');

    // A new root phase must be open so subsequent usage is attributed.
    const phase1 = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root' AND status='active'", [s]);
    assert.ok(phase1, 'a new root phase must be active after late sessionStart');
    assert.equal(phase1.started_at, T1);

    // The task must still be active.
    const task = db.get('SELECT * FROM tasks WHERE session_id=? AND ended_at IS NULL', [s]);
    assert.ok(task, 'task must remain active');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: when a parent session launches a subagent whose transcriptPath
// encodes the child session ID (Copilot CLI convention:
//   ~/.copilot/session-state/{session-id}/events.jsonl),
// the child session ID must be extracted and stored in subagents.child_session_id
// immediately at subagentStart time.  Without this link the parent session sees
// 0 AIC because the parent's phase only queries its own usage_snapshots.
test('subagent child_session_id extracted from transcript path at subagentStart', () => {
  const { db, path } = freshDb();
  try {
    const parent = 'parent-1';
    const child = 'child-abc-123';
    const childTranscript = `/home/user/.copilot/session-state/${child}/events.jsonl`;

    handle('sessionStart', { sessionId: parent, timestamp: 1000, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: parent, timestamp: 1100, cwd: '/x', prompt: 'Do a big task' }, db, opts());
    handle('subagentStart', {
      sessionId: parent, timestamp: 1200, cwd: '/x',
      agentName: 'general-purpose', agentDescription: 'Build the feature',
      transcriptPath: childTranscript,
    }, db, opts());

    const sub = db.get("SELECT child_session_id FROM subagents WHERE session_id=? AND agent_name='general-purpose'", [parent]);
    assert.equal(sub.child_session_id, child, 'child_session_id must be extracted from transcript path immediately');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression: when subagentStart provides a non-standard transcript path (no
// session-state/{id}/ segment), late-binding in sessionStart must fill in the
// child_session_id when the child session registers.
test('subagent child_session_id late-bound when transcript path is non-standard', () => {
  const { db, path } = freshDb();
  try {
    const parent = 'parent-lb';
    const child = 'child-lb';
    const sharedTranscript = '/tmp/custom-path/events.jsonl'; // no session-state/ segment

    handle('sessionStart', { sessionId: parent, timestamp: 1000, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: parent, timestamp: 1100, cwd: '/x', prompt: 'p' }, db, opts());
    handle('subagentStart', {
      sessionId: parent, timestamp: 1200, cwd: '/x',
      agentName: 'explore', transcriptPath: sharedTranscript,
    }, db, opts());

    // child_session_id not yet set (path does not encode it).
    let sub = db.get("SELECT child_session_id FROM subagents WHERE session_id=?", [parent]);
    assert.equal(sub.child_session_id, null, 'no child_session_id before child registers');

    // Child registers with the same transcriptPath -> late-bind fires.
    handle('sessionStart', { sessionId: child, timestamp: 1210, cwd: '/x', transcriptPath: sharedTranscript }, db, opts());
    sub = db.get("SELECT child_session_id FROM subagents WHERE session_id=?", [parent]);
    assert.equal(sub.child_session_id, child, 'child_session_id filled in by late-binding in sessionStart');
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// End-to-end regression: parent session shows 0 AIC while the subagent's real
// usage lands in a separate child session.  After the fix, the parent's phase
// aiu_delta must include the child session's contribution.
test('e2e: parent phase aiu_delta includes child session snapshots (0 AIC bug)', () => {
  const { db, path } = freshDb();
  try {
    const parent = 'e2e-parent';
    const child = 'e2e-child';
    const childTranscript = `/home/user/.copilot/session-state/${child}/events.jsonl`;

    // Parent session: does very little work itself.
    handle('sessionStart', { sessionId: parent, timestamp: 1000, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: parent, timestamp: 1100, cwd: '/x', prompt: 'Build the whole thing' }, db, opts());
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [parent, 1150, 0.1, 0, 0.01]);

    // Parent launches subagent.
    handle('subagentStart', {
      sessionId: parent, timestamp: 1200, cwd: '/x',
      agentName: 'general-purpose', agentDescription: 'Build the feature',
      transcriptPath: childTranscript,
    }, db, opts());

    // Child session (separate Copilot CLI process, same DB).
    handle('sessionStart', { sessionId: child, timestamp: 1210, cwd: '/x', transcriptPath: childTranscript }, db, opts());
    handle('userPromptSubmitted', { sessionId: child, timestamp: 1220, cwd: '/x', prompt: '...' }, db, opts());
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [child, 1400, 3.0, 4, 0.30]);
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [child, 1600, 6.0, 8, 0.60]);
    handle('sessionEnd', { sessionId: child, timestamp: 1700, cwd: '/x' }, db, opts());

    // Parent wraps up.
    handle('subagentStop', { session_id: parent, timestamp: 1750, agent_name: 'general-purpose', stop_reason: 'end_turn' }, db, opts());
    handle('sessionEnd', { sessionId: parent, timestamp: 1800, cwd: '/x' }, db, opts());

    const parentPhase = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [parent]);
    assert.equal(parentPhase.status, 'closed');

    // Before fix: aiu_delta ~= 0.1 (only parent's own snapshot delta).
    // After fix:  aiu_delta ~= 0.1 + 6.0 = 6.1 (parent + child).
    assert.ok(parentPhase.aiu_delta != null, 'aiu_delta must not be null');
    assert.ok(parentPhase.aiu_delta > 1.0,
      `parent aiu_delta should include child usage (>1) but got ${parentPhase.aiu_delta}`);
    assert.ok(Math.abs(parentPhase.aiu_delta - 6.1) < 0.01,
      `expected ~6.1 (parent 0.1 + child 6.0) but got ${parentPhase.aiu_delta}`);
    assert.equal(parentPhase.premium_delta, 8);
    assert.ok(Math.abs(parentPhase.cost_delta - 0.61) < 0.001);

    // Child's own phase still records its contribution independently.
    const childPhase = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [child]);
    assert.equal(childPhase.status, 'closed');
    assert.ok(Math.abs(childPhase.aiu_delta - 6.0) < 0.01,
      `child aiu_delta should be its own total (6.0) but got ${childPhase.aiu_delta}`);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

// Regression (write-path double-count): an in-process `task`-tool subagent
// self-links — its subagents.child_session_id == the parent's own session_id.
// finalizePhaseUsage rolls child-session snapshot deltas into the phase, so a
// self-link re-adds the parent's OWN delta once per self-linked row (and once
// more per duplicate row), inflating the stored phase aiu_delta. The phase delta
// must equal the parent's own snapshot-window delta, with self-links/dupes
// excluded, so tree/skill/task totals are not inflated.
test('e2e: self-linked subagents do not inflate parent phase aiu_delta (write-path)', () => {
  const { db, path } = freshDb();
  try {
    const parent = 'selflink-parent';
    handle('sessionStart', { sessionId: parent, timestamp: 1000, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: parent, timestamp: 1100, cwd: '/x', prompt: 'Do work via subagents' }, db, opts());

    // Parent's own cumulative snapshots climb by 8.0 AIC across the phase.
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [parent, 1050, 2.0, 1, 0.20]);
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [parent, 1700, 10.0, 5, 1.00]);

    const phase = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [parent]);
    // Three self-linked subagent rows (in-process subagents + a duplicate row),
    // all pointing at the parent itself.
    db.run("INSERT INTO subagents (subagent_id, session_id, phase_id, agent_name, child_session_id, started_at, status) VALUES ('s-a','" + parent + "','" + phase.phase_id + "','explore','" + parent + "',1200,'stopped')");
    db.run("INSERT INTO subagents (subagent_id, session_id, phase_id, agent_name, child_session_id, started_at, status) VALUES ('s-b','" + parent + "','" + phase.phase_id + "','general-purpose','" + parent + "',1300,'stopped')");
    db.run("INSERT INTO subagents (subagent_id, session_id, phase_id, agent_name, child_session_id, started_at, status) VALUES ('s-b-dup','" + parent + "','" + phase.phase_id + "','general-purpose','" + parent + "',1300,'stopped')");

    handle('sessionEnd', { sessionId: parent, timestamp: 1800, cwd: '/x' }, db, opts());

    const parentPhase = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [parent]);
    assert.equal(parentPhase.status, 'closed');
    // Own snapshot-window delta is 8.0 (10.0 - 2.0). Self-links/dupes must NOT add.
    assert.ok(Math.abs(parentPhase.aiu_delta - 8.0) < 0.01,
      `parent aiu_delta should be 8.0 (own delta, self-links excluded) but got ${parentPhase.aiu_delta}`);
    assert.ok(Math.abs(parentPhase.premium_delta - 4) < 0.01,
      `premium_delta should be 4 (own) but got ${parentPhase.premium_delta}`);
    assert.ok(Math.abs(parentPhase.cost_delta - 0.80) < 0.001,
      `cost_delta should be 0.80 (own) but got ${parentPhase.cost_delta}`);
  } finally { db.close(); rmSync(path, { force: true }); }
});

// Scenario 2: copilot launched via bash tool.
// When the parent runs `copilot ...` via the bash tool, no subagentStart fires.
// The bash span must be tagged detail='copilot-cli' and, when the child session
// registers, a synthetic subagent record must be created so the AIC rolls up.
test('bash command invoking copilot tags span detail=copilot-cli', () => {
  const { db, path } = freshDb();
  try {
    const s = 'bash-tag';
    handle('sessionStart', { sessionId: s, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: s, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    handle('preToolUse', { sessionId: s, timestamp: 100, toolName: 'bash', toolArgs: { command: 'copilot --acp --model claude-sonnet' } }, db, opts());
    const span = db.get("SELECT detail FROM spans WHERE session_id=? AND name='bash'", [s]);
    assert.equal(span.detail, 'copilot-cli', 'bash span invoking copilot must be tagged copilot-cli');
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('bash copilot tag: non-copilot commands are not tagged', () => {
  const { db, path } = freshDb();
  try {
    const s = 'bash-no-tag';
    handle('sessionStart', { sessionId: s, timestamp: 0, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: s, timestamp: 10, cwd: '/x', prompt: 'p' }, db, opts());
    handle('preToolUse', { sessionId: s, timestamp: 100, toolName: 'bash', toolArgs: { command: 'echo "github copilot is great"' } }, db, opts());
    handle('preToolUse', { sessionId: s, timestamp: 110, toolName: 'bash', toolArgs: { command: 'npm install @github/copilot-language-server' } }, db, opts());
    const spans = db.all("SELECT detail FROM spans WHERE session_id=? AND name='bash'", [s]);
    assert.ok(spans.every((sp) => sp.detail !== 'copilot-cli'), 'non-copilot bash must not be tagged');
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('e2e: bash-spawned copilot auto-links child session to parent for AIC rollup', () => {
  const { db, path } = freshDb();
  try {
    const parent = 'bash-parent';
    const child = 'bash-child';

    // Parent fires preToolUse for a bash command that invokes copilot.
    handle('sessionStart', { sessionId: parent, timestamp: 1000, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: parent, timestamp: 1100, cwd: '/x', prompt: 'Run copilot' }, db, opts());
    handle('preToolUse', {
      sessionId: parent, timestamp: 1200, toolName: 'bash',
      toolArgs: { command: 'copilot --acp --model claude-opus' },
    }, db, opts());

    // Verify the bash span is tagged.
    const bashSpan = db.get("SELECT * FROM spans WHERE session_id=? AND name='bash'", [parent]);
    assert.equal(bashSpan.detail, 'copilot-cli');

    // Parent does a tiny bit of its own work.
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [parent, 1150, 0.05, 0, 0.00]);

    // Child Copilot CLI starts (inherits env, creates own session) — one open
    // copilot-cli bash span exists, so auto-link fires.
    handle('sessionStart', { sessionId: child, timestamp: 1210, cwd: '/x' }, db, opts());

    // A synthetic subagent must be created linking parent -> child.
    const sub = db.get("SELECT * FROM subagents WHERE session_id=? AND child_session_id=?", [parent, child]);
    assert.ok(sub, 'synthetic subagent must be created linking parent to bash-spawned child');
    assert.equal(sub.agent_name, 'copilot-bash');
    assert.equal(sub.child_session_id, child);

    // Child does real work.
    handle('userPromptSubmitted', { sessionId: child, timestamp: 1220, cwd: '/x', prompt: '...' }, db, opts());
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
      [child, 1500, 5.0, 6, 0.50]);
    handle('sessionEnd', { sessionId: child, timestamp: 1600, cwd: '/x' }, db, opts());

    // Bash span closes, parent ends.
    handle('postToolUse', { sessionId: parent, timestamp: 1610, toolName: 'bash', toolArgs: { command: 'copilot --acp --model claude-opus' } }, db, opts());
    handle('sessionEnd', { sessionId: parent, timestamp: 1800, cwd: '/x' }, db, opts());

    // Parent's root phase must include child's 5.0 AIC.
    const parentPhase = db.get("SELECT * FROM phases WHERE session_id=? AND kind='root'", [parent]);
    assert.equal(parentPhase.status, 'closed');
    assert.ok(parentPhase.aiu_delta > 1.0,
      `parent aiu_delta should include child usage but got ${parentPhase.aiu_delta}`);
    assert.ok(Math.abs(parentPhase.aiu_delta - 5.05) < 0.01,
      `expected ~5.05 (0.05 own + 5.0 child) but got ${parentPhase.aiu_delta}`);
  } finally { db.close(); rmSync(path, { force: true }); }
});

// --- readShutdownSnapshot ---

test('readShutdownSnapshot: parses session.shutdown event from events.jsonl', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sp-shutdown-'));
  const f = join(dir, 'events.jsonl');
  try {
    const shutdown = {
      type: 'session.shutdown',
      data: {
        totalNanoAiu: 4072830000,
        totalPremiumRequests: 0.33,
        modelMetrics: {
          'claude-haiku-4.5': { requests: { count: 2, cost: 0.042 }, usage: {} },
        },
      },
    };
    writeFileSync(f, JSON.stringify({ type: 'session.start', data: {} }) + '\n'
      + JSON.stringify(shutdown) + '\n');

    const snap = readShutdownSnapshot(f, 'sess-1', 9999);
    assert.ok(snap, 'snap must not be null');
    assert.equal(snap.session_id, 'sess-1');
    assert.equal(snap.captured_at, 9999);
    assert.ok(Math.abs(snap.aiu - 4.07283) < 0.0001, `aiu should be ~4.07 but got ${snap.aiu}`);
    assert.equal(snap.premium_requests, 0.33);
    assert.ok(Math.abs(snap.cost_total - 0.042) < 0.0001, `cost_total should be 0.042 but got ${snap.cost_total}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readShutdownSnapshot: returns null when file missing', () => {
  assert.equal(readShutdownSnapshot('/no/such/path.jsonl', 's', 100), null);
});

test('readShutdownSnapshot: returns null when no session.shutdown event', () => {
  const f = join(tmpdir(), `sp-noshutdown-${randomUUID()}.jsonl`);
  try {
    writeFileSync(f, JSON.stringify({ type: 'session.start', data: {} }) + '\n');
    assert.equal(readShutdownSnapshot(f, 's', 100), null);
  } finally { rmSync(f, { force: true }); }
});
