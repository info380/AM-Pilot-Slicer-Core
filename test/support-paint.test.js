import { runBambuEngine, BAMBU_ENGINE_KEY } from '../src/bambu-engine.js';
import { resolveBambuPreset } from '../src/bambu-presets.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync, strFromU8, strToU8, zipSync } from 'fflate';
import { buildSupportPainted3mf, readPaintableStl, validateSupportPaint, assertSupportPaintRoundtrip } from '../src/support-paint.js';
import { materializePlateInputs } from '../src/plate.js';
import { runProcess } from '../src/process.js';
import { createNormalizationCache } from '../src/normalization-cache.js';

// Closed L prism: one foot on the bed and an unsupported shelf at z=10.
const profile = [[-5,0],[0,0],[0,10],[5,10],[5,20],[-5,20]];
const vertices = [-5,5].flatMap(y => profile.map(([x,z]) => [x,y,z]));
const front = [[0,1,2],[0,2,5],[2,3,4],[2,4,5]];
const facets = [...front, ...front.map(face => face.map(i => i+6).reverse()),
  ...profile.flatMap((_,i) => { const j=(i+1)%6; return [[i,i+6,j+6],[i,j+6,j]]; })];
const source = Buffer.alloc(84 + facets.length * 50);
source.writeUInt32LE(facets.length, 80);
facets.forEach((face, i) => face.flatMap(index => vertices[index]).forEach((value,j) => source.writeFloatLE(value, 84+i*50+12+j*4)));
const checksum = createHash('sha256').update(source).digest('hex');
const model = { modelId: 'source', projectFileId: 'file', sourceFormat: 'stl', checksumSha256: checksum };
const paint = data => ({ schema: 'am-pilot-support-paint', version: 1, triangleCount: facets.length, sourceSha256: checksum, data });
const xml = archive => strFromU8(unzipSync(archive)['3D/3dmodel.model']);

test('native normalization reuse preserves paint across engines, jobs and changed annotations',
  { skip: !process.env.PRUSA_SLICER_INTEGRATION_CMD }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-normalization-reuse-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.stl'); await fs.writeFile(sourcePath, source);
  const cache = createNormalizationCache({ maximumBytes: 1_048_576, maximumEntries: 8, ttlMs: 60_000,
    normalizerIdentity: 'qualified-native-test' });
  t.after(() => cache.dispose());
  const config = { prusaSlicerCommand: process.env.PRUSA_SLICER_INTEGRATION_CMD, jobTimeoutMs: 30_000,
    maximumLogBytes: 262_144, maximumModelBytes: 1_048_576, maximumNormalizedModelBytes: 1_048_576,
    maximumTotalNormalizedBytes: 2_097_152, maximumPlateInputBytes: 2_097_152 };
  for (const bambu of [false, true]) {
    const effectiveConfiguration = { ...(bambu ? { engineAdapter: BAMBU_ENGINE_KEY, bambuConfig: { machine: {} } } : { prusaConfig: {} }),
      coordinateMapping: { projectOrigin: 'center', engineBedOrigin: 'front_left', translationMm: { x: 100, y: 100, z: 0 } } };
    let previous;
    for (const [name, data] of [['cold', '12:4\n13:4'], ['warm', '12:4\n13:4'], ['changed', '12:8\n13:8']]) {
      const workDir = path.join(directory, `${bambu}-${name}`); await fs.mkdir(workDir);
      const inputSnapshot = { schema: 'am-pilot-slicer-input-snapshot', version: 1,
        models: [{ ...model, sizeBytes: source.length }], plate: { objects: [{ id: 'object', fileId: 'file', name: 'Painted part',
          supportPaint: paint(data), placement: { status: 'placed' }, transform: {
            positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }
          } }] } };
      const inputs = await materializePlateInputs({ inputSnapshot, effectiveConfiguration,
        downloadedModels: new Map([['source', sourcePath]]), workDir, config, normalizationCache: cache,
        sourceCacheScope: { version: 1, tenantNamespaceSha256: 'a'.repeat(64) } });
      const bytes = await fs.readFile(inputs[0]);
      assert.match(xml(bytes), bambu ? /paint_supports=/ : /slic3rpe:custom_supports=/);
      if (name === 'warm') assert.deepEqual(bytes, previous);
      if (name === 'changed') assert.notDeepEqual(bytes, previous);
      previous = bytes;
    }
  }
  assert.equal(cache.stats().misses, 3);
  assert.equal(cache.stats().hits, 9);
});

