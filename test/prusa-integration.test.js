import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSlicerEngine } from '../src/engine.js';
import { materializePlateInputs } from '../src/plate.js';
import { runProcess } from '../src/process.js';

const command = process.env.PRUSA_SLICER_INTEGRATION_CMD;

const cubeStl = `solid cube
facet normal 0 0 -1
 outer loop
  vertex -5 -5 0
  vertex 5 5 0
  vertex 5 -5 0
 endloop
endfacet
facet normal 0 0 -1
 outer loop
  vertex -5 -5 0
  vertex -5 5 0
  vertex 5 5 0
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex -5 -5 10
  vertex 5 -5 10
  vertex 5 5 10
 endloop
endfacet
facet normal 0 0 1
 outer loop
  vertex -5 -5 10
  vertex 5 5 10
  vertex -5 5 10
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex -5 -5 0
  vertex 5 -5 0
  vertex 5 -5 10
 endloop
endfacet
facet normal 0 -1 0
 outer loop
  vertex -5 -5 0
  vertex 5 -5 10
  vertex -5 -5 10
 endloop
endfacet
facet normal 1 0 0
 outer loop
  vertex 5 -5 0
  vertex 5 5 0
  vertex 5 5 10
 endloop
endfacet
facet normal 1 0 0
 outer loop
  vertex 5 -5 0
  vertex 5 5 10
  vertex 5 -5 10
 endloop
endfacet
facet normal 0 1 0
 outer loop
  vertex 5 5 0
  vertex -5 5 0
  vertex -5 5 10
 endloop
endfacet
facet normal 0 1 0
 outer loop
  vertex 5 5 0
  vertex -5 5 10
  vertex 5 5 10
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex -5 5 0
  vertex -5 -5 0
  vertex -5 -5 10
 endloop
endfacet
facet normal -1 0 0
 outer loop
  vertex -5 5 0
  vertex -5 -5 10
  vertex -5 5 10
 endloop
endfacet
endsolid cube
`;

const readBinaryStlBounds = buffer => {
  const count = buffer.readUInt32LE(80);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let face = 0; face < count; face += 1) {
    const base = 84 + (face * 50) + 12;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = buffer.readFloatLE(base + (vertex * 12) + (axis * 4));
        bounds.min[axis] = Math.min(bounds.min[axis], value);
        bounds.max[axis] = Math.max(bounds.max[axis], value);
      }
    }
  }
  return bounds;
};

test('PrusaSlicer preserves distinct AM Pilot plate placements', { skip: !command }, async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-prusa-integration-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const sourcePath = path.join(workDir, 'cube.stl');
  await fs.writeFile(sourcePath, cubeStl);
  const config = {
    prusaSlicerCommand: command,
    jobTimeoutMs: 120_000,
    maximumLogBytes: 262_144,
    maximumModelBytes: 32 * 1024 * 1024,
    maximumTotalModelBytes: 128 * 1024 * 1024,
    maximumNormalizedModelBytes: 64 * 1024 * 1024,
    maximumTotalNormalizedBytes: 128 * 1024 * 1024,
    maximumPlateInputBytes: 192 * 1024 * 1024,
    maximumModelsPerRun: 10,
    maximumObjectsPerPlate: 10,
    maximumGcodeBytes: 64 * 1024 * 1024,
    engineThreads: 1
  };
  const source3mfPath = path.join(workDir, 'cube-source.3mf');
  await runProcess({
    command,
    args: [
      '--export-3mf',
      '--dont-arrange',
      '--no-ensure-on-bed',
      '--output', source3mfPath,
      sourcePath
    ],
    cwd: workDir,
    timeoutMs: 120_000,
    maximumLogBytes: 262_144
  });
  const inputSnapshot = {
    schema: 'am-pilot-slicer-input-snapshot',
    version: 1,
    models: [
      { modelId: 'model-1', projectFileId: 'file-1' },
      { modelId: 'model-2', projectFileId: 'file-2' }
    ],
    plate: {
      objects: [
        ...[-20, 20].map((x, index) => ({
        id: `object-${index + 1}`,
        fileId: 'file-1',
        placement: { status: 'placed' },
        transform: {
          positionMm: { x, y: 0, z: 0 },
          rotationDeg: { x: 0, y: 0, z: 0 },
          scale: { x: 1, y: 1, z: 1 }
        }
        })),
        {
          id: 'object-3mf-scaled-rotated',
          fileId: 'file-2',
          placement: { status: 'placed' },
          transform: {
            positionMm: { x: 0, y: 30, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 90 },
            scale: { x: 2, y: 1, z: 1 }
          }
        }
      ]
    }
  };
  const effectiveConfiguration = {
    coordinateMapping: {
      projectOrigin: 'center',
      engineBedOrigin: 'front_left',
      translationMm: { x: 100, y: 100, z: 0 }
    },
    prusaConfig: {
      printer_technology: 'FFF',
      gcode_flavor: 'marlin2',
      bed_shape: '0x0,200x0,200x200,0x200',
      max_print_height: 200,
      nozzle_diameter: 0.4,
      filament_diameter: 1.75,
      filament_density: 1.24,
      extrusion_multiplier: 1,
      layer_height: 0.2,
      first_layer_height: 0.2,
      perimeters: 2,
      top_solid_layers: 3,
      bottom_solid_layers: 3,
      fill_density: '15%',
      fill_pattern: 'grid',
      first_layer_temperature: 210,
      temperature: 205,
      first_layer_bed_temperature: 60,
      bed_temperature: 55,
      start_gcode: '',
      end_gcode: ''
    }
  };
  const paths = await materializePlateInputs({
    inputSnapshot,
    effectiveConfiguration,
    downloadedModels: new Map([
      ['model-1', sourcePath],
      ['model-2', source3mfPath]
    ]),
    workDir,
    config
  });
  const outputPath = path.join(workDir, 'combined.stl');
  await runProcess({
    command,
    args: ['--export-stl', '--merge', '--dont-arrange', '--no-ensure-on-bed', '--output', outputPath, ...paths],
    cwd: workDir,
    timeoutMs: 120_000,
    maximumLogBytes: 262_144
  });
  const bounds = readBinaryStlBounds(await fs.readFile(outputPath));
  assert.deepEqual(bounds, { min: [75, 95, 0], max: [125, 140, 10] });
  const result = await runSlicerEngine({
    plateInputPaths: paths,
    effectiveConfiguration,
    workDir,
    config
  });
  assert.match(await fs.readFile(result.gcodePath, 'utf8'), /generated by PrusaSlicer/i);
  assert.match(result.artifact.checksumSha256, /^[0-9a-f]{64}$/);
  assert.ok(result.artifact.sizeBytes > 0);
});
