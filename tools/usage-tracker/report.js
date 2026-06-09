// Report generator for the superpowers usage tracker.
//
// buildReport(db) returns a plain JSON object the dashboard renders:
//   - tree:   repo -> branch(feature) -> skill(phase) with AI credits + duration
//   - tools:  tool-use counts and durations
//   - skills: superpowers phase analysis (per skill)
//   - subagents: per agent_name counts and (reliable) durations
//   - totals: headline numbers
//
// Durations are milliseconds in the data; the UI formats them as seconds.
import { openDb, defaultDbPath, nowMs, isMainModule } from './db.js';

const n = (v) => (v == null ? 0 : Number(v));
const ts = (v) => (v == null ? null : Number(v));

// Build a SQL clause restricting `col` to the [from, to] millisecond window.
// Bounds are inlined as integers (validated finite numbers, never user text),
// so this works uniformly across the node:sqlite and sqlite3-CLI backends
// without threading bind params through nested subqueries.
function rangeClauses(opts = {}) {
  const from = Number.isFinite(opts.from) ? Math.floor(opts.from) : null;
  const to = Number.isFinite(opts.to) ? Math.floor(opts.to) : null;
  const conds = (col) => {
    const parts = [];
    if (from != null) parts.push(`${col} >= ${from}`);
    if (to != null) parts.push(`${col} <= ${to}`);
    return parts;
  };
  return {
    from, to,
    // ` WHERE ...` when bounds exist, else ''.
    where: (col) => { const p = conds(col); return p.length ? ` WHERE ${p.join(' AND ')}` : ''; },
    // ` AND ...` appended to an existing WHERE, else ''.
    and: (col) => { const p = conds(col); return p.length ? ` AND ${p.join(' AND ')}` : ''; },
  };
}

