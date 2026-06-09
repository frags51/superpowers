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

export function buildReport(db) {
  const totals = db.get(`
    SELECT
      (SELECT COUNT(*) FROM sessions)  AS sessions,
      (SELECT COUNT(*) FROM tasks)     AS tasks,
      (SELECT COUNT(*) FROM phases)    AS phases,
      (SELECT COUNT(*) FROM subagents) AS subagents,
      (SELECT COALESCE(SUM(duration_ms),0) FROM phases) AS duration_ms,
      (SELECT COALESCE(SUM(aiu_delta),0)   FROM phases) AS aiu,
      (SELECT COALESCE(SUM(premium_delta),0) FROM phases) AS premium,
      (SELECT COALESCE(SUM(total_tokens),0) FROM phases) AS tokens`) || {};

  // --- Hierarchy: repo -> feature(branch) -> skill(phase) --------------------
  const rows = db.all(`
    SELECT COALESCE(s.repo, '(unknown repo)')   AS repo,
           COALESCE(p.feature, '(no branch)')   AS feature,
           COALESCE(p.skill, '(root)')          AS skill,
           COUNT(*)                              AS n,
           COALESCE(SUM(p.aiu_delta), 0)         AS aiu,
           COALESCE(SUM(p.duration_ms), 0)       AS duration_ms,
           COALESCE(SUM(p.total_tokens), 0)      AS tokens
    FROM phases p
    LEFT JOIN sessions s ON p.session_id = s.session_id
    GROUP BY repo, feature, skill`);

  const repoMap = new Map();
  for (const r of rows) {
    let repo = repoMap.get(r.repo);
    if (!repo) { repo = { repo: r.repo, aiu: 0, durationMs: 0, tokens: 0, branches: new Map() }; repoMap.set(r.repo, repo); }
    let br = repo.branches.get(r.feature);
    if (!br) { br = { feature: r.feature, aiu: 0, durationMs: 0, tokens: 0, skills: [] }; repo.branches.set(r.feature, br); }
    br.skills.push({ skill: r.skill, count: n(r.n), aiu: n(r.aiu), durationMs: n(r.duration_ms), tokens: n(r.tokens) });
    br.aiu += n(r.aiu); br.durationMs += n(r.duration_ms); br.tokens += n(r.tokens);
    repo.aiu += n(r.aiu); repo.durationMs += n(r.duration_ms); repo.tokens += n(r.tokens);
  }
  const tree = [...repoMap.values()].map((repo) => ({
    repo: repo.repo, aiu: repo.aiu, durationMs: repo.durationMs, tokens: repo.tokens,
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
           COALESCE(MAX(duration_ms), 0) AS max_ms
    FROM spans WHERE kind='tool'
    GROUP BY name ORDER BY count DESC`).map((t) => ({
      name: t.name, count: n(t.count), timed: n(t.timed),
      totalMs: n(t.total_ms), avgMs: Math.round(n(t.avg_ms)), maxMs: n(t.max_ms),
    }));

  // --- Superpowers phase (skill) analysis ------------------------------------
  const skills = db.all(`
    SELECT COALESCE(skill, '(root)') AS skill,
           COUNT(*) AS count,
           COALESCE(SUM(duration_ms), 0) AS total_ms,
           COALESCE(AVG(duration_ms), 0) AS avg_ms,
           COALESCE(SUM(aiu_delta), 0)   AS aiu,
           COALESCE(SUM(total_tokens), 0) AS tokens
    FROM phases GROUP BY skill ORDER BY total_ms DESC`).map((s) => ({
      skill: s.skill, count: n(s.count),
      totalMs: n(s.total_ms), avgMs: Math.round(n(s.avg_ms)),
      aiu: n(s.aiu), tokens: n(s.tokens),
    }));

  // --- Subagents -------------------------------------------------------------
  const subagents = db.all(`
    SELECT agent_name AS name,
           COUNT(*) AS count,
           SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
           AVG(CASE WHEN duration_reliable=1 THEN duration_ms END) AS avg_ms,
           SUM(CASE WHEN duration_reliable=1 THEN 1 ELSE 0 END) AS reliable
    FROM subagents GROUP BY agent_name ORDER BY count DESC`).map((a) => ({
      name: a.name, count: n(a.count), running: n(a.running),
      reliable: n(a.reliable), avgMs: a.avg_ms == null ? null : Math.round(n(a.avg_ms)),
    }));

  return {
    generatedAt: nowMs(),
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
