import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../db.js';
import { buildReport } from '../report.js';

function seed() {
  const path = join(tmpdir(), `sp-report-${randomUUID()}.db`);
  const db = openDb(path);
  db.run("INSERT INTO sessions (session_id, repo, branch, started_at) VALUES ('s1','agentharness','feat-a',1000)");
  db.run("INSERT INTO sessions (session_id, repo, branch, started_at) VALUES ('s2','agentharness','feat-b',2000)");
  db.run("INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES ('s1:0','s1','feat-a',0,1000)");
  // phases: feat-a/brainstorming, feat-a/writing-plans, feat-b/brainstorming
  db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES ('p1','s1:0','s1','feat-a','brainstorming','skill',1,5000,0.10,100,'closed')");
  db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES ('p2','s1:0','s1','feat-a','writing-plans','skill',2,3000,0.20,50,'closed')");
  db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES ('p3','s1:0','s2','feat-b','brainstorming','skill',1,2000,0.05,20,'closed')");
  // spans (tools)
  db.run("INSERT INTO spans (span_id, phase_id, session_id, kind, name, duration_ms, success) VALUES ('x1','p1','s1','tool','grep',100,1)");
  db.run("INSERT INTO spans (span_id, phase_id, session_id, kind, name, duration_ms, success) VALUES ('x2','p1','s1','tool','grep',300,0)");
  db.run("INSERT INTO spans (span_id, phase_id, session_id, kind, name, duration_ms, success) VALUES ('x3','p2','s1','tool','view',50,1)");
  // subagents
  db.run("INSERT INTO subagents (subagent_id, session_id, agent_name, status, duration_ms, duration_reliable) VALUES ('a1','s1','explore','stopped',1500,1)");
  db.run("INSERT INTO subagents (subagent_id, session_id, agent_name, status, duration_ms, duration_reliable) VALUES ('a2','s1','explore','running',NULL,0)");
  return { db, path };
}

