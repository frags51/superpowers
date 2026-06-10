import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openDb, nowMs, genId, defaultSessionStorePath, loadSessionTitles } from '../db.js';

const requireCjs = createRequire(import.meta.url);

// Seed a Copilot-style session-store.db (its `sessions` table has an `id` PK
// and an LLM-generated `summary`, unlike the tracker's own `sessions` table).
function seedSessionStore(rows) {
  const path = join(tmpdir(), `sp-store-${genId()}.db`);
  const { DatabaseSync } = requireCjs('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT)');
  const ins = db.prepare('INSERT INTO sessions (id, summary) VALUES (?, ?)');
  for (const [id, summary] of rows) ins.run(id, summary);
  db.close();
  return path;
}

test('openDb creates schema and supports run/get/all', () => {
  const path = join(tmpdir(), `sp-db-${genId()}.db`);
  const db = openDb(path);
  try {
    db.run('INSERT INTO sessions (session_id, started_at) VALUES (?, ?)', ['s1', 123]);
    const row = db.get('SELECT session_id, started_at FROM sessions WHERE session_id = ?', ['s1']);
    assert.equal(row.session_id, 's1');
    assert.equal(row.started_at, 123);
    const all = db.all('SELECT session_id FROM sessions');
    assert.equal(all.length, 1);
    const v = db.get("SELECT value FROM meta WHERE key = 'schema_version'");
    assert.ok(v && v.value);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test('nowMs and genId behave', () => {
  assert.ok(nowMs() > 0);
  assert.notEqual(genId(), genId());
});

test('defaultSessionStorePath honors COPILOT_HOME, then USERPROFILE/HOME', () => {
  assert.equal(
    defaultSessionStorePath({ COPILOT_HOME: '/cfg' }),
    join('/cfg', 'session-store.db'));
  assert.equal(
    defaultSessionStorePath({ HOME: '/home/u' }),
    join('/home/u', '.copilot', 'session-store.db'));
  assert.equal(
    defaultSessionStorePath({ USERPROFILE: 'C:\\Users\\u' }),
    join('C:\\Users\\u', '.copilot', 'session-store.db'));
});

test('loadSessionTitles maps session id -> summary', () => {
  const path = seedSessionStore([
    ['s1', 'Extract Details from Copilot Session'],
    ['s2', 'Analyze Usage Tracking Resilience'],
    ['s3', null],
    ['s4', ''],
  ]);
  try {
    const titles = loadSessionTitles(path);
    assert.equal(titles.s1, 'Extract Details from Copilot Session');
    assert.equal(titles.s2, 'Analyze Usage Tracking Resilience');
    assert.ok(!('s3' in titles), 'null summary omitted');
    assert.ok(!('s4' in titles), 'empty summary omitted');
  } finally {
    rmSync(path, { force: true });
  }
});

test('loadSessionTitles fails open to {} when the store is missing or unreadable', () => {
  assert.deepEqual(loadSessionTitles(join(tmpdir(), `sp-missing-${genId()}.db`)), {});
  assert.deepEqual(loadSessionTitles(null), {});
});
