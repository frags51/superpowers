// Minimal performance benchmark for the usage-tracker hot paths.
//
// What it measures (and why it matters):
//   1. in-process handle()   — the tracker logic cost per hook event, isolated
//      from Node startup. This is the only part the tracker controls.
//   2. subprocess hook        — `node tracker.js preToolUse` and `node
//      snapshot.js` end-to-end. This is the real latency added to the user's
//      session: every tool call spawns a fresh tracker process, and the status
//      line spawns a fresh snapshot process. Node startup dominates here.
//   3. buildReport()          — on-demand dashboard/report build over a seeded
//      DB.
//
// Usage:
//   node bench.js            human-readable table
//   node bench.js --json     machine-readable JSON
//   node bench.js --quick    fewer iterations (fast smoke run)
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { openDb, isMainModule } from './db.js';
import { handle } from './tracker.js';
import { buildReport } from './report.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRACKER = join(HERE, 'tracker.js');
const SNAPSHOT = join(HERE, 'snapshot.js');

// --- pure stats over an array of BigInt nanosecond durations ---------------
export function summarize(samplesNs) {
  const n = samplesNs.length;
  if (n === 0) return { count: 0, minMs: 0, maxMs: 0, meanMs: 0, medianMs: 0, p95Ms: 0 };
  const sorted = [...samplesNs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const ms = (v) => Number(v) / 1e6;
  let sum = 0n;
  for (const v of sorted) sum += v;
  const medianIdx = Math.floor((n - 1) / 2);
  const p95Idx = Math.min(n - 1, Math.ceil(0.95 * n) - 1);
  return {
    count: n,
    minMs: ms(sorted[0]),
    maxMs: ms(sorted[n - 1]),
    meanMs: Number(sum) / 1e6 / n,
    medianMs: ms(sorted[medianIdx]),
    p95Ms: ms(sorted[p95Idx]),
  };
}

const tmpDb = () => join(tmpdir(), `sp-bench-${randomUUID()}.db`);
const opts = { env: {}, resolveFeature: () => 'master', resolveRepo: () => 'agentharness', resolveFeatureForDir: () => 'feat-x', transcriptPath: null };

// Time a synchronous fn across `iters` runs, returning ns samples.
function timeSync(iters, fn) {
  const out = [];
  for (let i = 0; i < iters; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    out.push(process.hrtime.bigint() - t0);
  }
  return out;
}

// --- 1. in-process handle() per event --------------------------------------
function benchInProcess(iters) {
  const path = tmpDb();
  const db = openDb(path);
  const results = {};
  try {
    const sid = 'bench';
    handle('sessionStart', { sessionId: sid, timestamp: 0, cwd: '/repo' }, db, opts);
    let t = 1;
    results.userPromptSubmitted = summarize(timeSync(iters, () => {
      handle('userPromptSubmitted', { sessionId: sid, timestamp: t++, cwd: '/repo', prompt: 'bench prompt' }, db, opts);
    }));
    results.preToolUse = summarize(timeSync(iters, (i) => {
      handle('preToolUse', { sessionId: sid, timestamp: t++, cwd: '/repo', toolName: 'edit', toolArgs: { path: `/wt/feat-x/f${i}.js` }, toolCallId: `c${i}` }, db, opts);
    }));
    let j = 0;
    results.postToolUse = summarize(timeSync(iters, () => {
      handle('postToolUse', { sessionId: sid, timestamp: t++, toolName: 'edit', toolCallId: `c${j++}` }, db, opts);
    }));
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
  return results;
}

// --- 2. subprocess hook latency (Node startup + DB + handler) --------------
function benchSubprocess(script, event, payload, iters) {
  const path = tmpDb();
  const env = { ...process.env, SUPERPOWERS_USAGE_DB: path };
  const args = event ? [script, event] : [script];
  try {
    // one warmup (module compile cache, fs) outside the measured set
    try { execFileSync('node', args, { input: JSON.stringify(payload), env, stdio: ['pipe', 'ignore', 'ignore'] }); } catch { /* ignore */ }
    const samples = timeSync(iters, () => {
      execFileSync('node', args, { input: JSON.stringify(payload), env, stdio: ['pipe', 'ignore', 'ignore'] });
    });
    return summarize(samples);
  } finally {
    rmSync(path, { force: true });
  }
}

// --- 3. buildReport() over a seeded DB -------------------------------------
function seedDb(db, { sessions, tasksPer, phasesPer, spansPer }) {
  let snap = 0;
  for (let s = 0; s < sessions; s++) {
    const sid = `s${s}`;
    db.run('INSERT INTO sessions (session_id, repo, branch, started_at) VALUES (?,?,?,?)', [sid, 'agentharness', s % 3 ? `feat-${s % 7}` : 'master', s * 1000]);
    for (let t = 0; t < tasksPer; t++) {
      const tid = `${sid}:${t}`;
      db.run('INSERT INTO tasks (task_id, session_id, feature, turn_index, started_at) VALUES (?,?,?,?,?)', [tid, sid, `feat-${s % 7}`, t, s * 1000 + t]);
      for (let p = 0; p < phasesPer; p++) {
        const pid = `${tid}:${p}`;
        db.run("INSERT INTO phases (phase_id, task_id, session_id, feature, skill, kind, seq, started_at, duration_ms, aiu_delta, total_tokens, status) VALUES (?,?,?,?,?, 'skill', ?,?,?,?,?, 'closed')",
          [pid, tid, sid, `feat-${s % 7}`, `skill-${p}`, p, s * 1000 + t, 1234, 0.01, 100]);
        for (let sp = 0; sp < spansPer; sp++) {
          db.run("INSERT INTO spans (span_id, phase_id, task_id, session_id, kind, name, started_at, ended_at, duration_ms) VALUES (?,?,?,?, 'tool', ?,?,?,?)",
            [`${pid}:${sp}`, pid, tid, sid, `tool-${sp % 5}`, s, s + 10, 10]);
        }
      }
    }
    db.run('INSERT INTO usage_snapshots (session_id, captured_at, aiu, premium_requests, cost_total) VALUES (?,?,?,?,?)', [sid, s * 1000, snap++, 1, 0.1]);
  }
}

function benchReport(iters, scale) {
  const path = tmpDb();
  const db = openDb(path);
  try {
    seedDb(db, scale);
    const counts = {
      sessions: db.get('SELECT COUNT(*) c FROM sessions').c,
      tasks: db.get('SELECT COUNT(*) c FROM tasks').c,
      phases: db.get('SELECT COUNT(*) c FROM phases').c,
      spans: db.get('SELECT COUNT(*) c FROM spans').c,
    };
    const samples = timeSync(iters, () => { buildReport(db, {}); });
    return { stats: summarize(samples), counts };
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
}

function fmt(s) {
  return `median ${s.medianMs.toFixed(3)}ms  p95 ${s.p95Ms.toFixed(3)}ms  mean ${s.meanMs.toFixed(3)}ms  (min ${s.minMs.toFixed(3)} / max ${s.maxMs.toFixed(3)}, n=${s.count})`;
}

function main() {
  const quick = process.argv.includes('--quick');
  const asJson = process.argv.includes('--json');
  const inProcIters = quick ? 500 : 5000;
  const subIters = quick ? 10 : 40;
  const reportIters = quick ? 20 : 100;
  const reportScale = quick
    ? { sessions: 10, tasksPer: 3, phasesPer: 3, spansPer: 4 }
    : { sessions: 40, tasksPer: 5, phasesPer: 4, spansPer: 6 };

  const inproc = benchInProcess(inProcIters);
  const trackerHook = benchSubprocess(TRACKER, 'preToolUse', { sessionId: 'b', timestamp: 1, cwd: '/repo', toolName: 'grep', toolArgs: { pattern: 'x' } }, subIters);
  const snapshotHook = benchSubprocess(SNAPSHOT, null, { session_id: 'b', ai_used: { value: 1 }, cost: { total: 0.1, total_premium_requests: 1 }, context_window: { total_tokens: 10 }, model: { id: 'm' } }, subIters);
  const report = benchReport(reportIters, reportScale);

  const result = {
    node: process.version,
    inProcess: inproc,
    subprocess: { trackerPreToolUse: trackerHook, snapshot: snapshotHook },
    buildReport: report,
  };

  if (asJson) { console.log(JSON.stringify(result, null, 2)); return; }

  console.log(`\nUsage-tracker benchmark  (Node ${process.version})\n`);
  console.log('1) In-process handle() per event  — tracker logic only');
  for (const [k, v] of Object.entries(inproc)) console.log(`   ${k.padEnd(20)} ${fmt(v)}`);
  console.log('\n2) Subprocess hook latency  — real per-call cost (Node startup + DB + handler)');
  console.log(`   tracker.js preToolUse  ${fmt(trackerHook)}`);
  console.log(`   snapshot.js            ${fmt(snapshotHook)}`);
  console.log('\n3) buildReport() over a seeded DB');
  const c = report.counts;
  console.log(`   data: ${c.sessions} sessions / ${c.tasks} tasks / ${c.phases} phases / ${c.spans} spans`);
  console.log(`   ${fmt(report.stats)}`);
  console.log('');
}

if (isMainModule(import.meta.url)) main();
