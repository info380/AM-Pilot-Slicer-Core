import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedBambuMachineOverrides,assertBambuMachineOverrideResult,prepareBambuMachineProject,rewriteReviewedBambuProject} from '../src/bambu-machine-project.js';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
const machine={nozzle_diameter:['0.4'],nozzle_volume_type:['Standard'],machine_max_acceleration_travel:['13000','9000'],machine_end_gcode:'; reviewed'};
const ownership={motionOverrides:{machine_max_acceleration_travel:13000},gcodeOverrides:{machine_end_gcode:'; reviewed'}};
test('only matching reviewed limits and script hooks enter native project preparation',()=>{
  assert.deepEqual(reviewedBambuMachineOverrides(ownership,machine),{motion:ownership.motionOverrides,scripts:ownership.gcodeOverrides});
  for(const bad of [{motionOverrides:[]},{motionOverrides:{printer_model:13000}},{motionOverrides:{machine_max_acceleration_travel:NaN}},{motionOverrides:{machine_max_acceleration_travel:9000}},{gcodeOverrides:{post_process:'touch /tmp/no'}},{gcodeOverrides:{machine_end_gcode:'mismatch'}}])assert.throws(()=>reviewedBambuMachineOverrides(bad,machine));
});
test('an engine reduction or changed script fails closed before accepting the print archive',()=>{
  assert.doesNotThrow(()=>assertBambuMachineOverrideResult(ownership,machine,machine));
  for(const settings of [{...machine,machine_max_acceleration_travel:['6000','6000']},{...machine,machine_end_gcode:'base'}])assert.throws(()=>assertBambuMachineOverrideResult(ownership,machine,settings),/No print file was accepted/);
});
test('all metadata handoffs require explicit byte bounds',async()=>{
  await assert.rejects(prepareBambuMachineProject({presets:{machine},config:{},sourcePath:'geometry.3mf'}),/byte limit/);
  await assert.rejects(prepareBambuMachineProject({ownership,presets:{machine},config:{},sourcePath:'geometry.3mf'}),/byte limit/);
});
test('native project rewriting preserves geometry and blocks traversal, expansion and identity changes',()=>{
  const presets={machine:{...machine,printer_model:'Bambu Lab A1',nozzle_diameter:['0.4'],name:'A1'},process:{name:'Process'},filament:{name:'PLA',filament_colour:['#AABBCC']}};
  const entries={'3D/3dmodel.model':strToU8('<model>unchanged</model>'),'Metadata/project_settings.config':strToU8(JSON.stringify({printer_model:'Bambu Lab A1',nozzle_diameter:['0.4']}))};
  const output=unzipSync(rewriteReviewedBambuProject(zipSync(entries),presets,65536));
  assert.deepEqual(output['3D/3dmodel.model'],entries['3D/3dmodel.model']);
  assert.equal(JSON.parse(strFromU8(output['Metadata/project_settings.config'])).machine_max_acceleration_travel[0],'13000');
  for(const bad of [{...entries,'../escape':strToU8('bad')},{...entries,'metadata/PROJECT_SETTINGS.config':strToU8('{}')},{...entries,'large':new Uint8Array(131072)},{...entries,'Metadata/project_settings.config':strToU8('{')},{...entries,'Metadata/project_settings.config':strToU8(JSON.stringify({printer_model:'other',nozzle_diameter:['0.4']}))}])assert.throws(()=>rewriteReviewedBambuProject(zipSync(bad),presets,65536));
});

test('explicit handoff metadata preserves model, modifier, placement and layer-event entries',async()=>{
 const {applyBambuHandoffMetadata,bambuHandoffArguments}=await import('../src/bambu-machine-project.js');
 const presets={machine,process:{},filament:{filament_colour:['#919191']}};
 const xml='<config><object id="1"><part id="2"><metadata key="type" value="modifier_part"/></part></object><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate></config>';
 const files={'3D/3dmodel.model':strToU8('<model>same mesh and transforms</model>'),'Metadata/model_settings.config':strToU8(xml),
 'Metadata/custom_gcode_per_layer.xml':strToU8('<custom_gcodes>same pauses</custom_gcodes>')};
 const before=structuredClone(files);applyBambuHandoffMetadata(files,presets);
 assert.deepEqual(files['3D/3dmodel.model'],before['3D/3dmodel.model']);
 assert.deepEqual(files['Metadata/custom_gcode_per_layer.xml'],before['Metadata/custom_gcode_per_layer.xml']);
 const metadata=strFromU8(files['Metadata/model_settings.config']);
 assert.equal(metadata.replace('<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"/>',''),xml);
 assert.deepEqual(JSON.parse(strFromU8(files['Metadata/project_settings.config'])).filament_colour,['#919191']);
 assert.deepEqual(bambuHandoffArguments({machine:'/snapshot/m.json',process:'/snapshot/p.json'},presets),
 ['--uptodate','--uptodate-settings','/snapshot/m.json;/snapshot/p.json','--filament-colour','#919191']);
 const once=structuredClone(files);applyBambuHandoffMetadata(files,presets);assert.deepEqual(files,once);
 for(const bad of [{machine:{...machine,nozzle_volume_type:[]},filament:presets.filament},{machine,filament:{}},{machine,filament:{filament_colour:['#FFFFFF','#000000']}}])assert.throws(()=>applyBambuHandoffMetadata(structuredClone(before),bad));
 for(const badXml of [xml.replace('</plate>','<nozzle id="0" extruder_id="1" nozzle_diameter="0.6" volume_type="Standard"/></plate>'),xml.replace('</plate>','</plate><plate/>'),xml.replace('<config>','<!DOCTYPE config><config>')]){
  const malformed={...before,'Metadata/model_settings.config':strToU8(badXml)};
  assert.throws(()=>applyBambuHandoffMetadata(malformed,presets));
 }
});