test('buildReport totals', () => {
  const { db, path } = seed();
  try {
    db.run("UPDATE phases SET cost_delta=0.02 WHERE phase_id='p1'");
    db.run("UPDATE phases SET premium_delta=3 WHERE phase_id='p2'");
    const r = buildReport(db);
    assert.equal(r.totals.sessions, 2);
    assert.equal(r.totals.phases, 3);
    assert.equal(r.totals.durationMs, 10000);
    assert.equal(Math.round(r.totals.aiu * 100), 35); // 0.10+0.20+0.05
    assert.equal(r.totals.tokens, 170);
    assert.equal(r.totals.premium, 3);
    assert.equal(Math.round(r.totals.cost * 100), 2); // 0.02
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport tree: repo -> branch -> skill with credits + duration', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    assert.equal(r.tree.length, 1);                 // one repo
    const repo = r.tree[0];
    assert.equal(repo.repo, 'agentharness');
    assert.equal(repo.durationMs, 10000);
    const branches = Object.fromEntries(repo.branches.map((b) => [b.feature, b]));
    assert.equal(branches['feat-a'].durationMs, 8000);
    assert.equal(Math.round(branches['feat-a'].aiu * 100), 30);
    const skillsA = branches['feat-a'].skills.map((s) => s.skill).sort();
    assert.deepEqual(skillsA, ['brainstorming', 'writing-plans']);
    assert.equal(branches['feat-b'].skills[0].skill, 'brainstorming');
    assert.equal(branches['feat-b'].skills[0].durationMs, 2000);
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport sessions: session -> skill with identity + credits + duration', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    assert.equal(r.sessions.length, 2);                 // two sessions
    const byId = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));

    const s1 = byId['s1'];
    assert.equal(s1.repo, 'agentharness');
    assert.equal(s1.branch, 'feat-a');
    assert.equal(s1.durationMs, 8000);                  // p1 (5000) + p2 (3000)
    assert.equal(Math.round(s1.aiu * 100), 30);         // 0.10 + 0.20
    assert.equal(s1.tokens, 150);                       // 100 + 50
    assert.equal(s1.toolCount, 3);                      // grep×2 + view×1
    assert.equal(s1.toolDurationMs, 450);               // 100 + 300 + 50
    assert.equal(s1.subagentCount, 2);                  // explore stopped + running
    assert.equal(s1.subagentRunning, 1);
    const s1skills = s1.skills.map((s) => s.skill).sort();
    assert.deepEqual(s1skills, ['brainstorming', 'writing-plans']);

    const s2 = byId['s2'];
    assert.equal(s2.branch, 'feat-b');
    assert.equal(s2.durationMs, 2000);
    assert.equal(s2.skills[0].skill, 'brainstorming');
    assert.equal(s2.skills[0].durationMs, 2000);
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport tools aggregates count + durations', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    const grep = r.tools.find((t) => t.name === 'grep');
    assert.equal(grep.count, 2);
    assert.equal(grep.totalMs, 400);
    assert.equal(grep.p75Ms, 300);   // nearest-rank of [100,300]
    assert.equal(grep.p95Ms, 300);
    const view = r.tools.find((t) => t.name === 'view');
    assert.equal(view.count, 1);
    assert.equal(view.p75Ms, 50);    // single sample
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport skills (phase analysis) + subagents', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    const brainstorm = r.skills.find((s) => s.skill === 'brainstorming');
    assert.equal(brainstorm.count, 2);            // feat-a + feat-b
    assert.equal(brainstorm.totalMs, 7000);
    const explore = r.subagents.find((s) => s.name === 'explore');
    assert.equal(explore.count, 2);
    assert.equal(explore.running, 1);
    assert.equal(explore.reliable, 1);
    assert.equal(explore.avgMs, 1500);            // reliable-only avg
    assert.equal(explore.totalMs, 1500);          // reliable-only total
    assert.equal(explore.maxMs, 1500);            // reliable-only max
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport sessions: orphan phase (no sessions row) uses placeholders and firstAt sort key', () => {
  const path = join(tmpdir(), `sp-report-${randomUUID()}.db`);
  const db = openDb(path);
  const T0 = 1_000_000_000_000;
  const HOUR = 3_600_000;
  try {
    // s1 has a real sessions row; 'orphan' has phases but no sessions row, and
    // its only activity is more recent than s1's session start.
    db.run(`INSERT INTO sessions (session_id, repo, branch, model, started_at) VALUES ('s1','agentharness','feat-a','claude',${T0})`);
    db.run(`INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, started_at, duration_ms, aiu_delta, total_tokens, status) VALUES ('p1','s1:0','s1','feat-a','brainstorming','skill',1,${T0},5000,0.1,100,'closed')`);
    db.run(`INSERT INTO phases (phase_id, task_id, session_id, skill, kind, seq, started_at, duration_ms, aiu_delta, total_tokens, status) VALUES ('p2','orphan:0','orphan','writing-plans','skill',1,${T0 + 2 * HOUR},3000,0.2,50,'closed')`);

    const r = buildReport(db);
    assert.equal(r.sessions.length, 2);

    // Orphan rolls up under placeholders with no model/start time.
    const orphan = r.sessions.find((s) => s.sessionId === 'orphan');
    assert.equal(orphan.repo, '(unknown repo)');
    assert.equal(orphan.branch, '(no branch)');
    assert.equal(orphan.model, null);
    assert.equal(orphan.startedAt, null);
    assert.equal(orphan.firstAt, T0 + 2 * HOUR);

    // With startedAt null, the orphan sorts by firstAt — most recent first.
    assert.deepEqual(r.sessions.map((s) => s.sessionId), ['orphan', 's1']);
  } finally { db.close(); rmSync(path, { force: true }); }
});

