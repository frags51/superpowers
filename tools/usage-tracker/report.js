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
import { readShutdownSnapshot, subagentWindowsFromTranscript } from './snapshot.js';

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
  // NO snapshot rows at all).  Only ended sessions are considered (ended_at IS
  // NOT NULL) — running sessions may still receive real statusLine snapshots.
  //
  // On success: the real snapshot is inserted → excluded from the join forever.
  // On failure (no session.shutdown event): a sentinel row (aiu=0) is inserted
  //   so the session is also excluded from the join on future report builds.
  //   The sentinel has no effect on liveAiuBySession (only set on success).
  //
  // Net result: each session.jsonl is read at most once, ever.
  //
  // opts.resolveTranscript(sessionId) → path; wired in main() below.
  const resolveTranscript = opts.resolveTranscript || null;
  if (resolveTranscript) {
    const noSnapSessions = db.all(`
      SELECT s.session_id, s.ended_at
      FROM sessions s
      LEFT JOIN usage_snapshots us ON s.session_id = us.session_id
      WHERE us.session_id IS NULL AND s.ended_at IS NOT NULL`);
    for (const { session_id: s, ended_at } of noSnapSessions) {
      const transcriptPath = resolveTranscript(s);
      const capturedAt = Number(ended_at);
      const snap = readShutdownSnapshot(transcriptPath, s, capturedAt);
      try {
        if (snap) {
          db.run(
            'INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)',
            [snap.session_id, snap.captured_at, snap.aiu, snap.premium_requests, snap.cost_total],
          );
          liveAiuBySession.set(s, Math.max(0, Number(snap.aiu)));
        } else {
          // Sentinel: marks this session as permanently attempted so it is
          // excluded from the LEFT JOIN on every subsequent report build.
          db.run(
            'INSERT INTO usage_snapshots (session_id, captured_at, aiu) VALUES (?,?,0)',
            [s, capturedAt],
          );
        }
      } catch { /* best-effort — never let a write failure break the report */ }
    }
  }

  // Roll up child-session AIC into parent sessions so a parent that delegates
  // all work to subagents shows real credits instead of 0.  The child session's
  // AIC counter is session-scoped (starts at 0), so its live value is its full
  // contribution.  We also record which sessions are child sessions so the
  // headline total is not double-counted (child AIC is credited to the parent).
  const childToParent = new Map(); // childSessionId -> parentSessionId
  // In-process subagents (below) share the parent's session-scoped AIC counter,
  // so their AIC is ALREADY inside the parent's own live value and must NOT be
  // re-added to it (doing so doubles the parent). Separate child sessions (e.g.
  // `copilot -p …` spawned via bash) have an independent counter and ARE added.
  const inProcessChild = new Set(); // childSessionId whose AIC is a subset of its parent's
  for (const row of db.all('SELECT session_id AS parent, child_session_id AS child FROM subagents WHERE child_session_id IS NOT NULL')) {
    // A session is never its own child. `task`-tool subagents run in-process and
    // self-link (child_session_id == parent); skip them here — their AIC lives in
    // the parent already and is broken out per-subagent via the phantom sessions
    // recovered below.
    if (row.child === row.parent) continue;
    childToParent.set(row.child, row.parent);
  }

  // Recover in-process `task`-tool subagents that surfaced as 0-AIC "sessions":
  // the CLI tags their hook activity with the subagent's tool-call id as a
  // phantom session_id (no sessions-table row, no usage_snapshots). Read each
  // real session's transcript for subagent.started/completed events, then
  // attribute the parent's cumulative-snapshot delta over the subagent's window
  // to the phantom session and nest it under the parent.
  if (resolveTranscript) {
    const realSessionIds = new Set(db.all('SELECT session_id FROM sessions').map((s) => s.session_id));
    const phantomIds = new Set(
      db.all('SELECT DISTINCT session_id AS sid FROM phases').map((p) => p.sid)
        .filter((sid) => sid && !realSessionIds.has(sid)),
    );
    if (phantomIds.size) {
      const snapsBySession = new Map(); // sessionId -> rows sorted asc by captured_at
      const snapsFor = (sid) => {
        if (!snapsBySession.has(sid)) {
          snapsBySession.set(sid, db.all(
            'SELECT captured_at, aiu FROM usage_snapshots WHERE session_id=? AND aiu IS NOT NULL ORDER BY captured_at',
            [sid],
          ));
        }
        return snapsBySession.get(sid);
      };
      for (const parentId of realSessionIds) {
        const windows = subagentWindowsFromTranscript(resolveTranscript(parentId));
        if (!windows.length) continue;
        const parentSnaps = snapsFor(parentId);
        if (!parentSnaps.length) continue;
        for (const w of windows) {
          if (!phantomIds.has(w.agentId) || w.startedAt == null) continue;
          // Baseline = last snapshot at/before the subagent started (or the
          // session's 0 origin). Endpoint = first snapshot at/after it ended —
          // the subagent's usage lands in the parent's counter only once the
          // statusLine refreshes after it returns (it cannot fire while a sync
          // subagent blocks the parent). Fall back to the last snapshot when no
          // snapshot was captured after the window (e.g. still running).
          let base = 0;
          for (const s of parentSnaps) {
            if (s.captured_at <= w.startedAt) base = Number(s.aiu); else break;
          }
          const endRef = w.endedAt == null ? Infinity : w.endedAt;
          let end = null;
          for (const s of parentSnaps) {
            if (s.captured_at >= endRef) { end = Number(s.aiu); break; }
          }
          if (end == null) end = Number(parentSnaps[parentSnaps.length - 1].aiu);
          liveAiuBySession.set(w.agentId, Math.max(0, end - base));
          childToParent.set(w.agentId, parentId);
          inProcessChild.add(w.agentId);
          if (w.agentName) {
            const se = sessMap.get(w.agentId);
            if (se && !se.title) se.title = `${w.agentName} (subagent)`;
          }
        }
      }
    }
  }

  const childAiuByParent = new Map(); // parentSessionId -> summed child live AIC
  for (const [childId, parentId] of childToParent) {
    if (inProcessChild.has(childId)) continue; // already inside the parent's counter
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

  // --- Tasks: one entry per task with per-skill breakdown --------------------
  // Groups phases by task, joining back to sessions for repo/branch identity.
  // Range filter applies to phases.started_at so tasks with NO phase in the
  // window are excluded even if the task itself started outside the window.
  const taskPhaseRows = db.all(`
    SELECT COALESCE(t.task_id, '(unknown)')          AS task_id,
           p.session_id                              AS phase_session_id,
           COALESCE(t.session_id, p.session_id)      AS session_id,
           COALESCE(s.repo, '(unknown repo)')         AS repo,
           COALESCE(s.branch, '(no branch)')          AS branch,
           COALESCE(t.feature, '(unknown)')            AS feature,
           t.label                                    AS label,
           t.turn_index                               AS turn_index,
           t.prompt_excerpt                           AS prompt_excerpt,
           t.started_at                               AS task_started,
           t.ended_at                                 AS task_ended,
           COALESCE(p.skill, '(root)')                AS skill,
           COUNT(*)                                   AS n,
           COALESCE(SUM(p.aiu_delta), 0)              AS aiu,
           COALESCE(SUM(p.duration_ms), 0)            AS duration_ms,
           COALESCE(SUM(p.total_tokens), 0)           AS tokens,
           MIN(p.started_at)                          AS first_at,
           MAX(p.started_at)                          AS last_at
    FROM phases p
    LEFT JOIN tasks t  ON p.task_id = t.task_id AND p.session_id = t.session_id /* compound key: task_ids like s1:0 repeat across sessions */
    LEFT JOIN sessions s ON p.session_id = s.session_id${r.where('p.started_at')}
    GROUP BY p.session_id, t.task_id, p.skill`);

  const taskMap = new Map();
  for (const row of taskPhaseRows) {
    const sid = row.phase_session_id || row.session_id || '(unknown-session)';
    const tid = row.task_id || '(unknown)';
    const mapKey = `${sid}::${tid}`;
    let tk = taskMap.get(mapKey);
    if (!tk) {
      tk = {
        taskId: tid, sessionId: sid, repo: row.repo, branch: row.branch,
        feature: row.feature, label: row.label ?? null, turnIndex: n(row.turn_index),
        promptExcerpt: row.prompt_excerpt ?? null,
        startedAt: ts(row.task_started), endedAt: ts(row.task_ended),
        aiu: 0, durationMs: 0, tokens: 0, firstAt: null, lastAt: null, skills: [],
      };
      taskMap.set(mapKey, tk);
    }
    const first = ts(row.first_at); const last = ts(row.last_at);
    tk.skills.push({ skill: row.skill, count: n(row.n), aiu: n(row.aiu), durationMs: n(row.duration_ms), tokens: n(row.tokens), firstAt: first, lastAt: last });
    tk.aiu += n(row.aiu); tk.durationMs += n(row.duration_ms); tk.tokens += n(row.tokens);
    tk.firstAt = minT(tk.firstAt, first); tk.lastAt = maxT(tk.lastAt, last);
  }

  // Substitute live AIC for tasks in sessions that have snapshot-based live values.
  // A task's finalized aiu_delta sum can be 0 while the session's live counter is
  // non-zero (e.g. its phases are still open). Distribute the session's live AIC
  // proportionally to each task's share of the session's total finalized duration.
  const sessionTasksBySession = new Map(); // sessionId -> [tk]
  for (const [, tk] of taskMap) {
    if (!sessionTasksBySession.has(tk.sessionId)) sessionTasksBySession.set(tk.sessionId, []);
    sessionTasksBySession.get(tk.sessionId).push(tk);
  }
  for (const [sid, tks] of sessionTasksBySession) {
    const live = liveAiuBySession.get(sid);
    if (live == null) continue;
    const finalizedTotal = tks.reduce((s, t) => s + t.aiu, 0);
    if (live <= finalizedTotal) continue; // finalized already at least as good
    const totalDur = tks.reduce((s, t) => s + t.durationMs, 0);
    for (const tk of tks) {
      // Distribute proportionally by duration; equal share when no duration basis.
      tk.aiu = totalDur > 0 ? live * (tk.durationMs / totalDur) : live / tks.length;
    }
  }

  const tasks = [...taskMap.values()].map((tk) => ({
    ...tk,
    skills: tk.skills.sort((a, z) => z.durationMs - a.durationMs),
  })).sort((a, z) => (z.startedAt ?? z.firstAt ?? 0) - (a.startedAt ?? a.firstAt ?? 0));

  return {
    generatedAt: nowMs(),
    range: { from: r.from, to: r.to },
    totals: {
      sessions: n(totals.sessions), tasks: n(totals.tasks), phases: n(totals.phases),
      subagents: n(totals.subagents), durationMs: n(totals.duration_ms),
      aiu: n(totals.aiu), premium: n(totals.premium), cost: n(totals.cost), tokens: n(totals.tokens),
    },
    tree, tools, skills, subagents, sessions, tasks,
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
