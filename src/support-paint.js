import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { WorkerError } from './errors.js';
import { flattenSource } from './advanced-three-mf.js';
import { readNormalized3mfXml } from './three-mf.js';
import { IDENTITY_3MF_TRANSFORM, parse3mfTransform } from './transform.js';

export { SUPPORT_PAINT_CAPABILITY } from './constants.js';
const limits = Object.freeze({ triangles: 1_000_000, bytes: 2_097_152, nodes: 262_144, depth: 16 });
const fail = message => { throw new WorkerError(message, { code: 'slicer_support_paint_invalid' }); };

// Protocol validation is deliberately repeated at the worker trust boundary.
// Only native whole-facet states and four-midpoint subdivision are admitted.
export const validateSupportPaint = (paint, { source, model }) => {
  const is3mf = model.sourceFormat === '3mf';
  if (paint?.schema !== 'am-pilot-support-paint'
    || (is3mf ? paint.version !== 2 : model.sourceFormat !== 'stl' || paint.version !== 1)
    || !/^[a-f0-9]{64}$/.test(paint.sourceSha256)
    || paint.sourceSha256 !== model.checksumSha256
    || createHash('sha256').update(source).digest('hex') !== paint.sourceSha256
    || !Number.isSafeInteger(paint.triangleCount) || paint.triangleCount < 1 || paint.triangleCount > limits.triangles
    || typeof paint.data !== 'string' || paint.data.length > limits.bytes) fail('Support paint does not match its source evidence.');
  const facets = new Map();
  let last = -1, nodes = 0;
  for (const line of paint.data ? paint.data.split('\n') : []) {
    const match = /^(0|[1-9][0-9]*):([0348]+)$/.exec(line);
    if (!match || Number(match[1]) <= last || Number(match[1]) >= paint.triangleCount || match[2] === '0') fail('Invalid painted facet record.');
    last = Number(match[1]);
    let offset = match[2].length - 1;
    const read = depth => {
      if (++nodes > limits.nodes || depth > limits.depth) fail('Support paint exceeds the subdivision limit.');
      const token = match[2][offset--];
      if (token === '3') { for (let i = 0; i < 4; i++) read(depth + 1); }
      else if (!['0','4','8'].includes(token)) fail('Invalid support paint tree.');
    };
    read(0);
    if (offset !== -1) fail('Trailing support paint data.');
    facets.set(last, match[2]);
  }
  if (is3mf && (!Array.isArray(paint.facetCoordinates) || paint.facetCoordinates.length !== facets.size
    || paint.facetCoordinates.some(facet => !Array.isArray(facet) || facet.length !== 9
      || facet.some(coordinate => !Number.isFinite(coordinate) || Math.fround(coordinate) !== coordinate))
    || paint.data.length + JSON.stringify(paint.facetCoordinates).length > limits.bytes)) {
    fail('3MF support paint has invalid facet evidence.');
  }
  if (!is3mf && Object.hasOwn(paint, 'facetCoordinates')) fail('Unexpected facet coordinates for STL paint.');
  return facets;
};

export const readPaintableStl = source => {
  const buffer = Buffer.from(source);
  if (buffer.length < 84) fail('Invalid paint source STL.');
  const count = buffer.readUInt32LE(80), expected = 84 + count * 50;
  const positions = [];
  if (expected === buffer.length || (!buffer.toString('utf8', 0, 80).trimStart().startsWith('solid') && expected <= buffer.length)) {
    if (count < 1 || count > limits.triangles) fail('Paint source triangle limit exceeded.');
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < 9; j++) positions.push(buffer.readFloatLE(84 + i * 50 + 12 + j * 4));
    }
  } else {
    // Match source facet order, with no repair, triangulation, welding or reindexing.
    const text = buffer.toString('utf8');
    if (!text.trimStart().startsWith('solid')) fail('Invalid paint source STL.');
    for (const facet of text.matchAll(/facet\s+normal\s+[^\r\n]+\r?\n([\s\S]*?)endfacet/g)) {
      const vertices = [...facet[1].matchAll(/\bvertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/g)];
      if (vertices.length !== 3) fail('Paint source facet is malformed.');
      for (const vertex of vertices) for (let j = 1; j <= 3; j++) positions.push(Math.fround(Number(vertex[j])));
      if (positions.length / 9 > limits.triangles) fail('Paint source triangle limit exceeded.');
    }
  }
  if (!positions.length || positions.some(value => !Number.isFinite(value))) fail('Paint source contains invalid coordinates.');
  for (let i = 0; i < positions.length; i += 9) {
    const u = [0,1,2].map(j => positions[i + 3 + j] - positions[i + j]);
    const v = [0,1,2].map(j => positions[i + 6 + j] - positions[i + j]);
    if (Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]) === 0) fail('Degenerate source facets cannot carry support paint.');
  }
  return positions;
};

