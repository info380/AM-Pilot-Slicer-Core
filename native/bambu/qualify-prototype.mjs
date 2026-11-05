import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate';
import { buildAdvancedPlate3mf } from '../../src/advanced-three-mf.js';
import { buildPlateObjectTransform } from '../../src/transform.js';
import { resolveBambuPreset } from '../../src/bambu-presets.js';
import { inspectBambuOutput } from '../../src/bambu-engine.js';
import { runProcess } from '../../src/process.js';
import { summarizeToolpaths, compareToolpaths } from './toolpath-comparison.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pose = (x = 0, y = 0, z = 0) => ({ positionMm: { x, y, z }, rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } });
const ring = [[-10, -8], [10, -8], [10, 2], [2, 2], [2, 8], [-10, 8]];
const vertices = [0, 6].flatMap(z => ring.map(([x, y]) => ({ x, y, z })));
const faces = [[0, 1, 3], [1, 2, 3], [0, 3, 5], [3, 4, 5]];
const triangles = [...faces.map(([a, b, c]) => [c, b, a]), ...faces.map(t => t.map(i => i + 6)), ...ring.flatMap((_, i) => { const n = (i + 1) % 6; return [[i, n, n + 6], [i, n + 6, i + 6]]; })];
const source = zipSync({ '3D/3dmodel.model': strToU8(`<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices.map(v => `<vertex x="${v.x}" y="${v.y}" z="${v.z}"/>`).join('')}</vertices><triangles>${triangles.map(t => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`) });
const region = { id: 'left-top', name: 'Ironed left half', shape: 'box', sizeMm: { x: 10, y: 18, z: 8 }, transform: pose(-5, 0, 3), printOverrides: { fill_density: 100, ironing: true, ironing_type: 'top', ironing_flowrate: 12, ironing_spacing: .15, ironing_speed: 17 } };

function fixture({ count = 3, mutate = () => {} } = {}) {
  const sources = Array.from({ length: count }, (_, i) => ({ source, object: { name: `Part ${i + 1}`, definitionId: 'linked', printOverrides: {}, modifiers: [structuredClone(region)] }, transform: pose(45 + (i % 5) * 40, 70 + Math.floor(i / 5) * 45) }));
  mutate(sources);
  return sources.map(({ transform, ...entry }) => ({ ...entry, objectTransform: buildPlateObjectTransform({ transform, coordinateMapping: { projectOrigin: 'center', engineBedOrigin: 'front_left', translationMm: { x: 0, y: 0, z: 0 } } }) }));
}

function editMesh(plate, edit) {
  const files = unzipSync(plate); files['3D/3dmodel.model'] = strToU8(edit(strFromU8(files['3D/3dmodel.model'])));
  return zipSync(files);
}
const paint = (plate, attribute, value) => editMesh(plate, xml => xml.replace(/<mesh>[\s\S]*?<\/mesh>/, mesh => {
  let triangle = 0;
  const selected = value === '8' ? [12, 13, 14, 15] : [8, 9];
  return mesh.replace(/(<triangle v1="\d+" v2="\d+" v3="\d+")\/>/g, (match, head) => selected.includes(triangle++) ? `${head} ${attribute}="${value}"/>` : match);
}));
const tinyVolumeShift = volume => plate => editMesh(plate, xml => {
  let object = 0;
  return xml.replace(/<components>[\s\S]*?<\/components>/g, components => {
    if (object++ !== 1) return components;
    let part = 0;
    return components.replace(/<component objectid="(\d+)"\/>/g, (match, id) => part++ === volume ? `<component objectid="${id}" transform="1 0 0 0 1 0 0 0 1 0.0000000000001 0 0"/>` : match);
  });
});

