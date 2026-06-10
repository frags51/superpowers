// Report generator for the superpowers usage tracker.
//
// buildReport(db) returns a plain JSON object the dashboard renders:
//   - tree:   repo -> branch(feature) -> skill(phase) with AI credits + duration
//   - tools:  tool-use counts and durations
//   - skills: superpowers phase analysis (per skill)
//   - subagents: per agent_name counts and (reliable) durations
//   - sessions: per session(id) identity + skill(phase) breakdown
//   - totals: headline numbers
//
// Durations are milliseconds in the data; the UI formats them as seconds.
import { join } from 'node:path';
import { openDb, defaultDbPath, defaultSessionStorePath, loadSessionTitles, nowMs, isMainModule } from './db.js';
import { readShutdownSnapshot } from './snapshot.js';

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
  // Read-time session "title" enrichment (Copilot's own session summaries),
  // injected by callers; absent/empty by default so the core report stays pure.
  const titles = opts.sessionTitles || {};

  const totals = db.get(`
    SELECT
      (SELECT COUNT(*) FROM sessions${r.where('started_at')})  AS sessions,
      (SELECT COUNT(*) FROM tasks${r.where('started_at')})     AS tasks,
      (SELECT COUNT(*) FROM phases${r.where('started_at')})    AS phases,
      (SELECT COUNT(*) FROM subagents${r.where('started_at')}) AS subagents,
      (SELECT COALESCE(SUM(duration_ms),0) FROM phases${r.where('started_at')}) AS duration_ms,
      (SELECT COALESCE(SUM(aiu_delta),0)   FROM phases${r.where('started_at')}) AS aiu,
      (SELECT COALESCE(SUM(premium_delta),0) FROM phases${r.where('started_at')}) AS premium,
      (SELECT COALESCE(SUM(cost_delta),0)  FROM phases${r.where('started_at')}) AS cost,
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

  // --- Sessions: session -> skill(phase) -------------------------------------
  // Branch/repo here come from the session's own identity (sessions table), not
  // from phase `feature` like the tree above — so a session that writes into a
  // worktree on another branch shows its session branch here, by design.
  const sessRows = db.all(`
    SELECT p.session_id                          AS session_id,
           COALESCE(s.repo, '(unknown repo)')    AS repo,
           COALESCE(s.branch, '(no branch)')     AS branch,
           s.model                               AS model,
           s.started_at                          AS session_started,
           s.ended_at                            AS session_ended,
           s.end_reason                          AS end_reason,
           COALESCE(p.skill, '(root)')           AS skill,
           COUNT(*)                              AS n,
           COALESCE(SUM(p.aiu_delta), 0)         AS aiu,
           COALESCE(SUM(p.duration_ms), 0)       AS duration_ms,
           COALESCE(SUM(p.total_tokens), 0)      AS tokens,
           MIN(p.started_at)                     AS first_at,
           MAX(p.started_at)                     AS last_at
    FROM phases p
    LEFT JOIN sessions s ON p.session_id = s.session_id${r.where('p.started_at')}
    GROUP BY p.session_id, skill`);

  const sessMap = new Map();
  for (const row of sessRows) {
    let se = sessMap.get(row.session_id);
    if (!se) {
      se = {
        sessionId: row.session_id, title: titles[row.session_id] ?? null,
        repo: row.repo, branch: row.branch, model: row.model,
        startedAt: ts(row.session_started), endedAt: ts(row.session_ended), endReason: row.end_reason,
        aiu: 0, durationMs: 0, tokens: 0, firstAt: null, lastAt: null, skills: [],
      };
      sessMap.set(row.session_id, se);
    }
    const first = ts(row.first_at); const last = ts(row.last_at);
    se.skills.push({ skill: row.skill, count: n(row.n), aiu: n(row.aiu), durationMs: n(row.duration_ms), tokens: n(row.tokens), firstAt: first, lastAt: last });
    se.aiu += n(row.aiu); se.durationMs += n(row.duration_ms); se.tokens += n(row.tokens);
    se.firstAt = minT(se.firstAt, first); se.lastAt = maxT(se.lastAt, last);
  }
  // Per-session brief summaries of tool and subagent activity (for the session
  // drilldown headline), keyed by session_id.
  const toolBySess = new Map();
  for (const row of db.all(`
    SELECT session_id AS sid, COUNT(*) AS c, COALESCE(SUM(duration_ms), 0) AS dur
    FROM spans WHERE kind='tool'${r.and('started_at')} GROUP BY session_id`)) {
    toolBySess.set(row.sid, { count: n(row.c), durationMs: n(row.dur) });
  }
  const subBySess = new Map();
  for (const row of db.all(`
    SELECT session_id AS sid, COUNT(*) AS c,
           SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running
    FROM subagents${r.where('started_at')} GROUP BY session_id`)) {
    subBySess.set(row.sid, { count: n(row.c), running: n(row.running) });
  }

  // Live per-session AI credits, read straight from the cumulative usage
  // snapshots. A session's `aiu` counter is session-scoped (it starts at 0), so
  // its credit usage within the window is (snapshot value at the window's end)
  // minus (value just before the window's start). This captures usage that is
  // still sitting in the session's OPEN phase — whose aiu_delta has not been
  // finalized yet — so a fresh session (one open root phase, aiu_delta = NULL)
  // no longer sums to 0 while the status line shows real AIC. Sessions with no
  // snapshots (e.g. recorded before the statusLine collector was installed) fall
  // back to the summed phase deltas.
  const aiuToExpr = r.to != null ? `CASE WHEN captured_at <= ${r.to} THEN aiu END` : 'aiu';
  const aiuFromExpr = r.from != null ? `CASE WHEN captured_at < ${r.from} THEN aiu END` : 'NULL';
  const liveAiuBySession = new Map();
  for (const row of db.all(`
    SELECT session_id        AS sid,
           MAX(${aiuToExpr})   AS aiu_to,
           MAX(${aiuFromExpr}) AS aiu_from
    FROM usage_snapshots
    GROUP BY session_id`)) {
    if (row.aiu_to == null) continue; // no snapshot reaches this window
    const live = Number(row.aiu_to) - (row.aiu_from == null ? 0 : Number(row.aiu_from));
    liveAiuBySession.set(row.sid, Math.max(0, live));
  }

  // Reconcile sessions that have no usage_snapshots yet — this covers
  // --autopilot / --acp / -p sessions where the statusLine command is never
  // invoked, leaving usage_snapshots empty and AIC showing as 0.
  //
  // A single LEFT JOIN finds exactly the sessions that need work (those with
  // NO snapshot rows at all), avoiding N per-session lookups.  After the
  // INSERT below each session has a snapshot, so the next report build
  // excludes it from the join and never re-reads its events.jsonl.
  //
  // opts.resolveTranscript(sessionId) → path; wired in main() below.
  const resolveTranscript = opts.resolveTranscript || null;
  if (resolveTranscript) {
    const noSnapSessions = db.all(`
      SELECT s.session_id, s.ended_at
      FROM sessions s
      LEFT JOIN usage_snapshots us ON s.session_id = us.session_id
      WHERE us.session_id IS NULL`);
    for (const { session_id: s, ended_at } of noSnapSessions) {
      const transcriptPath = resolveTranscript(s);
      const capturedAt = ended_at != null ? Number(ended_at) : nowMs();
      const snap = readShutdownSnapshot(transcriptPath, s, capturedAt);
      if (!snap) continue;
      try {
        db.run(
          'INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
          [snap.session_id, snap.captured_at, snap.aiu, snap.premium_requests, snap.cost_total],
        );
      } catch { /* best-effort — never let a write failure break the report */ }
      liveAiuBySession.set(s, Math.max(0, Number(snap.aiu)));
    }
  }

  // Roll up child-session AIC into parent sessions so a parent that delegates
  // all work to subagents shows real credits instead of 0.  The child session's
  // AIC counter is session-scoped (starts at 0), so its live value is its full
  // contribution.  We also record which sessions are child sessions so the
  // headline total is not double-counted (child AIC is credited to the parent).
  const childToParent = new Map(); // childSessionId -> parentSessionId
  for (const row of db.all('SELECT session_id AS parent, child_session_id AS child FROM subagents WHERE child_session_id IS NOT NULL')) {
    childToParent.set(row.child, row.parent);
  }
  const childAiuByParent = new Map(); // parentSessionId -> summed child live AIC
  for (const [childId, parentId] of childToParent) {
    const childLive = liveAiuBySession.get(childId) ?? 0;
    childAiuByParent.set(parentId, (childAiuByParent.get(parentId) ?? 0) + childLive);
  }

  const sessions = [...sessMap.values()].map((se) => {
    const t = toolBySess.get(se.sessionId) || { count: 0, durationMs: 0 };
    const sub = subBySess.get(se.sessionId) || { count: 0, running: 0 };
    let aiu = liveAiuBySession.has(se.sessionId) ? liveAiuBySession.get(se.sessionId) : se.aiu;
    // Add child session AIC so the parent reflects total subagent cost.
    aiu += (childAiuByParent.get(se.sessionId) ?? 0);
    return {
      ...se,
      aiu,
      // Non-null when this session is itself a subagent launched by another session.
      // The dashboard can use this to indent or dim child sessions.
      parentSessionId: childToParent.get(se.sessionId) ?? null,
      toolCount: t.count, toolDurationMs: t.durationMs,
      subagentCount: sub.count, subagentRunning: sub.running,
      skills: se.skills.sort((a, z) => z.durationMs - a.durationMs),
    };
  }).sort((a, z) => (z.startedAt ?? z.firstAt ?? 0) - (a.startedAt ?? a.firstAt ?? 0));

  // Headline AIC: sum only top-level (non-child) sessions so child AIC is not
  // double-counted (it's already included in the parent's aiu above).
  totals.aiu = sessions
    .filter((se) => se.parentSessionId == null)
    .reduce((acc, se) => acc + se.aiu, 0);

  // --- Top tools -------------------------------------------------------------
  // Per-tool duration percentiles (P75/P95) are computed in JS from the sorted
  // per-call durations — SQLite has no percentile aggregate. Durations arrive
  // pre-sorted ascending per tool so nearest-rank indexing works directly.
  const durByTool = new Map();
  for (const row of db.all(`
    SELECT name, duration_ms FROM spans
    WHERE kind='tool' AND duration_ms IS NOT NULL${r.and('started_at')}
    ORDER BY name, duration_ms`)) {
    if (!durByTool.has(row.name)) durByTool.set(row.name, []);
    durByTool.get(row.name).push(Number(row.duration_ms));
  }
  const pctl = (arr, p) => {
    if (!arr || !arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
    return arr[idx];
  };
  const tools = db.all(`
    SELECT name,
           COUNT(*) AS count,
           SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END) AS timed,
           COALESCE(SUM(duration_ms), 0) AS total_ms,
           MIN(started_at) AS first_at,
           MAX(started_at) AS last_at
    FROM spans WHERE kind='tool'${r.and('started_at')}
    GROUP BY name ORDER BY count DESC`).map((t) => {
      const d = durByTool.get(t.name) || [];
      return {
        name: t.name, count: n(t.count), timed: n(t.timed),
        p75Ms: pctl(d, 75), p95Ms: pctl(d, 95),
        totalMs: n(t.total_ms),
        firstAt: ts(t.first_at), lastAt: ts(t.last_at),
      };
    });

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
           COALESCE(SUM(CASE WHEN duration_reliable=1 THEN duration_ms ELSE 0 END), 0) AS total_ms,
           COALESCE(MAX(CASE WHEN duration_reliable=1 THEN duration_ms END), 0) AS max_ms,
           SUM(CASE WHEN duration_reliable=1 THEN 1 ELSE 0 END) AS reliable,
           MIN(started_at) AS first_at,
           MAX(started_at) AS last_at
    FROM subagents${r.where('started_at')} GROUP BY agent_name ORDER BY count DESC`).map((a) => ({
      name: a.name, count: n(a.count), running: n(a.running),
      reliable: n(a.reliable), avgMs: a.avg_ms == null ? null : Math.round(n(a.avg_ms)),
      totalMs: n(a.total_ms), maxMs: n(a.max_ms),
      firstAt: ts(a.first_at), lastAt: ts(a.last_at),
    }));

  return {
    generatedAt: nowMs(),
    range: { from: r.from, to: r.to },
    totals: {
      sessions: n(totals.sessions), tasks: n(totals.tasks), phases: n(totals.phases),
      subagents: n(totals.subagents), durationMs: n(totals.duration_ms),
      aiu: n(totals.aiu), premium: n(totals.premium), cost: n(totals.cost), tokens: n(totals.tokens),
    },
    tree, tools, skills, subagents, sessions,
  };
}

function main() {
  const dbPath = process.argv[2] || defaultDbPath(process.env);
  const db = openDb(dbPath);
  const sessionTitles = loadSessionTitles(defaultSessionStorePath(process.env));
  const env = process.env;
  const copilotHome = env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || '.', '.copilot');
  const resolveTranscript = (s) => join(copilotHome, 'session-state', s, 'events.jsonl');
  try {
    process.stdout.write(JSON.stringify(buildReport(db, { sessionTitles, resolveTranscript }), null, 2) + '\n');
  } finally {
    db.close();
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) main();