test('native painted package retains source facets, coordinates, states and determinism', () => {
  const options = { source, model, paint: paint('0:40003\n1:8'), maximumUncompressedBytes: 1_000_000 };
  const result = buildSupportPainted3mf(options);
  assert.deepEqual(result, buildSupportPainted3mf(options));
  assert.match(xml(result), /slic3rpe:custom_supports="40003"/);
  assert.match(xml(result), /slic3rpe:custom_supports="8"/);
  assert.equal((xml(result).match(/<triangle /g) || []).length, facets.length);
  assert.deepEqual(readPaintableStl(source), facets.flatMap(face => face.flatMap(i => vertices[i])));
  assert.equal(createHash('sha256').update(source).digest('hex'), checksum);
});
test('worker rejects stale source, arbitrary XML, malformed/deep trees and expansion overflow', () => {
  const tooDeep = Array.from({ length: 17 }).reduce(tree => `${tree}0003`, '4');
  for (const data of ['0:<xml>','0:4\n0:8','20:4','0:43','0:C','0:4\n',`0:${tooDeep}`]) {
    assert.throws(() => validateSupportPaint(paint(data), { source, model }));
  }
  assert.throws(() => validateSupportPaint({ ...paint('0:4'), sourceSha256: 'b'.repeat(64) }, { source, model }));
  assert.throws(() => buildSupportPainted3mf({ source, model, paint: paint('0:4'), maximumUncompressedBytes: 2048 }));
  assert.throws(() => buildSupportPainted3mf({ source, model, paint: { ...paint('0:4'), triangleCount: 13 }, maximumUncompressedBytes: 1_000_000 }));
});

test('normalization cannot silently drop, move or change paint or source geometry', () => {
  const before = buildSupportPainted3mf({ source, model, paint: paint('0:40003\n1:8'), maximumUncompressedBytes: 1_000_000 });
  const check = after => assertSupportPaintRoundtrip({ before, after, maximumUncompressedBytes: 1_000_000 });
  assert.doesNotThrow(() => check(before));
  for (const replace of [text => text.replace('40003','80003'), text => text.replace(' slic3rpe:custom_supports="8"',''),
    text => text.replace('x="-5"','x="-6"'), text => text.replace(/<triangle [^>]+\/>/, '')]) {
    const entries = unzipSync(before);
    entries['3D/3dmodel.model'] = strToU8(replace(xml(before)));
    assert.throws(() => check(zipSync(entries)), { code: 'slicer_support_paint_invalid' });
  }
});

test('ASCII facets use float32 source coordinates and invalid source geometry fails closed', () => {
  const ascii = Buffer.from('solid fixture\nfacet normal 0 0 1\nouter loop\nvertex 0.123456789 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid fixture\n');
  assert.deepEqual(readPaintableStl(ascii), [Math.fround(.123456789),0,0,1,0,0,0,1,0]);
  for (const replacement of ['vertex NaN 0 0', 'vertex 1 0 0']) {
    assert.throws(() => readPaintableStl(Buffer.from(ascii.toString().replace('vertex 0.123456789 0 0', replacement))));
  }
  const broken = Buffer.from(source); broken.writeFloatLE(Infinity, 96);
  assert.throws(() => readPaintableStl(broken));
});

