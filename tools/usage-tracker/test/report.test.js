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
  db.run("INSERT INTO spans (span_id, phase_id, session_id, kind, name, duration_ms) VALUES ('x1','p1','s1','tool','grep',100)");
  db.run("INSERT INTO spans (span_id, phase_id, session_id, kind, name, duration_ms) VALUES ('x2','p1','s1','tool','grep',300)");
  db.run("INSERT INTO spans (span_id, phase_id, session_id, kind, name, duration_ms) VALUES ('x3','p2','s1','tool','view',50)");
  // subagents
  db.run("INSERT INTO subagents (subagent_id, session_id, agent_name, status, duration_ms, duration_reliable) VALUES ('a1','s1','explore','stopped',1500,1)");
  db.run("INSERT INTO subagents (subagent_id, session_id, agent_name, status, duration_ms, duration_reliable) VALUES ('a2','s1','explore','running',NULL,0)");
  return { db, path };
}

test('buildReport totals', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    assert.equal(r.totals.sessions, 2);
    assert.equal(r.totals.phases, 3);
    assert.equal(r.totals.durationMs, 10000);
    assert.equal(Math.round(r.totals.aiu * 100), 35); // 0.10+0.20+0.05
    assert.equal(r.totals.tokens, 170);
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

test('buildReport tools aggregates count + durations', () => {
  const { db, path } = seed();
  try {
    const r = buildReport(db);
    const grep = r.tools.find((t) => t.name === 'grep');
    assert.equal(grep.count, 2);
    assert.equal(grep.totalMs, 400);
    assert.equal(grep.avgMs, 200);
    assert.equal(grep.maxMs, 300);
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
  } finally { db.close(); rmSync(path, { force: true }); }
});