export function buildReport(db, opts = {}) {
  const r = rangeClauses(opts);

  const totals = db.get(`
    SELECT
      (SELECT COUNT(*) FROM sessions${r.where('started_at')})  AS sessions,
      (SELECT COUNT(*) FROM tasks${r.where('started_at')})     AS tasks,
      (SELECT COUNT(*) FROM phases${r.where('started_at')})    AS phases,
      (SELECT COUNT(*) FROM subagents${r.where('started_at')}) AS subagents,
      (SELECT COALESCE(SUM(duration_ms),0) FROM phases${r.where('started_at')}) AS duration_ms,
      (SELECT COALESCE(SUM(aiu_delta),0)   FROM phases${r.where('started_at')}) AS aiu,
      (SELECT COALESCE(SUM(premium_delta),0) FROM phases${r.where('started_at')}) AS premium,
      (SELECT COALESCE(SUM(total_tokens),0) FROM phases${r.where('started_at')}) AS tokens`) || {};

  // --- Hierarchy: repo -> feature(branch) -> skill(phase) --------------------
  const rows = db.all(`
    SELECT COALESCE(s.repo, '(unknown repo)')   AS repo,
           COALESCE(p.feature, '(no branch)')   AS feature,
           COALESCE(p.skill, '(root)')          AS skill,
           COUNT(*)                              AS n,
           COALESCE(SUM(p.aiu_delta), 0)         AS aiu,
           COALESCE(SUM(p.duration_ms), 0)       AS duration_ms,
           COALESCE(SUM(p.total_tokens), 0)      AS tokens,
           MIN(p.started_at)                     AS first_at,
           MAX(p.started_at)                     AS last_at
    FROM phases p
    LEFT JOIN sessions s ON p.session_id = s.session_id${r.where('p.started_at')}
    GROUP BY repo, feature, skill`);

  // Track the smallest/largest timestamp seen while rolling rows up the tree.
  const minT = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));
  const maxT = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b));

  const repoMap = new Map();
  for (const row of rows) {
    let repo = repoMap.get(row.repo);
    if (!repo) { repo = { repo: row.repo, aiu: 0, durationMs: 0, tokens: 0, firstAt: null, lastAt: null, branches: new Map() }; repoMap.set(row.repo, repo); }
    let br = repo.branches.get(row.feature);
    if (!br) { br = { feature: row.feature, aiu: 0, durationMs: 0, tokens: 0, firstAt: null, lastAt: null, skills: [] }; repo.branches.set(row.feature, br); }
    const first = ts(row.first_at); const last = ts(row.last_at);
    br.skills.push({ skill: row.skill, count: n(row.n), aiu: n(row.aiu), durationMs: n(row.duration_ms), tokens: n(row.tokens), firstAt: first, lastAt: last });
    br.aiu += n(row.aiu); br.durationMs += n(row.duration_ms); br.tokens += n(row.tokens);
    br.firstAt = minT(br.firstAt, first); br.lastAt = maxT(br.lastAt, last);
    repo.aiu += n(row.aiu); repo.durationMs += n(row.duration_ms); repo.tokens += n(row.tokens);
    repo.firstAt = minT(repo.firstAt, first); repo.lastAt = maxT(repo.lastAt, last);
  }
  const tree = [...repoMap.values()].map((repo) => ({
    repo: repo.repo, aiu: repo.aiu, durationMs: repo.durationMs, tokens: repo.tokens,
    firstAt: repo.firstAt, lastAt: repo.lastAt,
    branches: [...repo.branches.values()]
      .map((b) => ({ ...b, skills: b.skills.sort((a, z) => z.durationMs - a.durationMs) }))
      .sort((a, z) => z.durationMs - a.durationMs),
  })).sort((a, z) => z.durationMs - a.durationMs);

  // --- Top tools -------------------------------------------------------------
  const tools = db.all(`
    SELECT name,
           COUNT(*) AS count,
           SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed,
           COALESCE(SUM(duration_ms), 0) AS total_ms,
           COALESCE(AVG(duration_ms), 0) AS avg_ms,
           COALESCE(MAX(duration_ms), 0) AS max_ms,
           MIN(started_at) AS first_at,
           MAX(started_at) AS last_at
    FROM spans WHERE kind='tool'${r.and('started_at')}
    GROUP BY name ORDER BY count DESC`).map((t) => ({
      name: t.name, count: n(t.count), timed: n(t.timed),
      totalMs: n(t.total_ms), avgMs: Math.round(n(t.avg_ms)), maxMs: n(t.max_ms),
      firstAt: ts(t.first_at), lastAt: ts(t.last_at),
    }));

  // --- Superpowers phase (skill) analysis ------------------------------------
  const skills = db.all(`
    SELECT COALESCE(skill, '(root)') AS skill,
           COUNT(*) AS count,
           COALESCE(SUM(duration_ms), 0) AS total_ms,
           COALESCE(AVG(duration_ms), 0) AS avg_ms,
           COALESCE(SUM(aiu_delta), 0)   AS aiu,
           COALESCE(SUM(total_tokens), 0) AS tokens,
           MIN(started_at) AS first_at,
           MAX(started_at) AS last_at
    FROM phases${r.where('started_at')} GROUP BY skill ORDER BY total_ms DESC`).map((s) => ({
      skill: s.skill, count: n(s.count),
      totalMs: n(s.total_ms), avgMs: Math.round(n(s.avg_ms)),
      aiu: n(s.aiu), tokens: n(s.tokens),
      firstAt: ts(s.first_at), lastAt: ts(s.last_at),
    }));

  // --- Subagents -------------------------------------------------------------
  const subagents = db.all(`
    SELECT agent_name AS name,
           COUNT(*) AS count,
           SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
           AVG(CASE WHEN duration_reliable=1 THEN duration_ms END) AS avg_ms,
           SUM(CASE WHEN duration_reliable=1 THEN 1 ELSE 0 END) AS reliable,
           MIN(started_at) AS first_at,
           MAX(started_at) AS last_at
    FROM subagents${r.where('started_at')} GROUP BY agent_name ORDER BY count DESC`).map((a) => ({
      name: a.name, count: n(a.count), running: n(a.running),
      reliable: n(a.reliable), avgMs: a.avg_ms == null ? null : Math.round(n(a.avg_ms)),
      firstAt: ts(a.first_at), lastAt: ts(a.last_at),
    }));

  return {
    generatedAt: nowMs(),
    range: { from: r.from, to: r.to },
    totals: {
      sessions: n(totals.sessions), tasks: n(totals.tasks), phases: n(totals.phases),
      subagents: n(totals.subagents), durationMs: n(totals.duration_ms),
      aiu: n(totals.aiu), premium: n(totals.premium), tokens: n(totals.tokens),
    },
    tree, tools, skills, subagents,
  };
}

function main() {
  const dbPath = process.argv[2] || defaultDbPath(process.env);
  const db = openDb(dbPath);
  try {
    process.stdout.write(JSON.stringify(buildReport(db), null, 2) + '\n');
  } finally {
    db.close();
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