test('native float32 recentering is exact in local coordinates without relaxing geometry or paint checks', () => {
  const shifted=Buffer.from(source);
  for(let face=0;face<facets.length;face++)for(let coord=0;coord<9;coord++){
    const offset=84+face*50+12+coord*4;
    shifted.writeFloatLE(shifted.readFloatLE(offset)+[0.0248918533,0,0.2698773146][coord%3],offset);
  }
  const sha=createHash('sha256').update(shifted).digest('hex');
  const before=buildSupportPainted3mf({source:shifted,model:{...model,checksumSha256:sha},paint:{...paint('0:40003\n1:8'),sourceSha256:sha},maximumUncompressedBytes:1_000_000});
  const positions=readPaintableStl(shifted),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  positions.forEach((v,i)=>{lo[i%3]=Math.min(lo[i%3],v);hi[i%3]=Math.max(hi[i%3],v);});
  const center=lo.map((v,i)=>(v+hi[i])/2);
  const normalized=xml(before).replace(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"\/>/g,(_m,...args)=>{
    const v=args.slice(0,3).map((v,i)=>Math.fround(Number(v)-Math.fround(center[i])));
    return `<vertex x="${v[0].toPrecision(9)}" y="${v[1].toPrecision(9)}" z="${v[2].toPrecision(9)}"/>`;
  }).replace('<item objectid="1"/>',`<item objectid="1" transform="1 0 0 0 1 0 0 0 1 ${center.map(v=>Number(v.toPrecision(9))).join(' ')}"/>`);
  const archive=text=>{const entries=unzipSync(before);entries['3D/3dmodel.model']=strToU8(text);return zipSync(entries);};
  const check=text=>assertSupportPaintRoundtrip({before,after:archive(text),maximumUncompressedBytes:1_000_000});
  assert.doesNotThrow(()=>check(normalized));
  for(const text of [normalized.replace('40003','80003'),normalized.replace('v1="0" v2="1"','v1="1" v2="0"'),
    normalized.replace(/x="[^"]+"/,'x="-5.00001"'),normalized.replace('transform="1 0','transform="2 0'),
    normalized.replace(/<triangle [^>]+\/>/,'')]) assert.throws(()=>check(text),{code:'slicer_support_paint_invalid'});
});

test('native normalization preserves an off-origin fractional mesh and partial paint', { skip: !process.env.PRUSA_SLICER_INTEGRATION_CMD }, async t => {
  const command=process.env.PRUSA_SLICER_INTEGRATION_CMD;
  const workDir=await fs.mkdtemp(path.join(os.tmpdir(),'support-paint-recenter-'));
  t.after(()=>fs.rm(workDir,{recursive:true,force:true}));
  const shifted=Buffer.from(source);
  for(let face=0;face<facets.length;face++)for(let coord=0;coord<9;coord++){
    const offset=84+face*50+12+coord*4;
    shifted.writeFloatLE(shifted.readFloatLE(offset)+[0.0248918533,0,0.2698773146][coord%3],offset);
  }
  const checksumSha256=createHash('sha256').update(shifted).digest('hex');
  const before=buildSupportPainted3mf({source:shifted,model:{...model,checksumSha256},paint:{...paint('0:40003\n1:8'),sourceSha256:checksumSha256},maximumUncompressedBytes:1_000_000});
  const input=path.join(workDir,'before.3mf'),output=path.join(workDir,'after.3mf');await fs.writeFile(input,before);
  await runProcess({command,args:['--export-3mf','--dont-arrange','--no-ensure-on-bed','--config-compatibility','disable','--output',output,input],cwd:workDir,timeoutMs:120000,maximumLogBytes:262144});
  assertSupportPaintRoundtrip({before,after:await fs.readFile(output),maximumUncompressedBytes:1_000_000});
});

