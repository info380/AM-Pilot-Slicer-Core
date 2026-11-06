import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runSlicerEngine } from '../src/engine.js';
import { materializePlateInputs } from '../src/plate.js';
import { compileProductionToolpath } from '../src/toolpath.js';
import { runProcess } from '../src/process.js';
import { canonicalizeGcodeHeader, inspectGcode } from '../src/gcode.js';
import { readNativeStatistics } from '../src/native-feature-statistics.js';

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
      ironing: true,
      ironing_type: 'top',
      ironing_speed: 25,
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
  const nativeGcode = await fs.readFile(result.gcodePath, 'utf8');
  assert.match(nativeGcode, /generated by PrusaSlicer/i);
  assert.match(nativeGcode, /;TYPE:Ironing/);
  assert.equal(result.nativeStatistics.timeBasis,'native-normal-mode');
  assert.ok(Math.abs(result.nativeStatistics.totalTimeSeconds-result.metrics.estimatedTimeSeconds)<1.5);
  assert.ok(result.nativeStatistics.rows.some(row=>row.featureId===14&&row.timeSeconds>0&&row.filamentMassG>0));
  const preview = await compileProductionToolpath({ gcodePath: result.gcodePath, workDir,
    run: { id: 'prusa-ironing-integration', engineKey: 'fdm.am_pilot_prusa_core' },
    effectiveConfiguration, gcodeArtifact: result.artifact,
    sliceEvidenceChecksumSha256: 'a'.repeat(64), summary: result.metrics, nativeStatistics:result.nativeStatistics, maximumBytes: 16777216 });
  assert.ok(preview.header.statistics.featureRecordCounts.ironing > 0);
  assert.match(result.artifact.checksumSha256, /^[0-9a-f]{64}$/);
  assert.ok(result.artifact.sizeBytes > 0);
  inputSnapshot.plate.objects[0].printOverrides = { layer_height: 0.1, perimeters: 4, fill_density: 40 };
  const overriddenPaths = await materializePlateInputs({
    inputSnapshot, effectiveConfiguration,
    downloadedModels: new Map([['model-1', sourcePath], ['model-2', source3mfPath]]),
    workDir, config
  });
  const overridden = await runSlicerEngine({ plateInputPaths: overriddenPaths, effectiveConfiguration, workDir, config });
  const gcode = await fs.readFile(overridden.gcodePath, 'utf8');
  let z = 0, x = 0, y = 0, e = 0;
  const layers = [new Set(), new Set()];
  const lengths = [0, 0];
  for (const line of gcode.split('\n')) {
    if (/^G92 E/.test(line)) { e = Number(line.match(/E([-\d.]+)/)[1]); continue; }
    if (!/^G[01] /.test(line)) continue;
    const fields = Object.fromEntries([...line.matchAll(/([XYZE])([-\d.]+)/g)].map(match => [match[1], Number(match[2])]));
    const nextX = fields.X ?? x, nextY = fields.Y ?? y, nextZ = fields.Z ?? z, nextE = fields.E ?? e;
    if (nextE > e && Math.hypot(nextX-x, nextY-y) > 0 && nextY >= 95 && nextY <= 105 && nextZ < 2) {
      const region = nextX < 100 ? 0 : 1;
      layers[region].add(Number(nextZ.toFixed(3)));
      lengths[region] += Math.hypot(nextX-x, nextY-y);
    }
    x=nextX; y=nextY; z=nextZ; e=nextE;
  }
  assert.ok(layers[0].has(0.3), 'overridden instance has a 0.3 mm layer: ' + JSON.stringify({layers: layers.map(values => [...values]), lengths}));
  assert.ok(!layers[1].has(0.3), 'unmodified sibling retains plate layer height');
  assert.ok(lengths[0] > lengths[1] * 1.5, 'overridden instance produces denser extrusion paths');
});


// Manual qualification supplies both checksum-identified native binaries.
// This verifies that collecting statistics does not alter printable output.
test('native statistics exporter preserves stock Prusa G-code bytes', {
  skip: !command || !process.env.PRUSA_STOCK_INTEGRATION_CMD
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prusa-statistics-parity-'));
  t.after(() => fs.rm(root, {recursive:true,force:true}));
  const model = path.join(root, 'cube.stl');
  await fs.writeFile(model, cubeStl);
  for (const ironing of [false,true]) {
    const outputs = [];
    for (const [label,binary] of [['stock',process.env.PRUSA_STOCK_INTEGRATION_CMD],['candidate',command]]) {
      const workDir = path.join(root, `${label}-${ironing}`);
      await fs.mkdir(workDir);
      const output = path.join(workDir,'output.gcode');
      const configuration = path.join(workDir,'fixture.ini');
      await fs.writeFile(configuration,`layer_height = 0.2\nfilament_diameter = 1.75\nfilament_density = 1.24\nironing = ${ironing?1:0}\n`);
      await runProcess({command:binary,args:['--export-gcode','--threads','1',
        '--load',configuration,'--output',output,model],cwd:workDir,timeoutMs:120000,maximumLogBytes:262144});
      await canonicalizeGcodeHeader(output);
      outputs.push(await fs.readFile(output));
      if (label==='candidate') {
        const stats = await readNativeStatistics(output+'.am-pilot-statistics.json',false);
        const {metrics} = await inspectGcode(output,16*1024*1024);
        assert.ok(Math.abs(stats.totalTimeSeconds-metrics.estimatedTimeSeconds)<1.5);
        assert.ok(stats.rows.some(row=>row.featureId===2&&row.timeSeconds>0&&row.filamentMassG>0));
        assert.ok(Math.abs(stats.rows.filter(row=>row.featureId!=null).reduce((sum,row)=>sum+row.filamentLengthMm,0)-metrics.filamentLengthMm)<1);
        if (ironing) assert.ok(stats.rows.some(row=>row.featureId===14&&row.timeSeconds>0&&row.filamentMassG>0));
      }
    }
    assert.deepEqual(outputs[1],outputs[0],`Native exporter altered printable G-code (ironing=${ironing})`);
  }
});
