import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb } from '../db.js';
import { handle } from '../tracker.js';
import { buildReport } from '../report.js';

function freshDb() {
  const path = join(tmpdir(), `sp-breakdown-${randomUUID()}.db`);
  return { db: openDb(path), path };
}
const opts = (over = {}) => ({
  env: {},
  resolveFeature: () => 'feat-x',
  resolveRepo: () => 'agentharness',
  transcriptPath: '/no/file',
  ...over,
});

// End-to-end: drive the tracker hooks the way the Copilot CLI does when an
// agent activates superpowers skills, then confirm the same data shows up in
// the dashboard report. Proves both the DB (phases) and the dashboard
// (repo -> branch -> skill breakdown) agree on what was invoked.
test('invoked skills appear in the breakdown: DB phases and dashboard tree agree', () => {
  const { db, path } = freshDb();
  try {
    const sid = 's-breakdown';
    handle('sessionStart', { sessionId: sid, timestamp: 1000, cwd: '/x' }, db, opts());
    handle('userPromptSubmitted', { sessionId: sid, timestamp: 1100, cwd: '/x', prompt: 'do work' }, db, opts());
    // Two named skills plus one activation with no resolvable name ("unknown").
    handle('preToolUse', { sessionId: sid, timestamp: 1200, cwd: '/x', toolName: 'skill', toolArgs: { skill: 'brainstorming' } }, db, opts());
    handle('preToolUse', { sessionId: sid, timestamp: 1500, cwd: '/x', toolName: 'skill', toolArgs: { skill: 'test-driven-development' } }, db, opts());
    handle('preToolUse', { sessionId: sid, timestamp: 1800, cwd: '/x', toolName: 'skill', toolArgs: {} }, db, opts());
    handle('sessionEnd', { sessionId: sid, timestamp: 2000, cwd: '/x' }, db, opts());

    // DB side: a root phase plus one phase per skill activation.
    const phaseSkills = db.all('SELECT skill, kind FROM phases WHERE session_id=? ORDER BY seq', [sid])
      .map((p) => ({ skill: p.skill, kind: p.kind }));
    assert.deepEqual(phaseSkills, [
      { skill: null, kind: 'root' },
      { skill: 'brainstorming', kind: 'skill' },
      { skill: 'test-driven-development', kind: 'skill' },
      { skill: 'unknown', kind: 'skill' },
    ]);

    // Dashboard side: the repo -> branch -> skill tree exposes every phase, with
    // the null-skill root surfaced as "(root)".
    const r = buildReport(db);
    assert.equal(r.tree.length, 1);
    const repo = r.tree[0];
    assert.equal(repo.repo, 'agentharness');
    assert.equal(repo.branches.length, 1);
    const branch = repo.branches[0];
    assert.equal(branch.feature, 'feat-x');
    const treeSkills = branch.skills.map((s) => s.skill).sort();
    assert.deepEqual(treeSkills, ['(root)', 'brainstorming', 'test-driven-development', 'unknown']);

    // The phase-analysis (Stats) section lists the same skills.
    const statsSkills = r.skills.map((s) => s.skill).sort();
    assert.deepEqual(statsSkills, ['(root)', 'brainstorming', 'test-driven-development', 'unknown']);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