test('native worker normalization preserves paint and changes generated support paths', { skip: !process.env.PRUSA_SLICER_INTEGRATION_CMD }, async t => {
  const command = process.env.PRUSA_SLICER_INTEGRATION_CMD;
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'support-paint-engine-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const sourcePath = path.join(workDir, 'source.stl'); await fs.writeFile(sourcePath, source);
  const config = { prusaSlicerCommand: command, jobTimeoutMs: 120_000, maximumLogBytes: 262_144,
    maximumModelsPerRun: 1, maximumObjectsPerPlate: 1, maximumNormalizedModelBytes: 67_108_864,
    maximumTotalNormalizedBytes: 134_217_728, maximumPlateInputBytes: 201_326_592 };
  const settingsPath = path.join(workDir, 'settings.ini');
  const settings = 'layer_height = 0.2\nfirst_layer_height = 0.2\nnozzle_diameter = 0.4\nfilament_diameter = 1.75\nbed_shape = 0x0,200x0,200x200,0x200\nsupport_material = 1\nsupport_material_auto = 0\ndont_support_bridges = 0\nfill_density = 15%\nfill_pattern = grid\n';
  await fs.writeFile(settingsPath, settings);
  const counts = {};
  const supportExtrusion = {};
  for (const [name, data] of [['none',''], ['enforce','12:4\n13:4'], ['partial','12:40003'], ['auto',''], ['block','12:8\n13:8']]) {
    await fs.writeFile(settingsPath, ['auto','block'].includes(name) ? settings.replace('support_material_auto = 0','support_material_auto = 1') : settings);
    const inputSnapshot = { schema: 'am-pilot-slicer-input-snapshot', version: 1, models: [model], plate: { objects: [{
      id: 'painted', fileId: 'file', supportPaint: paint(data), placement: { status: 'placed' },
      transform: { positionMm: {x:0,y:0,z:0}, rotationDeg: {x:0,y:0,z:0}, scale: {x:1,y:1,z:1} }
    }] } };
    const effectiveConfiguration = { coordinateMapping: { projectOrigin: 'center', engineBedOrigin: 'front_left', translationMm: {x:100,y:100,z:0} }, prusaConfig: {} };
    const inputs = await materializePlateInputs({ inputSnapshot, effectiveConfiguration, downloadedModels: new Map([['source', sourcePath]]), workDir, config })
      .catch(error => { throw new Error(`Materialize ${name}: ${error.cause?.message || error.message}`, { cause: error }); });
    const normalizedXml = xml(await fs.readFile(inputs[0]));
    if (data) assert.match(normalizedXml, /slic3rpe:custom_supports=/, `Paint lost during ${name} normalization`);
    const output = path.join(workDir, `${name}.gcode`);
    await runProcess({ command, args: ['--export-gcode','--dont-arrange','--no-ensure-on-bed','--config-compatibility','disable','--load',settingsPath,'--output',output,...inputs], cwd: workDir, timeoutMs: 120_000, maximumLogBytes: 262_144 })
      .catch(error => { throw new Error(`Slice ${name}: ${error.cause?.message || error.message}`, { cause: error }); });
    const gcode = await fs.readFile(output, 'utf8');
    counts[name] = (gcode.match(/;TYPE:Support material/g) || []).length;
    let isSupport = false, previousE = 0, totalE = 0;
    for (const line of gcode.split('\n')) {
      if (line.startsWith(';TYPE:')) isSupport = line.startsWith(';TYPE:Support material');
      const e = /\bE(-?[\d.]+)/.exec(line);
      if (!e) continue;
      if (line.startsWith('G92')) { previousE = Number(e[1]); continue; }
      if (!/^G[01]\s/.test(line)) continue;
      const nextE = Number(e[1]);
      if (isSupport && /\b[XY]-?[\d.]+/.test(line)) totalE += Math.max(0, nextE - previousE);
      previousE = nextE;
    }
    supportExtrusion[name] = totalE;
  }
  assert.equal(counts.none, 0); assert.ok(counts.enforce > 0); assert.ok(counts.partial > 0); assert.ok(counts.auto > 0); assert.equal(counts.block, 0);
  assert.ok(supportExtrusion.partial > 0 && supportExtrusion.partial < supportExtrusion.enforce, JSON.stringify(supportExtrusion));
  t.diagnostic(JSON.stringify({ supportSections: counts, supportExtrusion, nativeRoundtrip: true, sourceChecksum: checksum }));
});


