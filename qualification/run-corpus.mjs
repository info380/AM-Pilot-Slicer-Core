import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { runSlicerEngine, verifyPrusaSlicer } from 'file:///worker/src/engine.js';
import { materializePlateInputs } from 'file:///worker/src/plate.js';
import { runProcess } from 'file:///worker/src/process.js';

const REPORT_SCHEMA = 'am-pilot-slicer-core-corpus-report';
const REPORT_VERSION = 1;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PRUSA_SLICER = '/opt/prusa/bin/prusa-slicer';
const WORK_ROOT = '/tmp/am-pilot-slicer-qualification';
const OUTPUT_ROOT = String(process.env.QUALIFICATION_OUTPUT_DIR || '/qualification-output').trim();
const IMAGE_DIGEST = String(process.env.QUALIFICATION_IMAGE_DIGEST || '').trim().toLowerCase();
const RELEASE_TAG = String(process.env.QUALIFICATION_RELEASE_TAG || '').trim();

if (!IMAGE_DIGEST_PATTERN.test(IMAGE_DIGEST)) {
  throw new Error('QUALIFICATION_IMAGE_DIGEST must be an immutable SHA-256 OCI digest.');
}
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(RELEASE_TAG)) {
  throw new Error('QUALIFICATION_RELEASE_TAG must be a semantic release tag.');
}
if (!OUTPUT_ROOT.startsWith('/') || OUTPUT_ROOT === '/') {
  throw new Error('QUALIFICATION_OUTPUT_DIR must be a dedicated absolute directory.');
}

const cubeStl = `solid qualification_cube
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
endsolid qualification_cube
`;

const hashFile = async filePath => {
  const payload = await fs.readFile(filePath);
  return createHash('sha256').update(payload).digest('hex');
};

const directoryBytes = async directory => {
  let total = 0;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(entryPath);
    } else if (entry.isFile()) {
      try {
        total += (await fs.stat(entryPath)).size;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return total;
};

const readCgroupMetric = async metric => {
  const payload = await fs.readFile(`/sys/fs/cgroup/${metric}`, 'utf8');
  return payload.trim();
};

const readCpuUsageUsec = async () => {
  const cpuStat = await readCgroupMetric('cpu.stat');
  const match = cpuStat.match(/^usage_usec\s+(\d+)$/m);
  if (!match) throw new Error('The cgroup v2 CPU usage counter is unavailable.');
  return Number(match[1]);
};

const readMemoryBytes = async () => Number(await readCgroupMetric('memory.current'));

const runSampler = async state => {
  while (!state.stop) {
    state.memoryPeakBytes = Math.max(state.memoryPeakBytes, await readMemoryBytes());
    state.temporaryDiskPeakBytes = Math.max(state.temporaryDiskPeakBytes, await directoryBytes(WORK_ROOT));
    await delay(25);
  }
};

const engineConfig = Object.freeze({
  prusaSlicerCommand: PRUSA_SLICER,
  workRoot: WORK_ROOT,
  requestTimeoutMs: 30_000,
  jobTimeoutMs: 240_000,
  maximumLogBytes: 262_144,
  maximumModelsPerRun: 8,
  maximumObjectsPerPlate: 16,
  maximumGcodeBytes: 64 * 1024 * 1024,
  engineThreads: 1
});

const effectiveConfiguration = Object.freeze({
  coordinateMapping: Object.freeze({
    projectOrigin: 'center',
    engineBedOrigin: 'front_left',
    translationMm: Object.freeze({ x: 100, y: 100, z: 0 })
  }),
  prusaConfig: Object.freeze({
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
    perimeters: 3,
    top_solid_layers: 4,
    bottom_solid_layers: 4,
    fill_density: '20%',
    fill_pattern: 'grid',
    support_material: true,
    support_material_auto: true,
    first_layer_temperature: 240,
    temperature: 235,
    first_layer_bed_temperature: 100,
    bed_temperature: 95,
    start_gcode: '; AM_PILOT_QUALIFICATION_START\nG90\nM82',
    end_gcode: '; AM_PILOT_QUALIFICATION_END\nM104 S0\nM140 S0'
  })
});

const inputSnapshot = Object.freeze({
  schema: 'am-pilot-slicer-input-snapshot',
  version: 1,
  models: Object.freeze([
    Object.freeze({ modelId: 'qualification-stl', projectFileId: 'file-stl' }),
    Object.freeze({ modelId: 'qualification-3mf', projectFileId: 'file-3mf' })
  ]),
  plate: Object.freeze({
    objects: Object.freeze([
      Object.freeze({
        id: 'negative-origin-stl',
        fileId: 'file-stl',
        placement: Object.freeze({ status: 'placed' }),
        transform: Object.freeze({
          positionMm: Object.freeze({ x: -30, y: -20, z: 0 }),
          rotationDeg: Object.freeze({ x: 0, y: 0, z: 0 }),
          scale: Object.freeze({ x: 1, y: 1, z: 1 })
        })
      }),
      Object.freeze({
        id: 'positive-origin-duplicate',
        fileId: 'file-stl',
        placement: Object.freeze({ status: 'placed' }),
        transform: Object.freeze({
          positionMm: Object.freeze({ x: 28, y: -18, z: 0 }),
          rotationDeg: Object.freeze({ x: 0, y: 0, z: 45 }),
          scale: Object.freeze({ x: 0.8, y: 0.8, z: 0.8 })
        })
      }),
      Object.freeze({
        id: 'mixed-3mf-nonuniform-xyz',
        fileId: 'file-3mf',
        placement: Object.freeze({ status: 'placed' }),
        transform: Object.freeze({
          positionMm: Object.freeze({ x: 0, y: 32, z: 5 }),
          rotationDeg: Object.freeze({ x: 25, y: 10, z: 15 }),
          scale: Object.freeze({ x: 1.25, y: 0.75, z: 1.1 })
        })
      })
    ])
  })
});

await fs.mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 });
await fs.rm(WORK_ROOT, { recursive: true, force: true });
await fs.mkdir(WORK_ROOT, { recursive: true, mode: 0o700 });

