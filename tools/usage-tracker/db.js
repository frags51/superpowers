// SQLite helper for the usage tracker.
// Prefers node:sqlite; falls back to the sqlite3 CLI when unavailable.
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, 'schema.sql');
const SCHEMA_VERSION = '1';
const requireCjs = createRequire(import.meta.url);

export const nowMs = () => Date.now();
export const genId = () => randomUUID();

function loadNodeSqlite() {
  try {
    return requireCjs('node:sqlite');
  } catch {
    return null;
  }
}

class NodeSqliteDb {
  constructor(path) {
    const { DatabaseSync } = requireCjs('node:sqlite');
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
  }
  run(sql, params = []) { this.db.prepare(sql).run(...params); }
  get(sql, params = []) { return this.db.prepare(sql).get(...params); }
  all(sql, params = []) { return this.db.prepare(sql).all(...params); }
  close() { try { this.db.close(); } catch { /* ignore */ } }
}

class Sqlite3CliDb {
  constructor(path) {
    this.path = path;
    this._exec(readFileSync(SCHEMA_PATH, 'utf8'));
    this.run("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
  }
  _quote(v) {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return "'" + String(v).replace(/'/g, "''") + "'";
  }
  _bind(sql, params) {
    let i = 0;
    return sql.replace(/\?/g, () => this._quote(params[i++]));
  }
  _exec(sql) {
    execFileSync('sqlite3', [this.path, sql], { encoding: 'utf8' });
  }
  _query(sql) {
    const out = execFileSync('sqlite3', ['-json', this.path, sql], { encoding: 'utf8' }).trim();
    return out ? JSON.parse(out) : [];
  }
  run(sql, params = []) { this._exec(this._bind(sql, params)); }
  get(sql, params = []) { const r = this._query(this._bind(sql, params)); return r[0]; }
  all(sql, params = []) { return this._query(this._bind(sql, params)); }
  close() { /* CLI is stateless */ }
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = loadNodeSqlite();
  if (sqlite) return new NodeSqliteDb(path);
  return new Sqlite3CliDb(path);
}

export function defaultDbPath(env = process.env) {
  if (env.SUPERPOWERS_USAGE_DB) return env.SUPERPOWERS_USAGE_DB;
  const home = env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || '.', '.copilot');
  return join(home, 'plugin-data', 'superpowers-usage', 'usage.db');
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}
export const gitBranch = (cwd) => git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
export const gitRepo = (cwd) => {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  return top ? top.split('/').pop() : null;
};
