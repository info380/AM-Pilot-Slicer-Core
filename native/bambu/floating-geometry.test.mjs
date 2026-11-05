import assert from 'node:assert/strict';
import test from 'node:test';
import { boundSegmentVariation } from './floating-geometry.mjs';
const segment = (a, b, e = .1) => [a, b, e];

test('reordering and reversing deposited segments have zero variation', () => {
  const a = [segment([0, 0, 0], [2, 0, 0]), segment([2, 0, 0], [3, 1, 0])], b = [segment([3, 1, 0], [2, 0, 0]), a[0]];
  const result = boundSegmentVariation(a, b, .001);
  assert.equal(result.differingSegmentsA, 0); assert.equal(result.differingSegmentsB, 0); assert.equal(result.hausdorffUpperBoundMm, 0);
});

test('continuous bounds detect an interior displacement missed by endpoints', () => {
  const a = [segment([-1, 0, 0], [1, 0, 0])], b = [segment([-1, 0, 0], [0, 1, 0]), segment([0, 1, 0], [1, 0, 0])];
  const result = boundSegmentVariation(a, b, .001);
  assert(result.hausdorffLowerBoundMm >= 1); assert(result.hausdorffUpperBoundMm >= 1 && result.hausdorffUpperBoundMm <= 1.001);
});

test('translation distance is bounded symmetrically and extrusion drift stays visible', () => {
  const a = Array.from({ length: 32 }, (_, i) => segment([i, 0, 0], [i + 1, 0, 0]));
  const b = a.map(([p, q]) => segment([p[0], .03, p[2]], [q[0], .03, q[2]], .2));
  const result = boundSegmentVariation(a, b, .001);
  assert(result.hausdorffLowerBoundMm >= .03 - 1e-12 && result.hausdorffUpperBoundMm <= .031);
  assert(Math.abs(result.extrusionDeltaMm - 3.2) < 1e-9); assert.equal(result.lengthDeltaMm, 0);
  assert.deepEqual(boundSegmentVariation(b, a, .001).hausdorffUpperBoundMm, result.hausdorffUpperBoundMm);
});

test('missing geometry and malformed coordinates cannot qualify', () => {
  assert.throws(() => boundSegmentVariation([], [segment([0, 0, 0], [1, 0, 0])], .001), /Missing/);
  assert.throws(() => boundSegmentVariation([segment([NaN, 0, 0], [1, 0, 0])], [segment([0, 0, 0], [1, 0, 0])], .001));
});
