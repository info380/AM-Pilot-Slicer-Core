import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const rounded = value => Number(value.toFixed(8));
const point = position => ['X', 'Y', 'Z'].map(axis => rounded(position[axis]));

// Compare deposited geometry independently of ordering and progress comments.
// Outer-wall path starts are compared separately: identical segment sets alone
// would miss a changed seam on a closed contour. Arcs retain their exact native
// direction, start/end and center/radius parameters; no tessellation is used.
export function summarizeToolpaths(gcode, { retainFloatingSegments = false } = {}) {
  let position = { X: 0, Y: 0, Z: 0 }, absolute = true, relativeE = false, extrusion = 0;
  let feature = 'unknown', layer = -1, boundary = true, object = null;
  const groups = new Map(), seams = [], layers = [], ironingByObject = {}, floatingSegments = {};
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; CHANGE_LAYER')) { layer++; boundary = true; }
    if (line.startsWith('; Z_HEIGHT: ')) layers.push(Number(line.slice(12)));
    if (line.startsWith('; OBJECT_ID: ')) object = line.slice(13).trim();
    if (line.startsWith('; FEATURE: ')) { feature = line.slice(11).trim(); boundary = true; }
    const words = line.split(';')[0].trim().split(/\s+/), command = words[0];
    if (command === 'G90') absolute = true;
    if (command === 'G91') absolute = false;
    if (command === 'M83') relativeE = true;
    if (command === 'M82') relativeE = false;
    assert(!['G90.1', 'G91.1', 'G18', 'G19'].includes(command), 'Unsupported arc plane/center mode');
    if (!['G0', 'G1', 'G2', 'G3', 'G92'].includes(command)) continue;
    const values = {};
    for (const word of words.slice(1).filter(word => /^[XYZEFIJKR]/.test(word))) {
      assert(/^[XYZEFIJKR][-+]?(?:\d*\.)?\d+$/.test(word), 'Unsupported native movement number: ' + word);
      assert(!(word[0] in values), 'Duplicate native movement coordinate');
      values[word[0]] = Number(word.slice(1)); assert(Number.isFinite(values[word[0]]), 'Non-finite native movement');
    }
    if (command === 'G92') {
      extrusion = values.E ?? extrusion;
      for (const axis of ['X', 'Y', 'Z']) position[axis] = values[axis] ?? position[axis];
      continue;
    }
    const end = Object.fromEntries(['X', 'Y', 'Z'].map(axis => [axis, absolute ? values[axis] ?? position[axis] : position[axis] + (values[axis] ?? 0)]));
    const deltaE = relativeE ? values.E ?? 0 : (values.E ?? extrusion) - extrusion;
    if ('E' in values) extrusion = relativeE ? extrusion + values.E : values.E;
    const moved = ['X', 'Y', 'Z'].some(axis => end[axis] !== position[axis]);
    const arc = ['G2', 'G3'].includes(command);
    if (arc) assert(['I', 'J', 'K', 'R'].some(axis => axis in values), 'Native arc lacks center/radius');
    if (layer >= 0 && deltaE > 0 && (moved || arc)) {
      const startPoint = point(position), endPoint = point(end), key = `${layer}:${feature}`;
      if (feature === 'Outer wall' && boundary) seams.push(JSON.stringify([layer, startPoint, endPoint]));
      if (feature === 'Ironing') {
        assert(object !== null, 'Ironing needs native object identity');
        const entry = ironingByObject[object] ?? { count: 0, min: [...endPoint], max: [...endPoint] };
        entry.count++;
        for (let axis = 0; axis < 3; axis++) { entry.min[axis] = Math.min(entry.min[axis], startPoint[axis], endPoint[axis]); entry.max[axis] = Math.max(entry.max[axis], startPoint[axis], endPoint[axis]); }
        ironingByObject[object] = entry;
      }
      const segments = groups.get(key) ?? [];
      const geometry = arc
        ? ['arc', command, startPoint, endPoint, Object.fromEntries(['I', 'J', 'K', 'R'].filter(axis => axis in values).map(axis => [axis, values[axis]]))]
        : ['line', [JSON.stringify(startPoint), JSON.stringify(endPoint)].sort()];
      segments.push(JSON.stringify([geometry, rounded(deltaE)]));
      if (retainFloatingSegments && feature === 'Floating vertical shell') {
        assert(!arc, 'Floating-shell distance qualification requires native lines');
        (floatingSegments[key] ??= []).push([startPoint, endPoint, rounded(deltaE)]);
      }
      groups.set(key, segments); boundary = false;
    } else if ((moved && deltaE <= 0) || deltaE < 0) boundary = true;
    position = end;
  }
  assert(layers.length > 0 && seams.length > 0, 'Missing native layer/seam evidence');
  return {
    layers,
    ironingByObject,
    ...(retainFloatingSegments ? { floatingSegments } : {}),
    outerWallStarts: { count: seams.length, sha256: hash(seams.sort()) },
    depositedFeatures: Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, segments]) => [key, {
      count: segments.length,
      sha256: hash(segments.sort())
    }]))
  };
}

export function compareToolpaths(reference, candidate) {
  const keys = new Set([...Object.keys(reference.depositedFeatures), ...Object.keys(candidate.depositedFeatures)]);
  return {
    layersMatch: JSON.stringify(reference.layers) === JSON.stringify(candidate.layers),
    seamsMatch: JSON.stringify(reference.outerWallStarts) === JSON.stringify(candidate.outerWallStarts),
    changedFeatureLayers: [...keys].filter(key => JSON.stringify(reference.depositedFeatures[key]) !== JSON.stringify(candidate.depositedFeatures[key])).sort()
  };
}
