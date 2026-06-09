import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { openDb, nowMs, genId } from '../db.js';

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
