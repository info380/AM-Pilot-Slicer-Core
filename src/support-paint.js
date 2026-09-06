import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { WorkerError } from './errors.js';
import { readNormalized3mfXml } from './three-mf.js';
import { apply3mfTransform, parse3mfTransform } from './transform.js';

export { SUPPORT_PAINT_CAPABILITY } from './constants.js';
const limits = Object.freeze({ triangles: 1_000_000, bytes: 2_097_152, nodes: 262_144, depth: 16 });
const fail = message => { throw new WorkerError(message, { code: 'slicer_support_paint_invalid' }); };

// Protocol validation is deliberately repeated at the worker trust boundary.
// Only native whole-facet states and four-midpoint subdivision are admitted.
export const validateSupportPaint = (paint, { source, model }) => {
  if (paint?.schema !== 'am-pilot-support-paint' || paint.version !== 1
    || model.sourceFormat !== 'stl' || !/^[a-f0-9]{64}$/.test(paint.sourceSha256)
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

export const buildSupportPainted3mf = ({ source, model, paint, maximumUncompressedBytes }) => {
  if (!Number.isSafeInteger(maximumUncompressedBytes) || maximumUncompressedBytes <= 0) fail('A painted-model expansion limit is required.');
  const facets = validateSupportPaint(paint, { source, model });
  const positions = readPaintableStl(source);
  if (positions.length / 9 !== paint.triangleCount) fail('Support paint facet count does not match the source STL.');
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

// Normalization may repair imported meshes. Refuse a result that changed a
// source facet, its vertex order, or its paint tree instead of moving paint to
// an unrelated face. The only admitted package here is our single-mesh 3MF.
export const assertSupportPaintRoundtrip = ({ before, after, maximumUncompressedBytes }) => {
  const signature = source => {
    const xml = readNormalized3mfXml({ source, maximumUncompressedBytes });
    const attribute = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
    const items = [...xml.matchAll(/<item\b[^>]*>/g)];
    if ((xml.match(/<mesh>/g) || []).length !== 1 || items.length !== 1 || /<components\b/.test(xml)) fail('Paint normalization changed the model structure.');
    const transform = parse3mfTransform(attribute(items[0][0], 'transform'));
    const vertices = [...xml.matchAll(/<vertex\b[^>]*>/g)].map(([tag]) => {
      const coordinates = ['x','y','z'].map(key => Number(attribute(tag, key)));
      if (coordinates.some(value => !Number.isFinite(value))) fail('Invalid normalized paint coordinates.');
      const point = apply3mfTransform({ x: coordinates[0], y: coordinates[1], z: coordinates[2] }, transform);
      return [point.x, point.y, point.z].map(Math.fround).join(',');
    });
    const facets = new Map();
    for (const [tag] of xml.matchAll(/<triangle\b[^>]*>/g)) {
      const key = ['v1','v2','v3'].map(name => {
        const index = Number(attribute(tag, name));
        if (!Number.isSafeInteger(index) || !vertices[index]) fail('Invalid normalized paint facet.');
        return vertices[index];
      }).join(';');
      if (facets.has(key)) fail('Duplicate source facets cannot carry unambiguous support paint.');
      facets.set(key, attribute(tag, 'slic3rpe:custom_supports') || '');
    }
    return facets;
  };
  const expected = signature(before), actual = signature(after);
  if (expected.size !== actual.size || [...expected].some(([facet, paint]) => actual.get(facet) !== paint)) {
    fail('Normalization changed source facets or support paint. Repair the source explicitly before painting.');
  }
};
