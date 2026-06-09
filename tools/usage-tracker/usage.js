// Pure helpers: cumulative-snapshot deltas and transcript token sums.
import { readFileSync } from 'node:fs';

// rows: usage_snapshots ordered by captured_at ASC (any order accepted).
// Returns deltas between the last snapshot at/before startMs (baseline)
// and the last snapshot at/before endMs (end). Null when not derivable.
export function snapshotDelta(rows, startMs, endMs) {
  const sorted = [...rows].sort((a, b) => a.captured_at - b.captured_at);
  const atOrBefore = (t) => {
    let found = null;
    for (const r of sorted) {
      if (r.captured_at <= t) found = r;
      else break;
    }
    return found;
  };
  const base = atOrBefore(startMs);
  const end = atOrBefore(endMs);
  if (!base || !end || end.captured_at < (base.captured_at ?? 0)) {
    return { aiu_delta: null, premium_delta: null, cost_delta: null };
  }
  const sub = (a, b) => (a == null || b == null ? null : a - b);
  return {
    aiu_delta: sub(end.aiu, base.aiu),
    premium_delta: sub(end.premium_requests, base.premium_requests),
    cost_delta: sub(end.cost_total, base.cost_total),
  };
}

// Sums assistant.message outputTokens whose timestamp is within [startMs, endMs].
// The local events.jsonl carries OUTPUT tokens only; input_tokens stays null.
export function sumOutputTokens(transcriptPath, startMs, endMs) {
  let raw;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return { input_tokens: null, output_tokens: null, total_tokens: null };
  }
  let out = 0;
  let saw = false;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant.message') continue;
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts) || ts < startMs || ts > endMs) continue;
    const n = o.data && typeof o.data.outputTokens === 'number' ? o.data.outputTokens : 0;
    out += n;
    saw = true;
  }
  if (!saw) return { input_tokens: null, output_tokens: null, total_tokens: null };
  return { input_tokens: null, output_tokens: out, total_tokens: out };
}
