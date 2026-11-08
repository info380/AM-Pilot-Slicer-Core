import { createExecutionProfile } from '../src/execution-profile.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync, unzlibSync } from 'fflate';
import { createHash } from 'node:crypto';
import { createBambuThumbnailScene } from '../src/bambu-thumbnail-renderer.js';
import { buildAdvancedPlate3mf } from '../src/advanced-three-mf.js';
import { IDENTITY_3MF_TRANSFORM } from '../src/transform.js';
import { finalizeBambuArchiveThumbnail } from '../src/bambu-plate-thumbnail.js';
import { buildSliceEvidenceChecksum } from '../src/manifest.js';
import { BAMBU_ENGINE_KEY, BAMBU_STUDIO_VERSION, assertBambuEffectiveConfiguration, inspectBambuOutput, runBambuEngine, verifyBambuStudio } from '../src/bambu-engine.js';
import { compileProductionToolpath } from '../src/toolpath.js';
import { resolveBambuPreset } from '../src/bambu-presets.js';

const machine = { type: 'machine', name: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'], nozzle_volume_type:['Standard'] };
const filament = { type: 'filament', name: 'PLA', filament_diameter: ['1.75'], filament_type: ['PLA'], filament_colour:['#AABBCC'], compatible_printers: [machine.name] };
const processPreset = { type: 'process', name: 'Standard', compatible_printers: [machine.name], curr_bed_type: 'Textured PEI Plate' };
const configuration = () => ({ engineAdapter: BAMBU_ENGINE_KEY, bambuConfig: { version: 1, machine: structuredClone(machine), filament: structuredClone(filament), process: structuredClone(processPreset) } });
const limits = { maximumArchiveBytes: 1024 * 1024, maximumExpandedBytes: 1024 * 1024, maximumGcodeBytes: 1024 * 1024 };
const gcode = strToU8(`; BambuStudio ${BAMBU_STUDIO_VERSION}\nG1 X1 Y2 E1\n`);
const archive = (settings = { printer_model: machine.printer_model, nozzle_diameter: ['0.4'], filament_type: ['PLA'] }, extra = {}) => zipSync({
  'Metadata/project_settings.config': strToU8(JSON.stringify(settings)), 'Metadata/plate_1.gcode': gcode, ...extra
});
const inspect = (bytes, other = {}) => inspectBambuOutput({ bytes, machine, filament, ...limits, ...other });

test('Bambu requires fully resolved compatible single-filament presets and an explicit plate', () => {
  assert.doesNotThrow(() => assertBambuEffectiveConfiguration(configuration()));
  for (const mutate of [c => c.bambuConfig.machine.nozzle_volume_type = [], c => delete c.bambuConfig.filament.filament_colour, c => c.bambuConfig.filament.filament_colour=['bad'], c => c.bambuConfig.machine.inherits = 'base', c => c.bambuConfig.filament.compatible_printers = [],
    c => c.bambuConfig.process.post_process = ['curl secret'], c => c.bambuConfig.machine.print_host = 'https://printer',
    c => c.bambuConfig.process.curr_bed_type = '', c => c.bambuConfig.filament.filament_type = ['PLA', 'PETG'],
    c => c.bambuConfig.machine.printer_model = 'Unqualified model', c => c.engineAdapter = 'fdm.am_pilot_prusa_core']) {
    const c = configuration(); mutate(c); assert.throws(() => assertBambuEffectiveConfiguration(c));
  }
});
test('Bambu archive binds G-code bytes to exact model, nozzle, filament and one plate', () => {
  const result = inspect(archive());
  assert.deepEqual(result.gcode, gcode);
  assert.equal(result.archiveArtifact.checksumSha256.length, 64);
  assert.throws(() => inspect(archive({ printer_model: 'Bambu Lab A2L', nozzle_diameter: ['0.4'], filament_type: ['PLA'] })), /does not match/);
  assert.throws(() => inspect(archive(undefined, { 'Metadata/plate_2.gcode': gcode })), /exactly one plate/);
  assert.throws(() => inspect(archive(undefined, { '../escape': gcode })), /limits/);
  assert.throws(() => inspect(archive(undefined, { 'metadata/PLATE_1.GCODE': gcode })), /limits/);
  assert.throws(() => inspect(archive(), { maximumExpandedBytes: 5 }), /limits/);
  assert.throws(() => inspect(archive(), { maximumArchiveBytes: 5 }), /byte limit/);
  assert.throws(() => inspect(archive(), { maximumGcodeBytes: 5 }), /byte limit/);
  assert.throws(() => inspect(new Uint8Array([0, 0])), /invalid archive/);
});
const coverVertices = [[50,60,0],[60,60,0],[50,70,0],[60,70,0],[50,60,5],[60,60,5],[50,70,5],[60,70,5]];
const coverTriangles = [[0,2,1],[1,2,3],[4,5,6],[5,7,6],[0,1,4],[1,5,4],[2,6,3],[3,6,7],[0,4,2],[2,4,6],[1,3,5],[3,7,5]];
const coverSource = zipSync({'3D/3dmodel.model':strToU8(
  '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>'
  + coverVertices.map(([x,y,z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')
  + '</vertices><triangles>' + coverTriangles.map(([v1,v2,v3]) => `<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`).join('')
  + '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>'
)});
const prepareCover = ({modifiers=[], offset=0, instances=1}={}) => {
  const scene = createBambuThumbnailScene();
  const sources = Array.from({length:instances}, (_, index) => ({
    source:coverSource, object:{name:'Thumbnail fixture',definitionId:'linked',modifiers},
    objectTransform:[...IDENTITY_3MF_TRANSFORM.slice(0,9),index*offset,0,0]
  }));
  const prepared = buildAdvancedPlate3mf({sources,bambu:true,maximumUncompressedBytes:1048576,
    maximumSourceUncompressedBytes:1048576,onBambuMesh:scene.addInstance});
  return {prepared,scene};
};

test('Bambu device archive embeds shaded model covers without changing print bytes', async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-thumbnail-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const gcodePath = path.join(workDir, 'output.gcode');
  const archivePath = path.join(workDir, 'output.gcode.3mf');
  const toolpath = strToU8([
    `; BambuStudio ${BAMBU_STUDIO_VERSION}`, 'M83', '; CHANGE_LAYER', '; Z_HEIGHT: 0.2', '; LAYER_HEIGHT: 0.2',
    '; FEATURE: Outer wall', '; LINE_WIDTH: 0.4', 'G1 X20 Y30 F3000', 'G1 X35 Y30 E0.5',
    'G1 X35 Y45 E0.5', 'G1 X20 Y45 E0.5', 'G1 X20 Y30 E0.5', 'G1 X300 Y300 F6000'
  ].join('\n'));
  const metadata = '<config><plate><metadata key="gcode_file" value="Metadata/plate_1.gcode"/></plate></config>';
  const original = archive(undefined, {
    'Metadata/plate_1.gcode': toolpath,
    'Metadata/model_settings.config': strToU8(metadata),
    'Metadata/slice_info.config': strToU8('<config/>')
  });
  await fs.writeFile(gcodePath, toolpath);
  await fs.writeFile(archivePath, original);
  const run = { id: 'thumbnail-fixture', engineKey: BAMBU_ENGINE_KEY };
  const result = {
    artifact: { checksumSha256: createHash('sha256').update(toolpath).digest('hex') },
    archiveArtifact: inspect(original).archiveArtifact, metrics: { layerCount: 1 }, warnings: []
  };
  const {scene} = prepareCover();
  const images = await scene.render({filamentColor:filament.filament_colour[0]});
  const region = {id:'region',name:'Large unprinted volume',shape:'box',sizeMm:{x:100,y:100,z:100},
    transform:{positionMm:{x:50,y:60,z:5},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},printOverrides:{fill_density:40}};
  assert.deepEqual(await prepareCover({modifiers:[region]}).scene.render({filamentColor:filament.filament_colour[0]}),images,
    'modifier volumes are excluded and identical geometry produces identical images');
  const linked = await prepareCover({offset:25,instances:2}).scene.render({filamentColor:filament.filament_colour[0]});
  assert.notDeepEqual(linked,images,'the translated linked copy is included in the cover');
  result.archiveArtifact = await finalizeBambuArchiveThumbnail({
    images,archivePath,archiveArtifact:result.archiveArtifact,
    maximumArchiveBytes:limits.maximumArchiveBytes,maximumExpandedBytes:limits.maximumExpandedBytes
  });
  const preview = await compileProductionToolpath({gcodePath,workDir,run,gcodeArtifact:result.artifact,
    effectiveConfiguration:{...configuration(),coordinateMapping:{projectOrigin:'center',translationMm:{x:128,y:128,z:0}}},
    maximumBytes:1024*1024,summary:result.metrics,sliceEvidenceChecksumSha256:buildSliceEvidenceChecksum({run,result})
  });
  const bytes = await fs.readFile(archivePath);
  const entries = unzipSync(bytes);
  const before = unzipSync(original);
  for (const name of Object.keys(before).filter(name => name !== 'Metadata/model_settings.config')) assert.deepEqual(entries[name], before[name], name);
  assert.match(strFromU8(entries['Metadata/model_settings.config']), /key="thumbnail_file" value="Metadata\/plate_1\.png"/);
  for (const [name, width] of [['Metadata/plate_1.png', 512], ['Metadata/plate_1_small.png', 128]]) {
    const png = Buffer.from(entries[name]);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), width);
    const raster = unzlibSync(png.subarray(41, 41 + png.readUInt32BE(33)));
    const stride = 1 + width * 4;
    assert.equal(raster.length, stride * width);
    let covered = 0, left = width, right = 0;
    const shades = new Set();
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const pixel = y * stride + x * 4 + 1;
      if (!raster[pixel+3]) continue;
      covered++;
      left = Math.min(left,x);
      right = Math.max(right,x);
      shades.add(raster[pixel]);
    }
    assert.ok(covered > width, 'the image contains visible model surfaces');
    assert.ok(shades.size > 2, 'the model has surface shading at this size');
    assert.ok(right - left > width / 2, 'travel does not shrink the model to a corner');
  }
  assert.deepEqual(inspect(bytes).archiveArtifact, result.archiveArtifact);
  assert.equal(preview.header.source.sliceEvidenceChecksumSha256, buildSliceEvidenceChecksum({ run, result }));
});

