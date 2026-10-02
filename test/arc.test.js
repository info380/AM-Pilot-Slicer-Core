import assert from 'node:assert/strict';
import test from 'node:test';
import { arcPreviewPoints, ARC_PREVIEW_TOLERANCE_MM } from '../src/arc.js';
const point = (x, y, z = 0, e = 0) => ({ x, y, z, e, feedMmPerMinute: 1200 });
test('XY arcs preserve endpoints, direction, extrusion and helix height within preview tolerance', () => {
  for (const clockwise of [false, true]) {
    const start = point(1, 0), end = point(1, 0, 0.4, 2);
    const points = arcPreviewPoints({ start, end, parameters: new Map([['I', -1], ['J', 0], ['P', 1]]), clockwise });
    assert.deepEqual(points.at(-1), end);
    assert.ok(clockwise ? points[0].y < 0 : points[0].y > 0);
    let previous = start;
    for (const p of points) {
      assert.ok(Math.abs(Math.hypot(p.x, p.y) - 1) < 1e-10);
      assert.ok(1 - Math.hypot((p.x + previous.x) / 2, (p.y + previous.y) / 2) <= ARC_PREVIEW_TOLERANCE_MM);
      assert.ok(p.z >= previous.z && p.e >= previous.e); previous = p;
    }
  }
});
test('arcs reject inconsistent radius, unsupported radius syntax and excessive turns', () => {
  for (const parameters of [new Map([['R',1]]), new Map([['I',0]]), new Map([['I',-1],['P',101]])]) {
    assert.throws(() => arcPreviewPoints({ start: point(1,0), end: point(1,0), parameters, clockwise: false }));
  }
  assert.throws(() => arcPreviewPoints({ start: point(1,0), end: point(20,0), parameters: new Map([['I',-1]]), clockwise: false }));
});
