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