const sourceRoot = path.join(WORK_ROOT, 'source');
const runRoot = path.join(WORK_ROOT, 'run');
await fs.mkdir(sourceRoot, { recursive: true, mode: 0o700 });
await fs.mkdir(runRoot, { recursive: true, mode: 0o700 });
const stlPath = path.join(sourceRoot, 'qualification-cube.stl');
const threeMfPath = path.join(sourceRoot, 'qualification-cube.3mf');
await fs.writeFile(stlPath, cubeStl, { mode: 0o600 });
await runProcess({
  command: PRUSA_SLICER,
  args: [
    '--export-3mf',
    '--dont-arrange',
    '--no-ensure-on-bed',
    '--config-compatibility', 'disable',
    '--output', threeMfPath,
    stlPath
  ],
  cwd: sourceRoot,
  timeoutMs: engineConfig.jobTimeoutMs,
  maximumLogBytes: engineConfig.maximumLogBytes
});

const state = { stop: false, memoryPeakBytes: 0, temporaryDiskPeakBytes: 0 };
const cpuStartUsec = await readCpuUsageUsec();
const sampler = runSampler(state);
const attempts = [];
let prusaVersion = '';

try {
  prusaVersion = await verifyPrusaSlicer(engineConfig);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    for (const entry of await fs.readdir(runRoot)) {
      await fs.rm(path.join(runRoot, entry), { recursive: true, force: true });
    }
    const plateInputPaths = await materializePlateInputs({
      inputSnapshot,
      effectiveConfiguration,
      downloadedModels: new Map([
        ['qualification-stl', stlPath],
        ['qualification-3mf', threeMfPath]
      ]),
      workDir: runRoot,
      config: engineConfig
    });
    const result = await runSlicerEngine({
      plateInputPaths,
      effectiveConfiguration,
      workDir: runRoot,
      config: engineConfig
    });
    const gcode = await fs.readFile(result.gcodePath, 'utf8');
    if (!/generated by PrusaSlicer 2\.9\.3/i.test(gcode)) {
      throw new Error('Generated G-code does not identify PrusaSlicer 2.9.3.');
    }
    if (!gcode.includes('AM_PILOT_QUALIFICATION_START') || !gcode.includes('AM_PILOT_QUALIFICATION_END')) {
      throw new Error('Generated G-code did not preserve the required start/end G-code markers.');
    }
    if (!Number.isInteger(result.metrics.layerCount) || result.metrics.layerCount <= 0) {
      throw new Error('Generated G-code did not report a positive layer count.');
    }
    const evidencePath = path.join(OUTPUT_ROOT, `mixed-corpus-attempt-${attempt}.gcode`);
    await fs.copyFile(result.gcodePath, evidencePath);
    attempts.push(Object.freeze({
      attempt,
      gcodeFile: path.basename(evidencePath),
      checksumSha256: await hashFile(evidencePath),
      sizeBytes: result.artifact.sizeBytes,
      metrics: result.metrics,
      warningCount: result.warnings.length
    }));
  }
} finally {
  state.stop = true;
  await sampler;
}

if (attempts[0].checksumSha256 !== attempts[1].checksumSha256) {
  throw new Error('The repeated canonical corpus slice produced different G-code checksums.');
}

const cgroupMemoryPeakBytes = Number(await readCgroupMetric('memory.peak'));
if (!Number.isSafeInteger(cgroupMemoryPeakBytes) || cgroupMemoryPeakBytes <= 0) {
  throw new Error('The cgroup v2 peak-memory counter is invalid.');
}
const report = Object.freeze({
  schema: REPORT_SCHEMA,
  version: REPORT_VERSION,
  status: 'passed',
  generatedAt: new Date().toISOString(),
  release: Object.freeze({
    tag: RELEASE_TAG,
    image: 'ghcr.io/info380/am-pilot-slicer-core',
    imageDigest: IMAGE_DIGEST,
    prusaVersion
  }),
  corpus: Object.freeze({
    source: 'synthetic-non-customer',
    inputFormats: Object.freeze(['stl', '3mf']),
    duplicateObjects: true,
    mixedPlate: true,
    negativeAndPositiveCenterCoordinates: true,
    nonUniformScale: true,
    xyzRotation: true,
    supportsEnabled: true,
    materialOverrides: true,
    machineDialect: 'marlin2',
    customStartAndEndGcode: true,
    deterministicRepeat: true
  }),
  resources: Object.freeze({
    cgroupMemoryPeakBytes,
    sampledMemoryPeakBytes: state.memoryPeakBytes,
    cpuUsageUsec: (await readCpuUsageUsec()) - cpuStartUsec,
    temporaryDiskPeakBytes: state.temporaryDiskPeakBytes,
    sourceBytes: (await fs.stat(stlPath)).size + (await fs.stat(threeMfPath)).size,
    gcodeBytes: attempts[0].sizeBytes
  }),
  attempts: Object.freeze(attempts)
});

await fs.writeFile(path.join(OUTPUT_ROOT, 'corpus-report.json'), `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600
});
process.stdout.write(`${JSON.stringify(report)}\n`);
