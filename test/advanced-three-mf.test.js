import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, strFromU8, zipSync, unzipSync } from 'fflate';
import { buildAdvancedPlate3mf } from '../src/advanced-three-mf.js';
import { modifierGeometry } from '../src/modifier-geometry.js';
import { buildPlateObjectTransform } from '../src/transform.js';
import { resolveBambuPreset } from '../src/bambu-presets.js';
import { runBambuEngine, BAMBU_ENGINE_KEY } from '../src/bambu-engine.js';
import { runSlicerEngine } from '../src/engine.js';
import { verifyNativePauseEvents } from '../src/pause-verification.js';

const transform = (x=0,y=0,z=0) => ({positionMm:{x,y,z},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}});
const cube = modifierGeometry({shape:'box',sizeMm:{x:20,y:20,z:10}});
// Source coordinates match the viewport's centered XY and bed-relative Z.
const model = `<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${cube.vertices.map(v=>`<vertex x="${v.x}" y="${v.y}" z="${v.z+5}"/>`).join('')}</vertices><triangles>${cube.triangles.map(t=>`<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
const source = zipSync({'3D/3dmodel.model':strToU8(model)});
const modifier = {id:'region-1',name:'Solid lower half',shape:'box',sizeMm:{x:22,y:22,z:5},transform:transform(0,0,2.5),printOverrides:{fill_density:100}};
const argumentsFor = (bambu,modifiers=[modifier],pauses=[{id:'pause-1',zMm:5.2,message:'Insert part'}]) => ({bambu,pauseGcode:bambu?'M400 U1':'PAUSE',maximumUncompressedBytes:16*1024*1024,pausePoints:pauses,sources:[{source,object:{name:'Test cube',modifiers},objectTransform:buildPlateObjectTransform({transform:transform(80,80),coordinateMapping:{projectOrigin:'center',engineBedOrigin:'front_left',translationMm:{x:0,y:0,z:0}}})}]});
const textEntries = bytes => Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name,bytes])=>[name,strFromU8(bytes)]));
const infillLength = layer => {
 let feature='',x=0,y=0,length=0;
 for(const line of layer.split('\n')){
  const label=line.match(/^;(?: FEATURE: |TYPE:)(.+)/);if(label)feature=label[1];
  if(!/^G[01] /.test(line))continue;
  const values=Object.fromEntries([...line.matchAll(/([XYE])([-\d.]+)/g)].map(match=>[match[1],Number(match[2])]));
  const nextX=values.X ?? x,nextY=values.Y ?? y;
  if(['Sparse infill','Internal infill','Internal solid infill','Solid infill'].includes(feature) && values.E>0)length+=Math.hypot(nextX-x,nextY-y);
  x=nextX;y=nextY;
 }
 return length;
};

test('modifier primitives are closed, bounded and deterministic',()=>{
 for(const shape of ['box','cylinder','sphere']){
  const mesh=modifierGeometry({shape,sizeMm:{x:20,y:30,z:40}}),edges=new Map();
  for(const t of mesh.triangles)for(let i=0;i<3;i++){const a=t[i],b=t[(i+1)%3],key=[a,b].sort((a,b)=>a-b).join(':');edges.set(key,(edges.get(key)||0)+1);}
  assert.ok([...edges.values()].every(count=>count===2));
  for(const [axis,extent] of [['x',10],['y',15],['z',20]])assert.ok(mesh.vertices.every(v=>Math.abs(v[axis])<=extent+1e-8));
  assert.deepEqual(mesh,modifierGeometry({shape,sizeMm:{x:20,y:30,z:40}}));
 }
});
test('native projects preserve modifier types, settings, configured pause and deterministic bytes',()=>{
 for(const bambu of [false,true]){
  const args=argumentsFor(bambu),bytes=buildAdvancedPlate3mf(args),files=textEntries(bytes);
  assert.deepEqual(bytes,buildAdvancedPlate3mf(args));
  const config=files[bambu?'Metadata/model_settings.config':'Metadata/Slic3r_PE_model.config'];
  assert.match(config,bambu?/subtype="modifier_part"/:/key="modifier" value="1"/);
  assert.match(config,bambu?/key="sparse_infill_density" value="100%"/:/key="fill_density" value="100%"/);
  const pause=files[bambu?'Metadata/custom_gcode_per_layer.xml':'Metadata/Prusa_Slicer_custom_gcode_per_print_z.xml'];
  assert.match(pause,/type="1"/);assert.match(pause,bambu?/M400 U1/:/PAUSE/);assert.match(pause,/5.2/);
 }
 assert.throws(()=>buildAdvancedPlate3mf({...argumentsFor(false),pauseGcode:''}),/pause command/);
 assert.throws(()=>buildAdvancedPlate3mf({...argumentsFor(false),maximumUncompressedBytes:100}),/budget|limits/);
});
test('a missing, duplicate, misplaced or above-model pause fails output verification',()=>{
 const pausePoints=[{id:'p',zMm:5.21,message:''}],gcode=';Z:5.2\n;Z:5.4\n;PAUSE_PRINT\nPAUSE\n';
 assert.doesNotThrow(()=>verifyNativePauseEvents({gcode,pausePoints,bambu:false}));
 for(const text of [';Z:5.2\n;PAUSE_PRINT\nPAUSE\n;Z:5.4\n',';Z:5.2\n;Z:5.4\n',gcode+';PAUSE_PRINT\n'])
  assert.throws(()=>verifyNativePauseEvents({gcode:text,pausePoints,bambu:false}),{code:'slicer_pause_not_generated'});
 assert.throws(()=>verifyNativePauseEvents({gcode,pausePoints:[{id:'p',zMm:20,message:''}],bambu:false}),{code:'slicer_pause_not_generated'});
});

