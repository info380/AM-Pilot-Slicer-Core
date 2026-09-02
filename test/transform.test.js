import assert from 'node:assert/strict';
import test from 'node:test';

import {
  apply3mfTransform,
  buildPlateObjectTransform,
  multiply3mfTransforms
} from '../src/transform.js';

const mapping = {
  projectOrigin: 'center',
  engineBedOrigin: 'front_left',
  translationMm: { x: 110, y: 105, z: 0 }
};

test('maps AM Pilot center-origin placement to front-left engine coordinates', () => {
  const transform = buildPlateObjectTransform({
    transform: {
      positionMm: { x: 10, y: -5, z: 2 },
      rotationDeg: { x: 0, y: 0, z: 0 },
      scale: { x: 2, y: 3, z: 4 }
    },
    coordinateMapping: mapping
  });
  assert.deepEqual(apply3mfTransform({ x: 1, y: 2, z: 3 }, transform), {
    x: 122,
    y: 106,
    z: 14
  });
});

test('matches the viewport XYZ Euler rotation order', () => {
  const transform = buildPlateObjectTransform({
    transform: {
      positionMm: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 90 },
      scale: { x: 1, y: 1, z: 1 }
    },
    coordinateMapping: { ...mapping, translationMm: { x: 0, y: 0, z: 0 } }
  });
  const point = apply3mfTransform({ x: 1, y: 0, z: 0 }, transform);
  assert.ok(Math.abs(point.x) < 1e-10);
  assert.ok(Math.abs(point.y - 1) < 1e-10);
  assert.ok(Math.abs(point.z) < 1e-10);
});

test('composes source 3MF transforms before the plate transform', () => {
  const source = [1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 0, 0];
  const plate = [2, 0, 0, 0, 2, 0, 0, 0, 2, 10, 0, 0];
  assert.deepEqual(
    apply3mfTransform({ x: 1, y: 0, z: 0 }, multiply3mfTransforms(source, plate)),
    { x: 22, y: 0, z: 0 }
  );
});
