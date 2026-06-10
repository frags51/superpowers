import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
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

test('buildReport sessions: live snapshot AIC recovers an unfinalized open phase', () => {
  const { db, path } = seed();
  try {
    // s1's writing-plans phase is still OPEN with a NULL aiu_delta (its usage is
    // not finalized yet). Snapshots show the session's cumulative AIC climbing to
    // 0.9 — the session headline should reflect that, not just the closed delta.
    db.run("UPDATE phases SET status='active', aiu_delta=NULL WHERE phase_id='p2'");
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES ('s1', 1500, 0.10)");
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES ('s1', 6000, 0.90)");
    const r = buildReport(db);
    const byId = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));
    // Live AIC = last snapshot (0.90) minus the session's 0 origin.
    assert.equal(Math.round(byId['s1'].aiu * 100), 90);
    // s2 has no snapshots -> falls back to its summed phase delta (0.05).
    assert.equal(Math.round(byId['s2'].aiu * 100), 5);
    // Totals stay consistent with the per-session live values (0.90 + 0.05).
    assert.equal(Math.round(r.totals.aiu * 100), 95);
  } finally { db.close(); rmSync(path, { force: true }); }
});

test('buildReport sessions: snapshot AIC is windowed by the time range', () => {
  const { db, path } = seed();
  try {
    // Put an s1 phase inside the window so the (phase-driven) session list
    // includes s1 for this range.
    db.run("UPDATE phases SET started_at=5000 WHERE phase_id='p1'");
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES ('s1', 1000, 2.0)");
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES ('s1', 5000, 5.0)");
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES ('s1', 9000, 9.0)");
    // Window [4000, 8000]: usage = value at/through 8000 (5.0) minus baseline
    // just before 4000 (2.0) = 3.0.
    const r = buildReport(db, { from: 4000, to: 8000 });
    const s1 = r.sessions.find((s) => s.sessionId === 's1');
    assert.equal(Math.round(s1.aiu * 100), 300);
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

// Regression: parent session shows 0 AIC while the subagent's real usage lands
// in a separate child session.  buildReport must roll child live AIC into the
// parent and exclude child sessions from the headline total to avoid double-counting.
test('buildReport: child session AIC rolls up into parent, headline total not double-counted', () => {
  const path = join(tmpdir(), `sp-report-child-${randomUUID()}.db`);
  const db = openDb(path);
  try {
    // Parent session with a single phase (no own snapshots -> would show 0 AIC).
    db.run("INSERT INTO sessions (session_id, repo, branch, started_at) VALUES ('par','repo','main',1000)");
    db.run("INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES ('par:0','par','main',0,1000)");
    db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES ('pp','par:0','par','main',null,'root',0,5000,0.05,0,'closed')");

    // Child session registered as a subagent of the parent with child_session_id set.
    db.run("INSERT INTO sessions (session_id, repo, branch, started_at) VALUES ('chi','repo','main',1200)");
    db.run("INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES ('chi:0','chi','main',0,1200)");
    db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES ('cp','chi:0','chi','main',null,'root',0,3000,0.0,0,'closed')");
    db.run("INSERT INTO subagents (subagent_id, session_id, phase_id, agent_name, child_session_id, started_at, status) VALUES ('sa1','par','pp','general-purpose','chi',1200,'stopped')");

    // Child has real usage snapshots; parent has none.
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES ('chi', 1400, 4.0, 5, 0.40)");
    db.run("INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES ('chi', 1600, 8.0, 9, 0.80)");

    const r = buildReport(db);
    const byId = Object.fromEntries(r.sessions.map((s) => [s.sessionId, s]));

    // Parent must show child's live AIC (8.0) added to its own phase delta (0.05) -> 8.05.
    assert.ok(Math.abs(byId['par'].aiu - 8.05) < 0.01,
      `parent aiu should be 8.05 (0.05 own + 8.0 child) but got ${byId['par'].aiu}`);
    assert.equal(byId['par'].parentSessionId, null, 'parent has no parentSessionId');

    // Child must carry parentSessionId so the UI can dim/indent it.
    assert.equal(byId['chi'].parentSessionId, 'par', 'child must reference parent');

    // Headline total must NOT double-count: child excluded, total = parent's 8.05.
    assert.ok(Math.abs(r.totals.aiu - 8.05) < 0.01,
      `totals.aiu should be ~8.05 (no double-count) but got ${r.totals.aiu}`);
  } finally { db.close(); rmSync(path, { force: true }); }
});

// Regression: --autopilot / --acp sessions never invoke statusLine, so
// usage_snapshots stays empty and AIC shows 0.  buildReport must reconcile by
// reading session.shutdown from events.jsonl and persisting the snapshot to
// usage.db so future report runs are fast.
test('buildReport: reconciles 0-AIC sessions from session.shutdown in events.jsonl', () => {
  const base = mkdtempSync(join(tmpdir(), 'sp-report-recon-'));
  const sessId = 'autopilot-sess';
  const sessDir = join(base, 'session-state', sessId);
  mkdirSync(sessDir, { recursive: true });
  const transcript = join(sessDir, 'events.jsonl');

  writeFileSync(transcript,
    JSON.stringify({ type: 'session.start', data: {} }) + '\n'
    + JSON.stringify({
      type: 'session.shutdown',
      data: {
        totalNanoAiu: 4_072_830_000,
        totalPremiumRequests: 2,
        modelMetrics: { 'claude-haiku-4.5': { requests: { count: 3, cost: 0.12 }, usage: {} } },
      },
    }) + '\n');

  const path = join(tmpdir(), `sp-report-recon-${randomUUID()}.db`);
  const db = openDb(path);
  try {
    const T0 = 2_000_000;
    db.run("INSERT INTO sessions (session_id, repo, branch, started_at, ended_at) VALUES (?,?,?,?,?)",
      [sessId, 'repo', 'main', T0, T0 + 5000]);
    db.run("INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES (?,?,?,?,?)",
      [`${sessId}:0`, sessId, 'main', 0, T0]);
    db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ['ph1', `${sessId}:0`, sessId, 'main', null, 'root', 0, 5000, null, 0, 'closed']);

    const resolveTranscript = (s) => join(base, 'session-state', s, 'events.jsonl');
    const r = buildReport(db, { resolveTranscript });

    const se = r.sessions.find((s) => s.sessionId === sessId);
    assert.ok(se, 'session must appear in report');
    assert.ok(Math.abs(se.aiu - 4.07283) < 0.001, `aiu should be ~4.07 but got ${se.aiu}`);

    // Snapshot must have been persisted to usage.db for future runs.
    const persisted = db.get('SELECT aiu, premium_requests FROM usage_snapshots WHERE session_id=?', [sessId]);
    assert.ok(persisted, 'snapshot must be written back to usage.db');
    assert.ok(Math.abs(persisted.aiu - 4.07283) < 0.001, `persisted aiu should be ~4.07 but got ${persisted.aiu}`);
    assert.equal(persisted.premium_requests, 2);
  } finally { db.close(); rmSync(path, { force: true }); rmSync(base, { recursive: true, force: true }); }
});

// Reconciliation must skip sessions that already have snapshots (no double-insert).
test('buildReport: reconciliation skips sessions that already have usage_snapshots', () => {
  const base = mkdtempSync(join(tmpdir(), 'sp-report-skip-'));
  const sessId = 'has-snaps-sess';
  const sessDir = join(base, 'session-state', sessId);
  mkdirSync(sessDir, { recursive: true });
  const transcript = join(sessDir, 'events.jsonl');

  // events.jsonl claims 9 AIC — but a real snapshot (6 AIC) already exists.
  writeFileSync(transcript,
    JSON.stringify({ type: 'session.shutdown', data: { totalNanoAiu: 9_000_000_000 } }) + '\n');

  const path = join(tmpdir(), `sp-report-skip-${randomUUID()}.db`);
  const db = openDb(path);
  try {
    const T0 = 1_000_000;
    db.run("INSERT INTO sessions (session_id, repo, branch, started_at, ended_at) VALUES (?,?,?,?,?)",
      [sessId, 'repo', 'main', T0, T0 + 3000]);
    db.run("INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES (?,?,?,?,?)",
      [`${sessId}:0`, sessId, 'main', 0, T0]);
    db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ['ph2', `${sessId}:0`, sessId, 'main', null, 'root', 0, 3000, null, 0, 'closed']);

    // Pre-existing snapshot (statusLine DID fire).
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES (?,?,?)', [sessId, T0 + 2000, 6.0]);

    const resolveTranscript = (s) => join(base, 'session-state', s, 'events.jsonl');
    const r = buildReport(db, { resolveTranscript });

    const se = r.sessions.find((s) => s.sessionId === sessId);
    assert.ok(se, 'session must appear in report');
    // Must use the existing snapshot (6.0), not the shutdown value (9.0).
    assert.ok(Math.abs(se.aiu - 6.0) < 0.001, `aiu should be 6.0 (from existing snap) but got ${se.aiu}`);

    const count = db.get('SELECT COUNT(*) AS cnt FROM usage_snapshots WHERE session_id=?', [sessId]);
    assert.equal(count.cnt, 1, 'no duplicate snapshot inserted');
  } finally { db.close(); rmSync(path, { force: true }); rmSync(base, { recursive: true, force: true }); }
});

// Sessions whose events.jsonl has no session.shutdown (killed/crashed) must get
// a sentinel snapshot so the LEFT JOIN excludes them on future report builds —
// events.jsonl is read at most once per session, ever.
test('buildReport: sentinel written for ended sessions with no session.shutdown', () => {
  const base = mkdtempSync(join(tmpdir(), 'sp-report-sentinel-'));
  const sessId = 'killed-sess';
  const sessDir = join(base, 'session-state', sessId);
  mkdirSync(sessDir, { recursive: true });
  const transcript = join(sessDir, 'events.jsonl');

  // events.jsonl exists but has no session.shutdown (process was killed).
  writeFileSync(transcript, JSON.stringify({ type: 'session.start', data: {} }) + '\n');

  const path = join(tmpdir(), `sp-report-sentinel-${randomUUID()}.db`);
  const db = openDb(path);
  try {
    const T0 = 5_000_000;
    db.run("INSERT INTO sessions (session_id, repo, branch, started_at, ended_at) VALUES (?,?,?,?,?)",
      [sessId, 'repo', 'main', T0, T0 + 3000]);
    db.run("INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES (?,?,?,?,?)",
      [`${sessId}:0`, sessId, 'main', 0, T0]);
    db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, duration_ms, aiu_delta, total_tokens, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ['ph3', `${sessId}:0`, sessId, 'main', null, 'root', 0, 3000, 0.02, 0, 'closed']);

    const resolveTranscript = (s) => join(base, 'session-state', s, 'events.jsonl');
    buildReport(db, { resolveTranscript });

    // A sentinel snapshot (aiu=0) must be written so the next run skips the file.
    const sentinel = db.get('SELECT aiu FROM usage_snapshots WHERE session_id=?', [sessId]);
    assert.ok(sentinel, 'sentinel snapshot must exist');
    assert.equal(sentinel.aiu, 0, 'sentinel aiu must be 0');

    // Second report build must NOT re-read the file (sentinel prevents it).
    // We verify indirectly: the session count in usage_snapshots stays at 1.
    buildReport(db, { resolveTranscript });
    const count = db.get('SELECT COUNT(*) AS cnt FROM usage_snapshots WHERE session_id=?', [sessId]);
    assert.equal(count.cnt, 1, 'sentinel must prevent duplicate reads on subsequent builds');
  } finally { db.close(); rmSync(path, { force: true }); rmSync(base, { recursive: true, force: true }); }
});