const bambuCommand=process.env.BAMBU_STUDIO_INTEGRATION_CMD, resources=process.env.BAMBU_STUDIO_INTEGRATION_RESOURCES;
const prusaCommand=process.env.PRUSA_SLICER_INTEGRATION_CMD;
for(const bambu of [false,true].filter(bambu=>!process.env.FDM_ADVANCED_ENGINE || process.env.FDM_ADVANCED_ENGINE===(bambu?'bambu':'prusa')))for(const shape of ['box','cylinder','sphere'])test(`real ${bambu?'Bambu':'Prusa'} pause and local ${shape} modifier`,{skip:bambu?(!bambuCommand||!resources):!prusaCommand},async t=>{
 const workDir=await fs.mkdtemp(path.join(os.tmpdir(),`fdm-advanced-${bambu?'bambu':'prusa'}-`));
 if(process.env.KEEP_FDM_NATIVE_OUTPUT)process.stdout.write(`Native output: ${workDir}\n`);
 t.after(()=>process.env.KEEP_FDM_NATIVE_OUTPUT?undefined:fs.rm(workDir,{recursive:true,force:true}));
 const config={bambuStudioCommand:bambuCommand,prusaSlicerCommand:prusaCommand,workRoot:workDir,jobTimeoutMs:120000,requestTimeoutMs:30000,maximumLogBytes:262144,maximumArchiveBytes:16777216,maximumExpandedArchiveBytes:33554432,maximumGcodeBytes:16777216,engineThreads:1};
 let effectiveConfiguration;
 if(bambu){
  const machine=(await resolveBambuPreset({resourceRoot:resources,kind:'machine',name:'Bambu Lab A1 0.4 nozzle'})).settings;
  const processPreset=(await resolveBambuPreset({resourceRoot:resources,kind:'process',name:machine.default_print_profile})).settings;
  const filament=(await resolveBambuPreset({resourceRoot:resources,kind:'filament',name:'Generic PLA @BBL A1'})).settings;
  Object.assign(processPreset,{curr_bed_type:'Textured PEI Plate',sparse_infill_density:'15%',sparse_infill_pattern:'grid',top_shell_layers:'0',bottom_shell_layers:'0'});
  effectiveConfiguration={engineAdapter:BAMBU_ENGINE_KEY,bambuConfig:{version:1,machine,process:processPreset,filament}};
 }else effectiveConfiguration={prusaConfig:{printer_technology:'FFF',gcode_flavor:'klipper',bed_shape:'0x0,200x0,200x200,0x200',max_print_height:200,nozzle_diameter:.4,filament_diameter:1.75,filament_density:1.24,extrusion_multiplier:1,layer_height:.2,first_layer_height:.2,perimeters:2,top_solid_layers:0,bottom_solid_layers:0,fill_density:'15%',fill_pattern:'grid',temperature:205,first_layer_temperature:210,bed_temperature:55,first_layer_bed_temperature:60,start_gcode:'',end_gcode:'',pause_print_gcode:'PAUSE'}};
 const platePath=path.join(workDir,'plate.3mf');
 const args=argumentsFor(bambu,[{...modifier,shape}]);args.pauseGcode=bambu?effectiveConfiguration.bambuConfig.machine.machine_pause_gcode:effectiveConfiguration.prusaConfig.pause_print_gcode;
 await fs.writeFile(platePath,buildAdvancedPlate3mf(args));
 const result=await (bambu?runBambuEngine:runSlicerEngine)({config,workDir,plateInputPaths:[platePath],effectiveConfiguration,pausePoints:args.pausePoints});
 const gcode=await fs.readFile(result.gcodePath,'utf8');
 verifyNativePauseEvents({gcode,pausePoints:args.pausePoints,bambu});
 assert.ok(bambu?gcode.includes('; PAUSE_PRINT'):gcode.includes(';PAUSE_PRINT'),'native pause event was generated');
 const layers=gcode.split(bambu?/; CHANGE_LAYER\n/:/;LAYER_CHANGE\n/);
 const layerAt=z=>layers.find(layer=>Number(layer.match(bambu?/; Z_HEIGHT: ([\d.]+)/:/;Z:([\d.]+)/)?.[1])===z);
 const extrusionMoves=layer=>(layer.match(/\bX[-\d.]+ Y[-\d.]+[^\n]* E/g)||[]).length;
 assert.ok(infillLength(layerAt(1.2))>infillLength(layerAt(7.2))*2,'dense infill is confined to the modifier height');
 const pauseLayer=layers.find(layer=>layer.includes('PAUSE_PRINT'));
 assert.equal(Number(pauseLayer.match(bambu?/; Z_HEIGHT: ([\d.]+)/:/;Z:([\d.]+)/)?.[1]),5.2,'pause occurs on the requested layer');
 assert.ok(pauseLayer.indexOf(bambu?'M400 U1':'\nPAUSE')<pauseLayer.search(bambu?/; FEATURE: (?:Inner|Outer) wall/:/;TYPE:(?:External perimeter|Perimeter)/),'pause precedes layer extrusion');
 assert.ok(result.metrics.layerCount>20);
 // Identical overlapping modifier boundaries must have the same precedence in
 // each native engine: the later region wins, including a zero-infill region.
 const first=args.sources[0].object.modifiers[0];
 args.sources[0].object.modifiers.push({...first,id:'region-2',name:'Later hollow region',printOverrides:{fill_density:0}});
 await fs.writeFile(platePath,buildAdvancedPlate3mf(args));
 const second=await(bambu?runBambuEngine:runSlicerEngine)({config,workDir,plateInputPaths:[platePath],effectiveConfiguration,pausePoints:args.pausePoints});
 const secondCode=await fs.readFile(second.gcodePath,'utf8'),secondLayers=secondCode.split(bambu?/; CHANGE_LAYER\n/:/;LAYER_CHANGE\n/);
 const low=secondLayers.find(layer=>Number(layer.match(bambu?/; Z_HEIGHT: ([\d.]+)/:/;Z:([\d.]+)/)?.[1])===1.2);
 assert.ok(infillLength(low)<infillLength(layerAt(1.2))/2,'later overlapping modifier has precedence');
});