const vertexKeys = vertices => [0, 3, 6].map(i => vertices.slice(i, i + 3).join(','));
const facetKey = keys => [...keys].sort().join(';');
const centroid = coordinates => [0, 1, 2].map(axis =>
  (coordinates[axis] + coordinates[axis + 3] + coordinates[axis + 6]) / 3);

const matchPaintedFacets = ({ normalizedSource, paint, annotations, maximumUncompressedBytes }) => {
  if (!normalizedSource) fail('3MF paint requires verified normalized source geometry.');
  const {vertices, triangles} = flattenSource(normalizedSource, IDENTITY_3MF_TRANSFORM, maximumUncompressedBytes);
  if (triangles.length !== paint.triangleCount) fail('3MF normalization changed the number of source facets.');

  // The native normalizer recenters float32 vertices and serializes the frame
  // translation with max_digits10. Bound the frame's forward roundoff from
  // its coordinate range. This bound is for matching only: the emitted
  // geometry comes from the worker's normalized archive.
  let magnitude = 0;
  for (const {x, y, z} of vertices) magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y), Math.abs(z));
  const float32UnitRoundoff = 2 ** -24;
  const roundoff = 4 * float32UnitRoundoff * magnitude;
  if (!(roundoff > 0 && Number.isFinite(roundoff))) fail('3MF paint has no valid normalized coordinate frame.');
  const cellSize = 2 * roundoff;
  const cell = coordinates => centroid(coordinates).map(value => Math.floor(value / cellSize));
  const buckets = new Map(), sourceFacets = new Set();
  for (const [i, annotation] of [...annotations.values()].entries()) {
    const coordinates = paint.facetCoordinates[i];
    const keys = vertexKeys(coordinates);
    const key = facetKey(keys);
    if (new Set(keys).size !== 3 || sourceFacets.has(key)) fail('3MF paint references an ambiguous source facet.');
    sourceFacets.add(key);
    const bucket = cell(coordinates).join(',');
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket).push({ coordinates, annotation, matched: false });
  }

  const positions = new Float32Array(triangles.length * 9);
  const facets = new Map();
  let comparisons = 0;
  for (const [index, triangle] of triangles.entries()) {
    const coordinates = triangle.indices.flatMap(i => {
      const {x, y, z} = vertices[i];
      return [x, y, z].map(Math.fround);
    });
    if (coordinates.some(coordinate => !Number.isFinite(coordinate)) || new Set(vertexKeys(coordinates)).size !== 3) {
      fail('3MF normalization produced an invalid facet.');
    }
    const [x, y, z] = cell(coordinates);
    let match;
    for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
      const candidates = buckets.get([x + dx, y + dy, z + dz].join(',')) || [];
      for (const target of candidates) {
        if (++comparisons > limits.nodes + limits.triangles) fail('3MF paint exceeds the facet matching budget.');
        for (const offset of [0, 3, 6]) {
          if (target.coordinates.some((value, axis) => Math.abs(value - coordinates[(offset + axis) % 9]) > roundoff)) continue;
          if (match || target.matched) fail('3MF normalization produced an ambiguous match for a painted facet.');
          match = { target, offset };
        }
      }
    }
    // Start a matched facet at the same vertex used by the viewport. Only
    // cyclic permutations preserve winding and annotation subdivision.
    if (match) {
      const {target, offset} = match;
      positions.set([...coordinates.slice(offset), ...coordinates.slice(0, offset)], index * 9);
      target.matched = true;
      facets.set(index, target.annotation);
    } else positions.set(coordinates, index * 9);
  }
  if (facets.size !== annotations.size) fail('3MF normalization could not verify every painted facet.');
  return {positions, facets};
};

