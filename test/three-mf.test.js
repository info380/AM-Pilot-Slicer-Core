import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { buildTransformed3mf } from '../src/three-mf.js';
import { apply3mfTransform, parse3mfTransform } from '../src/transform.js';

const sourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources><object id="1" type="model"><mesh><vertices>
    <vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>
  </vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources>
  <build><item objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></build>
</model>`;

test('emits a minimal deterministic geometry-only 3MF with composed placement', () => {
  const source = zipSync({
    '3D/3dmodel.model': strToU8(sourceXml),
    'Metadata/Slic3r_PE.config': strToU8('post_process = unsafe-command')
  });
  const plate = [2, 0, 0, 0, 2, 0, 0, 0, 2, 10, 20, 0];
  const first = buildTransformed3mf({ source, objectTransform: plate });
  const second = buildTransformed3mf({ source, objectTransform: plate });
  assert.deepEqual(first, second);
  const entries = unzipSync(first);
  assert.deepEqual(Object.keys(entries).sort(), [
    '3D/3dmodel.model',
    '[Content_Types].xml',
    '_rels/.rels'
  ]);
  const xml = strFromU8(entries['3D/3dmodel.model']);
  assert.doesNotMatch(xml, /post_process/);
  const transformText = xml.match(/\btransform="([^"]+)"/)[1];
  assert.deepEqual(
    apply3mfTransform({ x: 1, y: 0, z: 0 }, parse3mfTransform(transformText)),
    { x: 22, y: 20, z: 0 }
  );
});