test('assembled plates preserve independent transformed parts, regions and painted triangle identity', () => {
 const painted=zipSync({'3D/3dmodel.model':strToU8(model.replace('v3="1"','v3="1" slic3rpe:paint_supports="1"'))});
 for(const bambu of [false,true]){
  const args=argumentsFor(bambu);args.sources[0].source=painted;
  args.sources[0].objectTransform=buildPlateObjectTransform({transform:{positionMm:{x:70,y:80,z:0},rotationDeg:{x:0,y:0,z:90},scale:{x:2,y:1,z:1}},coordinateMapping:{projectOrigin:'center',engineBedOrigin:'center',translationMm:{x:0,y:0,z:0}}});
  args.sources.push({...args.sources[0],source,object:{name:'Second',modifiers:[]},objectTransform:buildPlateObjectTransform({transform:transform(130,80),coordinateMapping:{projectOrigin:'center',engineBedOrigin:'center',translationMm:{x:0,y:0,z:0}}})});
  const files=textEntries(buildAdvancedPlate3mf(args)),xml=files['3D/3dmodel.model'];
  assert.equal((xml.match(/<item objectid=/g)||[]).length,2);
  assert.match(xml,/paint_supports="1"/);
  assert.match(xml,/<vertex x="80" y="60" z="0"/,'parent rotation and nonuniform scale apply to source geometry');
  assert.match(files[bambu?'Metadata/model_settings.config':'Metadata/Slic3r_PE_model.config'],/Solid lower half/);
 }
 const overflow=argumentsFor(false);overflow.sources[0].objectTransform[0]=Number.MAX_VALUE;
 assert.throws(()=>buildAdvancedPlate3mf(overflow),/finite|transform/i);
 const cyclic=argumentsFor(false);cyclic.sources[0].source=zipSync({'3D/3dmodel.model':strToU8('<model><resources><object id="1"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build></model>')});
 assert.throws(()=>buildAdvancedPlate3mf(cyclic),/recursive/);
});
