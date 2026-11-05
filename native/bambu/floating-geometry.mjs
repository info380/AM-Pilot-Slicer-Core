import assert from 'node:assert/strict';

const geometryKey = ([a, b]) => JSON.stringify([a, b].map(point => JSON.stringify(point)).sort());
const key = segment => JSON.stringify([geometryKey(segment), segment[2]]);
const difference = (a, b) => {
  const counts = new Map();
  for (const segment of b) counts.set(key(segment), (counts.get(key(segment)) ?? 0) + 1);
  return a.filter(segment => { const k = key(segment), n = counts.get(k) ?? 0; if (n) { counts.set(k, n - 1); return false; } return true; });
};
const pointDistanceSquared = (p, [a, b]) => {
  const delta = b.map((value, i) => value - a[i]), denominator = delta.reduce((sum, value) => sum + value * value, 0);
  const t = denominator ? Math.max(0, Math.min(1, delta.reduce((sum, value, i) => sum + value * (p[i] - a[i]), 0) / denominator)) : 0;
  return delta.reduce((sum, value, i) => sum + (p[i] - a[i] - t * value) ** 2, 0);
};
const boxDistanceSquared = (p, node) => p.reduce((sum, value, i) => sum + Math.max(node.min[i] - value, 0, value - node.max[i]) ** 2, 0);
function tree(segments) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const segment of segments) for (const point of segment.slice(0, 2)) for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], point[i]); max[i] = Math.max(max[i], point[i]); }
  if (segments.length <= 8) return { min, max, segments };
  const axis = max.map((value, i) => value - min[i]).indexOf(Math.max(...max.map((value, i) => value - min[i])));
  const sorted = [...segments].sort((a, b) => a[0][axis] + a[1][axis] - b[0][axis] - b[1][axis]), middle = Math.floor(sorted.length / 2);
  return { min, max, children: [tree(sorted.slice(0, middle)), tree(sorted.slice(middle))] };
}
const nearest = (p, root) => {
  let best = Infinity; const pending = [root];
  while (pending.length) {
    const node = pending.pop(); if (boxDistanceSquared(p, node) >= best) continue;
    if (node.segments) for (const segment of node.segments) best = Math.min(best, pointDistanceSquared(p, segment));
    else {
      const [a, b] = node.children;
      if (boxDistanceSquared(p, a) < boxDistanceSquared(p, b)) pending.push(b, a); else pending.push(a, b);
    }
  }
  return Math.sqrt(best);
};

// Continuous-segment bounds: distance to a fixed segment set is 1-Lipschitz.
// Endpoints/midpoints supply a lower bound; (d(a)+d(b)+length)/2 supplies an
// upper bound. The BVH only accelerates exact point-to-segment distance queries.
export function boundSegmentVariation(a, b, toleranceMm) {
  assert(Number.isFinite(toleranceMm) && toleranceMm > 0 && toleranceMm <= .01);
  assert(a.length && b.length, 'Missing floating-shell geometry');
  for (const segment of [...a, ...b]) assert(segment.length === 3 && segment.slice(0, 2).every(point => point.length === 3 && point.every(Number.isFinite)) && Number.isFinite(segment[2]));
  const da = difference(a, b), db = difference(b, a); let lower = 0, upper = 0;
  for (const [changed, target] of [[da, b], [db, a]]) {
    const root = tree(target), exact = new Set(target.map(geometryKey));
    for (const segment of changed) {
      if (exact.has(geometryKey(segment))) continue;
      const [p, q] = segment, dp = nearest(p, root), dq = nearest(q, root); lower = Math.max(lower, dp, dq);
      const pending = [[p, q, dp, dq]];
      while (pending.length) {
        const [start, end, ds, de] = pending.pop(), length = Math.hypot(...end.map((value, i) => value - start[i])), bound = (ds + de + length) / 2;
        if (bound <= lower + toleranceMm) { upper = Math.max(upper, bound); continue; }
        const midpoint = start.map((value, i) => (value + end[i]) / 2), dm = nearest(midpoint, root); lower = Math.max(lower, dm);
        pending.push([start, midpoint, ds, dm], [midpoint, end, dm, de]);
      }
    }
  }
  const length = segments => segments.reduce((sum, [p, q]) => sum + Math.hypot(...q.map((value, i) => value - p[i])), 0);
  return { differingSegmentsA: da.length, differingSegmentsB: db.length, hausdorffLowerBoundMm: lower, hausdorffUpperBoundMm: Math.max(lower, upper), boundToleranceMm: toleranceMm, extrusionDeltaMm: b.reduce((sum, segment) => sum + segment[2], 0) - a.reduce((sum, segment) => sum + segment[2], 0), lengthDeltaMm: length(b) - length(a) };
}