const cases = [
  { id: 'aligned-ten-ironing', count: 10, hits: 9 },
  { id: 'nearest-linked', seam: 'nearest', hits: 2 },
  { id: 'random-linked', seam: 'random', hits: 0, rays: 0 },
  { id: 'rear-linked', seam: 'back', hits: 0, rays: 0 },
  { id: 'rotated-and-scaled', hits: 0, mutate: s => { s[1].transform.rotationDeg.z = 90; s[2].transform.scale = { x: .7, y: 1.2, z: 1 }; } },
  { id: 'different-modifier', hits: 0, mutate: s => { s[1].object.modifiers[0].printOverrides.ironing_flowrate = 18; s[2].object.modifiers[0].transform.positionMm.x = -3; } },
  { id: 'different-object-settings', hits: 0, mutate: s => { s[1].object.printOverrides = { perimeters: 3 }; s[2].object.printOverrides = { perimeters: 4 }; } },
  { id: 'independent-identical', hits: 0, mutate: s => s.forEach((entry, i) => { entry.object.definitionId = `independent-${i}`; }) },
  { id: 'approximately-equal-model-transform', hits: 0, expectedSharedLinks: 2, edit: tinyVolumeShift(0) },
  { id: 'approximately-equal-modifier-transform', hits: 0, expectedSharedLinks: 2, edit: tinyVolumeShift(1) },
  { id: 'painted-seam-enforcer', hits: 2, edit: plate => paint(plate, 'paint_seam', '4') },
  { id: 'painted-seam-blocker', hits: 2, edit: plate => paint(plate, 'paint_seam', '8') },
  { id: 'distinct-painted-seams', hits: 0, mutate: s => s.forEach((entry, i) => { entry.object.definitionId = `paint-${i}`; }), edit: plate => {
    let mesh = 0; return editMesh(plate, xml => xml.replace(/<mesh>[\s\S]*?<\/mesh>/g, text => { const index = mesh++; return index % 2 === 0 ? text.replace(/(<triangle v1="\d+" v2="\d+" v3="\d+")\/>/, `$1 paint_seam="${index === 2 ? '8' : '4'}"/>`) : text; }));
  } },
  { id: 'shared-negative-volumes', hits: 2, edit: plate => {
    const files = unzipSync(plate); files['Metadata/model_settings.config'] = strToU8(strFromU8(files['Metadata/model_settings.config']).replaceAll('subtype="modifier_part"', 'subtype="negative_part"'));
    return zipSync(files);
  } }
];

