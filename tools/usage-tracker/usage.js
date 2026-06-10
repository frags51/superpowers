// Pure helpers: cumulative-snapshot deltas and transcript token sums.
import { readFileSync } from 'node:fs';

// Stable JSON stringify (object keys sorted) so equal inputs hash equal
// regardless of key order. Arrays keep their order.
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
}

// FNV-1a 32-bit hash: very fast, non-cryptographic. Good enough to bucket
// pre/post tool calls by their (name + arguments) fingerprint.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Approximate match key for pairing a preToolUse with its postToolUse when the
// Copilot CLI hook payloads carry no shared tool-call id. Fast and order-stable.
export function toolMatchKey(toolName, args) {
  return fnv1a((toolName || '') + '\u0000' + canonicalJson(args === undefined ? null : args));
}

// rows: usage_snapshots ordered by captured_at ASC (any order accepted).
// Returns the usage consumed during [startMs, endMs]. The CLI's cumulative
// counters (aiu / premium / cost) are SESSION-scoped — they start at 0 when the
// session begins — so usage at a time t is the last snapshot at/before t, or 0
// before the first snapshot. A phase therefore measures end - base where:
//   - end  = last snapshot at/before endMs (null only if the phase closed before
//            ANY snapshot was captured for the session — genuinely underivable)
//   - base = last snapshot at/before startMs, or the session's 0 origin when the
//            phase began before the first snapshot (so the first phase's usage is
//            attributed instead of being dropped).
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
  const end = atOrBefore(endMs);
  if (!end) {
    return { aiu_delta: null, premium_delta: null, cost_delta: null };
  }
  // No snapshot before the phase started => it began at the session's zero
  // origin (counters start at 0), so use 0 as the baseline.
  const base = atOrBefore(startMs) || { aiu: 0, premium_requests: 0, cost_total: 0 };
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
