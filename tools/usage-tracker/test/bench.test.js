import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../bench.js';

test('summarize reports count, min, max, mean, median, p95', () => {
  // 1..100 ms expressed in nanoseconds
  const samples = [];
  for (let i = 1; i <= 100; i++) samples.push(BigInt(i) * 1_000_000n);
  const s = summarize(samples);
  assert.equal(s.count, 100);
  assert.equal(s.minMs, 1);
  assert.equal(s.maxMs, 100);
  assert.ok(Math.abs(s.meanMs - 50.5) < 1e-6, `mean ${s.meanMs}`);
  // median nearest-rank lower index floor((100-1)/2)=49 -> 50ms
  assert.equal(s.medianMs, 50);
  // p95 nearest-rank: ceil(0.95*100)=95th -> index 94 -> 95ms
  assert.equal(s.p95Ms, 95);
});

test('summarize handles a single sample', () => {
  const s = summarize([5_000_000n]);
  assert.equal(s.count, 1);
  assert.equal(s.minMs, 5);
  assert.equal(s.maxMs, 5);
  assert.equal(s.medianMs, 5);
  assert.equal(s.p95Ms, 5);
});

test('summarize returns zeros for an empty sample set', () => {
  const s = summarize([]);
  assert.equal(s.count, 0);
  assert.equal(s.medianMs, 0);
  assert.equal(s.p95Ms, 0);
});