export async function qualify({ control, candidate, official, resources, output, preflight = false }) {
  assert.equal(process.platform, 'linux');
  await fs.mkdir(output, { recursive: false });
  const machine = (await resolveBambuPreset({ resourceRoot: resources, kind: 'machine', name: 'Bambu Lab A1 0.4 nozzle' })).settings;
  const processPreset = (await resolveBambuPreset({ resourceRoot: resources, kind: 'process', name: machine.default_print_profile })).settings;
  const filament = (await resolveBambuPreset({ resourceRoot: resources, kind: 'filament', name: 'Generic PLA @BBL A1' })).settings;
  // A diagnostic fixture contract: no production setting is changed. Turn off
  // the separately documented floating-shell variation for strict equivalence.
  Object.assign(processPreset, { curr_bed_type: 'Textured PEI Plate', enable_support: '0', detect_floating_vertical_shell: '0', layer_height: '0.2', initial_layer_print_height: '0.2', ironing_type: 'no ironing' });
  const report = { schema: 'am-pilot-native-seam-prototype-qualification', version: 1, diagnosticOnly: true, preflight, serverPlanChanged: false, cases: [] };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report));
  for (const spec of cases) {
    const caseDir = path.join(output, spec.id); await fs.mkdir(caseDir);
    let plate = buildAdvancedPlate3mf({ sources: fixture(spec), bambu: true, maximumUncompressedBytes: 16 * 1024 * 1024, maximumSourceUncompressedBytes: 4 * 1024 * 1024, pausePoints: [] });
    if (spec.edit) plate = spec.edit(plate);
    const input = path.join(caseDir, 'input.3mf'); await fs.writeFile(input, plate);
    const presets = { machine, process: { ...processPreset, seam_position: spec.seam ?? 'aligned' }, filament };
    const paths = {};
    for (const [kind, preset] of Object.entries(presets)) { paths[kind] = path.join(caseDir, `${kind}.json`); const settings = { ...preset }; delete settings.post_process; await fs.writeFile(paths[kind], JSON.stringify(settings)); }
    const results = [];
    for (const [label, command] of (preflight ? [['official', official]] : [['official', official], ['control', control], ['candidate', candidate]])) {
      const work = path.join(caseDir, label); await fs.mkdir(work);
      const logFile = path.join(work, 'native.log'), fd = syncFs.openSync(logFile, 'wx'); let logOpen = true;
      const start = performance.now();
      try {
        await runProcess({ command, args: ['--debug', '4', '--datadir', path.join(work, 'data'), '--arrange', '0', '--orient', '0', '--skip-useless-pick', '--min-save', '--load-settings', paths.machine + ';' + paths.process, '--load-filaments', paths.filament, '--slice', '0', '--export-3mf', 'output.gcode.3mf', '--outputdir', work, input], cwd: work, timeoutMs: 120000, maximumLogBytes: 262144, cpuAffinityCount: 1, onOutput: (_stream, chunk) => { if (logOpen) syncFs.writeSync(fd, chunk); } });
      } finally { logOpen = false; syncFs.closeSync(fd); }
      const nativeMs = performance.now() - start, archive = await fs.readFile(path.join(work, 'output.gcode.3mf'));
      const checked = inspectBambuOutput({ bytes: archive, machine, filament, maximumArchiveBytes: 64 * 1024 * 1024, maximumExpandedBytes: 128 * 1024 * 1024, maximumGcodeBytes: 64 * 1024 * 1024 });
      const files = unzipSync(archive, { filter: entry => ['Metadata/project_settings.config', '3D/3dmodel.model', 'Metadata/model_settings.config'].includes(entry.name) });
      const settings = JSON.parse(strFromU8(files['Metadata/project_settings.config']));
      const log = await fs.readFile(logFile, 'utf8'), gcode = strFromU8(checked.gcode);
      if (spec.expectedSharedLinks !== undefined) assert.equal((log.match(/found shared object from/g) ?? []).length, spec.expectedSharedLinks, spec.id + ': fixture must exercise native approximate equality');
      const result = { label, nativeMs, settings, toolpaths: summarizeToolpaths(gcode), visibilityPasses: (log.match(/raycast visibility of/g) ?? []).length / 2, reuseHits: (log.match(/reused equivalent object visibility/g) ?? []).length, archiveSha256: sha(archive) };
      const ironing = Object.values(result.toolpaths.ironingByObject);
      if (spec.id !== 'shared-negative-volumes') {
        assert.equal(ironing.length, spec.count ?? 3, spec.id + ': every modifier must produce ironing');
        assert(ironing.every(entry => entry.count > 5), spec.id + ': missing ironing toolpaths');
      } else assert.equal(ironing.length, 0, 'A negative volume must not become an ironing modifier');
      if (label === 'candidate') {
        assert.equal(result.reuseHits, spec.hits, spec.id + ': incorrect cache hits');
        assert.equal(result.visibilityPasses, spec.rays ?? (spec.count ?? 3) - spec.hits, spec.id + ': incorrect visibility calculations');
      }
      results.push(result);
    }
    for (const result of results.slice(1)) {
      assert.deepEqual(result.settings, results[0].settings, spec.id + ': native settings changed');
      assert.deepEqual(compareToolpaths(results[0].toolpaths, result.toolpaths), { layersMatch: true, seamsMatch: true, changedFeatureLayers: [] }, spec.id + ': native geometry or seams changed');
    }
    const row = { id: spec.id, inputSha256: sha(plate), layers: results[0].toolpaths.layers.length, settingsMatch: preflight ? null : true, seamsMatch: preflight ? null : true, depositedGeometryMatch: preflight ? null : true, runs: results.map(({ settings, toolpaths, ...result }) => ({ ...result, settingsCount: Object.keys(settings).length, outerWallStarts: toolpaths.outerWallStarts, ironingByObject: toolpaths.ironingByObject })) };
    report.cases.push(row); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(row));
  }
  const seamHash = id => report.cases.find(row => row.id === id).runs[0].outerWallStarts.sha256;
  assert.notEqual(seamHash('painted-seam-enforcer'), seamHash('independent-identical'), 'Painted enforcer must affect seam positions');
  assert.notEqual(seamHash('painted-seam-blocker'), seamHash('independent-identical'), 'Painted blocker must affect seam positions');
  report.status = preflight ? 'fixture-preflight-passed' : 'passed'; await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [control, candidate, official, resources, output] = process.argv.slice(2);
  assert(control && candidate && official && resources && output, 'Explicit binary/resource/output paths are required');
  await qualify({ control, candidate, official, resources, output });
}
