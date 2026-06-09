-- Superpowers usage tracking schema (SQLite). Idempotent.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  cwd        TEXT,
  repo       TEXT,
  branch     TEXT,
  model      TEXT,
  transcript_path TEXT,
  started_at INTEGER,
  ended_at   INTEGER,
  end_reason TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  task_id        TEXT PRIMARY KEY,
  session_id     TEXT,
  feature        TEXT,
  label          TEXT,
  turn_index     INTEGER,
  prompt_excerpt TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,
  duration_ms    INTEGER
);

CREATE TABLE IF NOT EXISTS phases (
  phase_id      TEXT PRIMARY KEY,
  task_id       TEXT,
  session_id    TEXT,
  feature       TEXT,
  skill         TEXT,
  kind          TEXT,
  seq           INTEGER,
  started_at    INTEGER,
  ended_at      INTEGER,
  duration_ms   INTEGER,
  aiu_delta     REAL,
  premium_delta INTEGER,
  cost_delta    REAL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  total_tokens  INTEGER,
  status        TEXT
);

CREATE TABLE IF NOT EXISTS spans (
  span_id      TEXT PRIMARY KEY,
  phase_id     TEXT,
  task_id      TEXT,
  session_id   TEXT,
  kind         TEXT,
  name         TEXT,
  detail       TEXT,
  tool_call_id TEXT,
  started_at   INTEGER,
  ended_at     INTEGER,
  duration_ms  INTEGER,
  success      INTEGER,
  match_key    TEXT
);

CREATE TABLE IF NOT EXISTS subagents (
  subagent_id        TEXT PRIMARY KEY,
  session_id         TEXT,
  task_id            TEXT,
  phase_id           TEXT,
  agent_name         TEXT,
  agent_display_name TEXT,
  description        TEXT,
  transcript_path    TEXT,
  started_at         INTEGER,
  ended_at           INTEGER,
  duration_ms        INTEGER,
  duration_reliable  INTEGER,
  stop_reason        TEXT,
  status             TEXT
);

CREATE TABLE IF NOT EXISTS usage_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id       TEXT,
  captured_at      INTEGER,
  aiu              REAL,
  premium_requests INTEGER,
  cost_total       REAL,
  context_tokens   INTEGER,
  context_pct      REAL,
  model            TEXT
);

CREATE INDEX IF NOT EXISTS idx_phases_feature_skill ON phases(feature, skill);
CREATE INDEX IF NOT EXISTS idx_phases_session       ON phases(session_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session        ON tasks(session_id);
CREATE INDEX IF NOT EXISTS idx_spans_phase          ON spans(phase_id);
CREATE INDEX IF NOT EXISTS idx_subagents_sess_stat  ON subagents(session_id, status);
CREATE INDEX IF NOT EXISTS idx_snapshots_sess_time  ON usage_snapshots(session_id, captured_at);
