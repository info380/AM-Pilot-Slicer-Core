import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { BAMBU_ENGINE_KEY, BAMBU_STUDIO_VERSION, assertBambuEffectiveConfiguration, inspectBambuOutput, runBambuEngine, verifyBambuStudio } from '../src/bambu-engine.js';
import { compileProductionToolpath } from '../src/toolpath.js';
import { resolveBambuPreset } from '../src/bambu-presets.js';

const machine = { type: 'machine', name: 'Bambu Lab A1 0.4 nozzle', printer_model: 'Bambu Lab A1', nozzle_diameter: ['0.4'] };
const filament = { type: 'filament', name: 'PLA', filament_diameter: ['1.75'], filament_type: ['PLA'], compatible_printers: [machine.name] };
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
  for (const mutate of [c => c.bambuConfig.machine.inherits = 'base', c => c.bambuConfig.filament.compatible_printers = [],
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
  presets.process.curr_bed_type = 'Textured PEI Plate';
  presets.process.ironing_type = 'top';
  presets.process.ironing_flow = '15%';
  presets.process.ironing_speed = '25';
  const vertices = [[50,60,0],[60,60,0],[50,70,0],[60,70,0],[50,60,5],[60,60,5],[50,70,5],[60,70,5]];
  const triangles = [[0,2,1],[1,2,3],[4,5,6],[5,7,6],[0,1,4],[1,5,4],[2,6,3],[3,6,7],[0,4,2],[2,4,6],[1,3,5],[3,7,5]];
  const xml = '<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>'
    + vertices.map(v => `<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('') + '</vertices><triangles>'
    + triangles.map(v => `<triangle v1="${v[0]}" v2="${v[1]}" v3="${v[2]}"/>`).join('') + '</triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const platePath = path.join(workDir, 'plate.3mf');
  await fs.writeFile(platePath, zipSync({ '3D/3dmodel.model': strToU8(xml),
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>') }));
  const config = { bambuStudioCommand: command, workRoot: workDir, requestTimeoutMs: 30000, jobTimeoutMs: 120000,
    maximumLogBytes: 262144, maximumArchiveBytes: 8388608, maximumExpandedArchiveBytes: 16777216, maximumGcodeBytes: 8388608 };
  await verifyBambuStudio(config);
  const result = await runBambuEngine({ config, workDir, plateInputPaths: [platePath], effectiveConfiguration: { engineAdapter: BAMBU_ENGINE_KEY, bambuConfig: { version: 1, ...presets } } });
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
  const preview = await compileProductionToolpath({ gcodePath: result.gcodePath, workDir,
    run: { id: 'bambu-integration', engineKey: BAMBU_ENGINE_KEY },
    effectiveConfiguration: { engineAdapter: BAMBU_ENGINE_KEY, bambuConfig: { version: 1, ...presets },
      coordinateMapping: { projectOrigin: 'center', translationMm: { x: 128, y: 128, z: 0 } } },
    gcodeArtifact: result.artifact, sliceEvidenceChecksumSha256: 'a'.repeat(64), summary: result.metrics, maximumBytes: 16777216 });
  assert.equal(preview.header.layerCount, result.metrics.layerCount);
  assert.ok(preview.header.statistics.featureRecordCounts.external_perimeter > 20);
  assert.ok(preview.header.statistics.featureRecordCounts.ironing > 0);
  assert.equal(preview.header.source.gcodeChecksumSha256, result.artifact.checksumSha256);
  assert.equal(preview.header.interpretation.dialect, 'bambu');
  assert.deepEqual(preview.header.catalogs.tools.map(tool => tool.id), [0]);
});

}
