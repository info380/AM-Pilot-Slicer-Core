import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewedBambuMachineOverrides,assertBambuMachineOverrideResult,prepareBambuMachineProject,rewriteReviewedBambuProject} from '../src/bambu-machine-project.js';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
const machine={machine_max_acceleration_travel:['13000','9000'],machine_end_gcode:'; reviewed'};
const ownership={motionOverrides:{machine_max_acceleration_travel:13000},gcodeOverrides:{machine_end_gcode:'; reviewed'}};
test('only matching reviewed limits and script hooks enter native project preparation',()=>{
  assert.deepEqual(reviewedBambuMachineOverrides(ownership,machine),{motion:ownership.motionOverrides,scripts:ownership.gcodeOverrides});
  for(const bad of [{motionOverrides:[]},{motionOverrides:{printer_model:13000}},{motionOverrides:{machine_max_acceleration_travel:NaN}},{motionOverrides:{machine_max_acceleration_travel:9000}},{gcodeOverrides:{post_process:'touch /tmp/no'}},{gcodeOverrides:{machine_end_gcode:'mismatch'}}])assert.throws(()=>reviewedBambuMachineOverrides(bad,machine));
});
test('an engine reduction or changed script fails closed before accepting the print archive',()=>{
  assert.doesNotThrow(()=>assertBambuMachineOverrideResult(ownership,machine,machine));
  for(const settings of [{...machine,machine_max_acceleration_travel:['6000','6000']},{...machine,machine_end_gcode:'base'}])assert.throws(()=>assertBambuMachineOverrideResult(ownership,machine,settings),/No print file was accepted/);
});
test('base jobs retain their established geometry path and overrides require explicit byte bounds',async()=>{
  assert.equal(await prepareBambuMachineProject({presets:{machine},sourcePath:'geometry.3mf'}),'geometry.3mf');
  await assert.rejects(prepareBambuMachineProject({ownership,presets:{machine},config:{},sourcePath:'geometry.3mf'}),/byte limit/);
});
test('native project rewriting preserves geometry and blocks traversal, expansion and identity changes',()=>{
  const presets={machine:{...machine,printer_model:'Bambu Lab A1',nozzle_diameter:['0.4'],name:'A1'},process:{name:'Process'},filament:{name:'PLA'}};
  const entries={'3D/3dmodel.model':strToU8('<model>unchanged</model>'),'Metadata/project_settings.config':strToU8(JSON.stringify({printer_model:'Bambu Lab A1',nozzle_diameter:['0.4']}))};
  const output=unzipSync(rewriteReviewedBambuProject(zipSync(entries),presets,65536));
  assert.deepEqual(output['3D/3dmodel.model'],entries['3D/3dmodel.model']);
  assert.equal(JSON.parse(strFromU8(output['Metadata/project_settings.config'])).machine_max_acceleration_travel[0],'13000');
  for(const bad of [{...entries,'../escape':strToU8('bad')},{...entries,'metadata/PROJECT_SETTINGS.config':strToU8('{}')},{...entries,'large':new Uint8Array(131072)},{...entries,'Metadata/project_settings.config':strToU8('{')},{...entries,'Metadata/project_settings.config':strToU8(JSON.stringify({printer_model:'other',nozzle_diameter:['0.4']}))}])assert.throws(()=>rewriteReviewedBambuProject(zipSync(bad),presets,65536));
});