export const buildSupportPainted3mf = ({ source, normalizedSource, model, paint, maximumUncompressedBytes }) => {
  if (!Number.isSafeInteger(maximumUncompressedBytes) || maximumUncompressedBytes <= 0) fail('A painted-model expansion limit is required.');
  const annotations = validateSupportPaint(paint, { source, model });
  const { positions, facets } = model.sourceFormat === '3mf'
    ? matchPaintedFacets({ normalizedSource, paint, annotations, maximumUncompressedBytes })
    : { positions: readPaintableStl(source), facets: annotations };
  if (positions.length / 9 !== paint.triangleCount) fail('Support paint facet count does not match the source mesh.');
  const vertices = [], triangles = [], byPosition = new Map();
  let bytes = 2048;
  const append = (target, value) => {
    bytes += value.length;
    if (bytes > maximumUncompressedBytes) fail('Painted model exceeds the qualified expansion limit.');
    target.push(value);
  };
  for (let i = 0; i < positions.length; i += 9) {
    const indices = [];
    for (let j = 0; j < 9; j += 3) {
      const [x,y,z] = positions.slice(i + j, i + j + 3), key = `${x},${y},${z}`;
      if (!byPosition.has(key)) {
        byPosition.set(key, vertices.length);
        append(vertices, `<vertex x="${x}" y="${y}" z="${z}"/>`);
      }
      indices.push(byPosition.get(key));
    }
    const annotation = facets.get(i / 9);
    append(triangles, `<triangle v1="${indices[0]}" v2="${indices[1]}" v3="${indices[2]}"${annotation ? ` slic3rpe:custom_supports="${annotation}"` : ''}/>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">
<metadata name="slic3rpe:Version3mf">1</metadata><metadata name="slic3rpe:FdmSupportsPaintingVersion">1</metadata>
<resources><object id="1" type="model"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  const entry = value => [strToU8(value), { level: 6, mtime: new Date('1980-01-01T00:00:00.000Z') }];
  return zipSync({
    '3D/3dmodel.model': entry(xml),
    '[Content_Types].xml': entry('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': entry('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
  });
};

// The native importer centers float32 mesh vertices around their bounding box,
// retaining the double-precision center in the build translation. Comparing
// world-space strings after adding that translation back loses float32 bits.
// Compare in the native local frame instead, reproducing the exact float32
// subtraction and native 3MF max_digits10 serialization (9 significant digits).
// No geometric epsilon, nearest-facet remapping, repair or paint loss is allowed.
export const assertSupportPaintRoundtrip = ({ before, after, maximumUncompressedBytes }) => {
  const read = source => {
    const xml = readNormalized3mfXml({ source, maximumUncompressedBytes });
    const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
    const items = [...xml.matchAll(/<item\b[^>]*>/g)];
    if ((xml.match(/<mesh>/g) || []).length !== 1 || items.length !== 1 || /<components\b/.test(xml)) fail('Paint normalization changed the model structure.');
    const transform = parse3mfTransform(attribute(items[0][0], 'transform'));
    const vertices = [...xml.matchAll(/<vertex\b[^>]*>/g)].map(([tag]) => {
      const coordinates = ['x','y','z'].map(key => Number(attribute(tag, key)));
      if (coordinates.some(value => !Number.isFinite(value))) fail('Invalid normalized paint coordinates.');
      return coordinates.map(Math.fround);
    });
    return { xml, vertices, transform, attribute };
  };
  const original = read(before), normalized = read(after);
  if (original.transform.some((value, index) => value !== IDENTITY_3MF_TRANSFORM[index])) fail('Paint source must use its original coordinate frame.');
  const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
  for (const vertex of original.vertices) vertex.forEach((value, axis) => {
    minimum[axis] = Math.min(minimum[axis], value);
    maximum[axis] = Math.max(maximum[axis], value);
  });
  const center = minimum.map((value, axis) => (value + maximum[axis]) / 2);
  const nativeTransform = [...IDENTITY_3MF_TRANSFORM.slice(0, 9), ...center.map(value => Number(value.toPrecision(9)))];
  const unchangedFrame = normalized.transform.every((value, index) => value === IDENTITY_3MF_TRANSFORM[index]);
  if (!unchangedFrame && normalized.transform.some((value, index) => value !== nativeTransform[index])) {
    fail('Paint normalization changed the source coordinate frame.');
  }
  const expectedVertices = unchangedFrame ? original.vertices : original.vertices.map(vertex =>
    vertex.map((value, axis) => Math.fround(value - Math.fround(center[axis]))));
  const signature = ({ xml, attribute }, vertices) => {
    const facets = new Map();
    for (const [tag] of xml.matchAll(/<triangle\b[^>]*>/g)) {
      const key = ['v1','v2','v3'].map(name => {
        const index = Number(attribute(tag, name));
        if (!Number.isSafeInteger(index) || !vertices[index]) fail('Invalid normalized paint facet.');
        return vertices[index].join(',');
      }).join(';');
      if (facets.has(key)) fail('Duplicate source facets cannot carry unambiguous support paint.');
      facets.set(key, attribute(tag, 'slic3rpe:custom_supports') || '');
    }
    return facets;
  };
  const expected = signature(original, expectedVertices), actual = signature(normalized, normalized.vertices);
  if (expected.size !== actual.size || [...expected].some(([facet, paint]) => actual.get(facet) !== paint)) {
    fail('Normalization changed source facets or support paint. Repair the source explicitly before painting.');
  }
};