test('offline preset resolver rejects traversal and inheritance cycles', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-preset-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'machine'));
  await fs.writeFile(path.join(root, 'machine', 'child.json'), JSON.stringify({ inherits: 'base', name: 'child', nozzle_diameter: ['0.4'] }));
  await fs.writeFile(path.join(root, 'machine', 'base.json'), JSON.stringify({ type: 'machine', printer_model: 'Bambu Lab A1' }));
  const resolved = await resolveBambuPreset({ resourceRoot: root, kind: 'machine', name: 'child' });
  assert.equal(resolved.settings.printer_model, 'Bambu Lab A1'); assert.equal(resolved.settings.inherits, undefined); assert.equal(resolved.sources.length, 2);
  await assert.rejects(resolveBambuPreset({ resourceRoot: root, kind: 'machine', name: '../escape' }));
  await fs.writeFile(path.join(root, 'machine', 'base.json'), JSON.stringify({ inherits: 'child' }));
  await assert.rejects(resolveBambuPreset({ resourceRoot: root, kind: 'machine', name: 'child' }), /inheritance/);
});

const command = process.env.BAMBU_STUDIO_INTEGRATION_CMD;
const resources = process.env.BAMBU_STUDIO_INTEGRATION_RESOURCES;
for (const model of ['A1', 'A2L']) for (const nozzle of ['0.2', '0.4', '0.6', '0.8']) {
test(`real Bambu engine preserves ${model} ${nozzle} mm archive and preview placement`, { skip: !command || !resources }, async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-engine-')); t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const machineName = `Bambu Lab ${model} ${nozzle} nozzle`;
  const presets = { machine: (await resolveBambuPreset({ resourceRoot: resources, kind: 'machine', name: machineName })).settings };
  for (const [kind, name] of [['process', presets.machine.default_print_profile], ['filament', `Generic PLA @BBL ${model}${nozzle === '0.2' ? ' 0.2 nozzle' : ''}`]]) {
    presets[kind] = (await resolveBambuPreset({ resourceRoot: resources, kind, name })).settings;
  }
  presets.machine.nozzle_volume_type=[...presets.machine.default_nozzle_volume_type];
  presets.filament.filament_colour=['#AABBCC'];
  presets.process.curr_bed_type = 'Textured PEI Plate';
  presets.process.ironing_type = 'top';
  presets.process.ironing_flow = '15%';
  presets.process.ironing_speed = '25';
  const {prepared,scene} = prepareCover();
  const platePath = path.join(workDir, 'plate.3mf');
  await fs.writeFile(platePath, prepared);
  const config = { bambuStudioCommand: command, workRoot: workDir, requestTimeoutMs: 30000, jobTimeoutMs: 120000,
    maximumLogBytes: 262144, maximumPlateInputBytes:16777216, engineThreads:1, engineCpuAffinity:process.env.SLICER_TEST_CPU_AFFINITY||'none', maximumArchiveBytes: 8388608, maximumExpandedArchiveBytes: 16777216, maximumGcodeBytes: 8388608 };
  await verifyBambuStudio(config);
  const profile = createExecutionProfile();
  const result = await runBambuEngine({ profile, config, workDir, plateInputPaths: [platePath], effectiveConfiguration: { engineAdapter: BAMBU_ENGINE_KEY, bambuConfig: { version: 1, ...presets } } });
  assert.deepEqual(profile.completedPhases, ['presetPreparation', 'machineProjectPreparation', 'slicingProgress', 'affinitySetup', 'nativeSubprocess', 'validationProgress', 'archiveValidation', 'gcodeInspection']);
  assert.ok(Object.values(profile.timingsMs).every(value => Number.isFinite(value) && value >= 0));
  assert.equal(result.profile, undefined);
  assert.ok(result.metrics.estimatedTimeSeconds > 0); assert.ok(result.metrics.layerCount > 0);
  assert.ok(result.metrics.filamentLengthMm > 0);
  const text = await fs.readFile(result.gcodePath, 'utf8');
  assert.match(text, /; FEATURE: Ironing/);
  const walls = [...text.matchAll(/; FEATURE: Outer wall\n([\s\S]*?)(?=; WIPE_START|; FEATURE:|$)/g)].map(m => m[1]).join('\n');
  const xs = [...walls.matchAll(/\bX(-?[0-9.]+)/g)].map(m => Number(m[1]));
  const ys = [...walls.matchAll(/\bY(-?[0-9.]+)/g)].map(m => Number(m[1]));
  assert.ok(xs.length > 20 && ys.length > 20);
  assert.ok(Math.min(...xs) >= 50 && Math.max(...xs) <= 60, 'X placement preserved');
  assert.ok(Math.min(...ys) >= 60 && Math.max(...ys) <= 70, 'Y placement preserved');
  const inspected = inspectBambuOutput({ bytes: new Uint8Array(await fs.readFile(result.archivePath)), machine: presets.machine, filament: presets.filament,
    maximumArchiveBytes: config.maximumArchiveBytes, maximumExpandedBytes: config.maximumExpandedArchiveBytes, maximumGcodeBytes: config.maximumGcodeBytes });
  assert.deepEqual(Buffer.from(inspected.gcode), await fs.readFile(result.gcodePath));
  const run = { id: 'bambu-integration', engineKey: BAMBU_ENGINE_KEY };
  const finalArchive = await finalizeBambuArchiveThumbnail({
    images:await scene.render({filamentColor:presets.filament.filament_colour[0]}),archivePath:result.archivePath,
    archiveArtifact:result.archiveArtifact,maximumArchiveBytes:config.maximumArchiveBytes,maximumExpandedBytes:config.maximumExpandedArchiveBytes
  });
  const preview = await compileProductionToolpath({ gcodePath: result.gcodePath, workDir, run,
    effectiveConfiguration: { engineAdapter: BAMBU_ENGINE_KEY, bambuConfig: { version: 1, ...presets },
      coordinateMapping: { projectOrigin: 'center', translationMm: { x: 128, y: 128, z: 0 } } },
    gcodeArtifact: result.artifact, summary: result.metrics, nativeStatistics:result.nativeStatistics, maximumBytes: 16777216,
    sliceEvidenceChecksumSha256:buildSliceEvidenceChecksum({run,result:{...result,archiveArtifact:finalArchive}})
  });
  const printable = await fs.readFile(result.archivePath);
  const packaged = inspectBambuOutput({ bytes: printable, machine: presets.machine, filament: presets.filament,
    maximumArchiveBytes: config.maximumArchiveBytes, maximumExpandedBytes: config.maximumExpandedArchiveBytes, maximumGcodeBytes: config.maximumGcodeBytes });
  assert.deepEqual(packaged.gcode, inspected.gcode, 'on-device preview does not alter native G-code');
  assert.deepEqual(packaged.archiveArtifact, finalArchive);
  const images = unzipSync(printable, { filter: entry => /^Metadata\/plate_1(?:_small)?\.png$/.test(entry.name) });
  assert.equal(Buffer.from(images['Metadata/plate_1.png']).readUInt32BE(16), 512);
  assert.equal(Buffer.from(images['Metadata/plate_1_small.png']).readUInt32BE(16), 128);
  assert.equal(preview.header.layerCount, result.metrics.layerCount);
  assert.ok(preview.header.statistics.featureRecordCounts.external_perimeter > 20);
  assert.ok(preview.header.statistics.featureRecordCounts.ironing > 0);
  assert.equal(preview.header.source.gcodeChecksumSha256, result.artifact.checksumSha256);
  assert.equal(preview.header.interpretation.dialect, 'bambu');
  assert.equal(preview.header.statistics.native.timeBasis,'native-normal-mode');
  assert.ok(preview.header.statistics.native.rows.some(row=>row.featureId===18&&row.filamentMassG>0));
  assert.deepEqual(preview.header.catalogs.tools.map(tool => tool.id), [0]);
  const custom=structuredClone(presets),motionOverrides={machine_max_acceleration_travel:13000,machine_max_acceleration_x:16000,machine_max_acceleration_y:16000};
  for(const [key,value] of Object.entries(motionOverrides))custom.machine[key][0]=String(value);
  custom.process.travel_acceleration='13000';
  custom.machine.machine_end_gcode+='\n; AM Pilot reviewed machine override';
  const overrideWork=path.join(workDir,'reviewed-machine');await fs.mkdir(overrideWork);
  const overridden=await runBambuEngine({config:{...config,maximumPlateInputBytes:16777216},workDir:overrideWork,plateInputPaths:[platePath],effectiveConfiguration:{engineAdapter:BAMBU_ENGINE_KEY,
    ownership:{machine:{motionOverrides,gcodeOverrides:{machine_end_gcode:custom.machine.machine_end_gcode}}},bambuConfig:{version:1,...custom}}});
  assert.ok(overridden.metrics.estimatedTimeSeconds>0);
  assert.match(await fs.readFile(overridden.gcodePath,'utf8'),/AM Pilot reviewed machine override/);
});

}