function seedTimed() {
  const path = join(tmpdir(), `sp-report-${randomUUID()}.db`);
  const db = openDb(path);
  const T0 = 1_000_000_000_000; // fixed epoch ms base
  const HOUR = 3_600_000;
  // Two sessions: s1 (older) and s2 (recent), one hour apart.
  db.run(`INSERT INTO sessions (session_id, repo, branch, started_at) VALUES ('s1','agentharness','feat-a',${T0})`);
  db.run(`INSERT INTO sessions (session_id, repo, branch, started_at) VALUES ('s2','agentharness','feat-b',${T0 + HOUR})`);
  db.run(`INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, started_at, duration_ms, aiu_delta, total_tokens, status) VALUES ('p1','s1:0','s1','feat-a','brainstorming','skill',1,${T0},5000,0.1,100,'closed')`);
  db.run(`INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, started_at, duration_ms, aiu_delta, total_tokens, status) VALUES ('p2','s2:0','s2','feat-b','brainstorming','skill',1,${T0 + HOUR},3000,0.2,50,'closed')`);
  db.run(`INSERT INTO spans (span_id, phase_id, session_id, kind, name, started_at, duration_ms) VALUES ('x1','p1','s1','tool','grep',${T0},100)`);
  db.run(`INSERT INTO spans (span_id, phase_id, session_id, kind, name, started_at, duration_ms) VALUES ('x2','p2','s2','tool','grep',${T0 + HOUR},300)`);
  db.run(`INSERT INTO subagents (subagent_id, session_id, agent_name, status, started_at, duration_ms, duration_reliable) VALUES ('a1','s1','explore','stopped',${T0},1500,1)`);
  db.run(`INSERT INTO subagents (subagent_id, session_id, agent_name, status, started_at, duration_ms, duration_reliable) VALUES ('a2','s2','explore','stopped',${T0 + HOUR},2500,1)`);
  return { db, path, T0, HOUR };
}

test('buildReport range filter restricts every section to the window', () => {
  const { db, path, T0, HOUR } = seedTimed();
  try {
    // Window covering only the recent session (s2/feat-b).
    const r = buildReport(db, { from: T0 + HOUR - 1, to: T0 + HOUR + 1 });
    assert.equal(r.totals.sessions, 1);
    assert.equal(r.totals.phases, 1);
    assert.equal(r.totals.durationMs, 3000);
    assert.equal(r.range.from, T0 + HOUR - 1);
    assert.equal(r.range.to, T0 + HOUR + 1);
    assert.equal(r.tree.length, 1);
    assert.equal(r.tree[0].branches.length, 1);
    assert.equal(r.tree[0].branches[0].feature, 'feat-b');
    const grep = r.tools.find((t) => t.name === 'grep');
    assert.equal(grep.count, 1);
    assert.equal(grep.totalMs, 300);
    const brainstorm = r.skills.find((s) => s.skill === 'brainstorming');
    assert.equal(brainstorm.count, 1);
    const explore = r.subagents.find((s) => s.name === 'explore');
    assert.equal(explore.count, 1);
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport sessions sort most-recent-first and honor the range filter', () => {
  const { db, path, T0, HOUR } = seedTimed();
  try {
    const all = buildReport(db);
    assert.deepEqual(all.sessions.map((s) => s.sessionId), ['s2', 's1']); // recent first
    assert.equal(all.sessions[0].startedAt, T0 + HOUR);

    // Window covering only the recent session (s2).
    const r = buildReport(db, { from: T0 + HOUR - 1, to: T0 + HOUR + 1 });
    assert.equal(r.sessions.length, 1);
    assert.equal(r.sessions[0].sessionId, 's2');
    assert.equal(r.sessions[0].durationMs, 3000);
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport exposes first/last start timestamps', () => {
  const { db, path, T0, HOUR } = seedTimed();
  try {
    const r = buildReport(db);
    assert.equal(r.range.from, null);
    assert.equal(r.range.to, null);
    // Repo rolls up the earliest and latest start across its branches.
    assert.equal(r.tree[0].firstAt, T0);
    assert.equal(r.tree[0].lastAt, T0 + HOUR);
    const grep = r.tools.find((t) => t.name === 'grep');
    assert.equal(grep.firstAt, T0);
    assert.equal(grep.lastAt, T0 + HOUR);
    const brainstorm = r.skills.find((s) => s.skill === 'brainstorming');
    assert.equal(brainstorm.firstAt, T0);
    assert.equal(brainstorm.lastAt, T0 + HOUR);
    const explore = r.subagents.find((s) => s.name === 'explore');
    assert.equal(explore.firstAt, T0);
    assert.equal(explore.lastAt, T0 + HOUR);
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport attaches session titles from opts.sessionTitles', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db, { sessionTitles: { s1: 'Wire the credit snapshotter' } });
    const s1 = r.sessions.find((s) => s.sessionId === 's1');
    const s2 = r.sessions.find((s) => s.sessionId === 's2');
    assert.equal(s1.title, 'Wire the credit snapshotter');
    assert.equal(s2.title, null); // no title provided -> null, not undefined
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport leaves title null when no titles are supplied', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    for (const s of r.sessions) assert.equal(s.title, null);
  } finally { db.close(); rmSync(path, { force: true }); }
});