test('real Bambu worker applies whole-facet, partial, blocker and linked support paint', {skip:!process.env.BAMBU_STUDIO_INTEGRATION_CMD||!process.env.BAMBU_STUDIO_INTEGRATION_RESOURCES||!process.env.PRUSA_SLICER_INTEGRATION_CMD}, async t=>{
 const workDir=await fs.mkdtemp(path.join(os.tmpdir(),'bambu-support-paint-'));
 t.after(()=>process.env.KEEP_FDM_NATIVE_OUTPUT?console.log(workDir):fs.rm(workDir,{recursive:true,force:true}));
 const sourcePath=path.join(workDir,'source.stl');await fs.writeFile(sourcePath,source);
 const resourceRoot=process.env.BAMBU_STUDIO_INTEGRATION_RESOURCES;
 const machine=(await resolveBambuPreset({resourceRoot,kind:'machine',name:'Bambu Lab A1 0.4 nozzle'})).settings;
 const preset=(await resolveBambuPreset({resourceRoot,kind:'process',name:machine.default_print_profile})).settings;
 const filament=(await resolveBambuPreset({resourceRoot,kind:'filament',name:'Generic PLA @BBL A1'})).settings;
 Object.assign(preset,{curr_bed_type:'Textured PEI Plate',enable_support:'1',support_type:'normal(manual)',support_on_build_plate_only:'0',support_remove_small_overhang:'0',support_threshold_angle:'30'});
 const config={prusaSlicerCommand:process.env.PRUSA_SLICER_INTEGRATION_CMD,bambuStudioCommand:process.env.BAMBU_STUDIO_INTEGRATION_CMD,
  jobTimeoutMs:120000,maximumLogBytes:262144,maximumNormalizedModelBytes:67108864,maximumTotalNormalizedBytes:134217728,maximumPlateInputBytes:201326592,
  maximumArchiveBytes:16777216,maximumExpandedArchiveBytes:33554432,maximumGcodeBytes:16777216,engineThreads:1,engineCpuAffinity:process.env.SLICER_TEST_CPU_AFFINITY||'none'};
 const evidence={};
 for(const [name,data] of [['none',''],['enforce','12:4\n13:4'],['partial','12:40003'],['auto',''],['block','12:8\n13:8'],['linked','12:4\n13:4']]){
  const runDir=path.join(workDir,name);await fs.mkdir(runDir);
  const object={id:'painted',name:'Shelf',definitionId:'linked',fileId:'file',supportPaint:paint(data),placement:{status:'placed'},printOverrides:{},transform:{positionMm:{x:0,y:0,z:0},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}};
  const objects=name==='linked'?[object,{...object,id:'copy',transform:{...object.transform,positionMm:{x:30,y:0,z:0}}}]:[object];
  const inputSnapshot={schema:'am-pilot-slicer-input-snapshot',version:1,models:[model],plate:{geometry:{heightMm:256},objects}};
  const effectiveConfiguration={engineAdapter:BAMBU_ENGINE_KEY,coordinateMapping:{projectOrigin:'center',engineBedOrigin:'front_left',translationMm:{x:100,y:100,z:0}},bambuConfig:{version:1,machine,filament,process:{...preset,support_type:['auto','block'].includes(name)?'normal(auto)':'normal(manual)'}}};
  const motionOverrides={machine_max_acceleration_travel:13000};machine.machine_max_acceleration_travel[0]='13000';effectiveConfiguration.ownership={machine:{motionOverrides}};
  const paths=await materializePlateInputs({inputSnapshot,effectiveConfiguration,downloadedModels:new Map([['source',sourcePath]]),workDir:runDir,config});
  const modelXml=xml(await fs.readFile(paths[0]));
  assert.doesNotMatch(modelXml,/slic3rpe:custom_supports=/);
  if(data)assert.match(modelXml,/paint_supports=/,'native Bambu paint was retained');
  if(name==='linked')assert.equal((modelXml.match(/<mesh>/g)||[]).length,1,'linked paint reuses one validated source mesh');
  const result=await runBambuEngine({plateInputPaths:paths,effectiveConfiguration,workDir:runDir,config});
  const gcode=await fs.readFile(result.gcodePath,'utf8');
  let support=false,extrusion=0;const xs=[],ys=[];
  for(const line of gcode.split('\n')){
   const feature=/^; FEATURE: (.+)/.exec(line);if(feature)support=/^Support/.test(feature[1]);
   if(!support||!/^G[01] /.test(line)||!/[XY][-\d.]+/.test(line))continue;
   const e=/\bE([-\d.]+)/.exec(line),x=/\bX([-\d.]+)/.exec(line),y=/\bY([-\d.]+)/.exec(line);
   if(e&&Number(e[1])>0){extrusion+=Number(e[1]);if(x)xs.push(Number(x[1]));if(y)ys.push(Number(y[1]));}
  }
  evidence[name]={extrusion,segments:xs.length,bounds:xs.length?{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}:null};
  if(name==='linked')assert.ok(xs.some(x=>x<115)&&xs.some(x=>x>115),'support is generated under both placed instances');
 }
 assert.equal(evidence.none.extrusion,0);
 assert.ok(evidence.enforce.extrusion>0);
 assert.ok(evidence.partial.extrusion>0&&evidence.partial.extrusion<evidence.enforce.extrusion,JSON.stringify(evidence));
 assert.ok(evidence.partial.bounds.maxX<evidence.enforce.bounds.maxX-1,'partial native support remains on the painted source quadrant');
 assert.ok(evidence.partial.bounds.maxY<evidence.enforce.bounds.maxY-2,'partial paint retains its source orientation');
 assert.ok(evidence.auto.extrusion>0);
 assert.equal(evidence.block.extrusion,0);
 assert.ok(evidence.linked.extrusion>evidence.enforce.extrusion*1.5);
 t.diagnostic(JSON.stringify(evidence));
});
