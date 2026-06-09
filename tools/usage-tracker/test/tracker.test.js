import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../db.js';
import { handle } from '../tracker.js';

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
