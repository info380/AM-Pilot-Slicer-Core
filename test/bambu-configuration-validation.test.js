import test from 'node:test';
import assert from 'node:assert/strict';
import serialization from '../schemas/bambu-serialization-2.8.2.61.json' with {type:'json'};
import {expectedBambuRuntimeSettings,verifyBambuRuntimeSettings} from '../src/bambu-configuration-validation.js';
import {classifyBambuDiagnostics} from '../src/bambu-diagnostics.js';

const presets=()=>({machine:{name:'Reviewed machine',nozzle_diameter:['0.4'],nozzle_volume_type:['Standard'],machine_end_gcode:'M400\n; explicit script'},
 process:{name:'Reviewed process',layer_height:'0.17',wall_loops:'3',ironing_flow:'17%',bottom_surface_density:'100',outer_wall_speed:'200',best_object_pos:'0.5x0.5',enable_prime_tower:'1'},
 filament:{name:'Reviewed material',filament_type:['PLA'],filament_colour:['#919191'],filament_flow_ratio:['0.97']}});
const output=p=>({...expectedBambuRuntimeSettings(p),outer_wall_speed:['200']});
test('every active requested field is checked without mutating its immutable settings',()=>{
 const p=presets(),before=structuredClone(p),actual=output(p);
 assert.equal(verifyBambuRuntimeSettings(p,actual).verifiedFields,Object.keys(actual).length);
 assert.deepEqual(p,before);
 for(const key of Object.keys(actual)){
  const missing=structuredClone(actual);delete missing[key];assert.throws(()=>verifyBambuRuntimeSettings(p,missing),{code:'slicer_bambu_settings_mismatch'},key);
  assert.throws(()=>verifyBambuRuntimeSettings(p,{...actual,[key]:null}),{code:'slicer_bambu_settings_mismatch'},key);
 }
 assert.throws(()=>verifyBambuRuntimeSettings({...p,process:{...p.process,unknown_future_setting:'1'}},actual),/unknown_future_setting/);
 assert.throws(()=>verifyBambuRuntimeSettings(p,{...actual,outer_wall_speed:['200','200']}),/outer_wall_speed/);
 assert.throws(()=>verifyBambuRuntimeSettings(p,{...actual,machine_end_gcode:'M400\n; modified'}),/machine_end_gcode/);
});
test('only the pinned serializer conversions are accepted',()=>{
 const p=presets(),actual=output(p);
 assert.doesNotThrow(()=>verifyBambuRuntimeSettings(p,{...actual,bottom_surface_density:'100%'}));
 assert.throws(()=>verifyBambuRuntimeSettings(p,{...actual,bottom_surface_density:'99%'}),/bottom_surface_density/);
 assert.equal(actual.enable_prime_tower,'0');assert.equal(actual.best_object_pos,'0.5,0.5');
 assert.doesNotThrow(()=>verifyBambuRuntimeSettings(p,{...actual,layer_height:0.17}));
 assert.throws(()=>verifyBambuRuntimeSettings(p,{...actual,layer_height:['0.17']}),/layer_height/);
 assert.throws(()=>verifyBambuRuntimeSettings(p,{...actual,layer_height:'0.17001'}),/layer_height/);
 for(const field of serialization.scalarVariantFields){
  const specimen={...p,process:{...p.process,[field]:'1.5'}};
  assert.doesNotThrow(()=>verifyBambuRuntimeSettings(specimen,{...output(specimen),[field]:['1.5']}),field);
 }
 const nullable={...p,filament:{...p.filament,filament_long_retractions_when_ec:['nil']}};
 assert.doesNotThrow(()=>verifyBambuRuntimeSettings(nullable,actual));
 assert.throws(()=>verifyBambuRuntimeSettings(nullable,{...actual,filament_long_retractions_when_ec:['1']}),/filament_long_retractions_when_ec/);
 assert.throws(()=>verifyBambuRuntimeSettings({...p,filament:{...p.filament,filament_long_retractions_when_ec:['1']}},actual),/filament_long_retractions_when_ec/);
 const legacy={...p,process:{...p.process,wall_infill_order:'inner wall/outer wall/infill'}};
 assert.equal(expectedBambuRuntimeSettings(legacy).wall_sequence,'inner wall/outer wall');
 assert.equal(expectedBambuRuntimeSettings({...legacy,process:{...legacy.process,wall_sequence:'outer wall/inner wall'}}).wall_sequence,'outer wall/inner wall');
});
test('routine native diagnostics remain recorded and unknown or repair warnings remain visible',()=>{
 const lines=['cli mode, Current BambuStudio Version 02.08.02.61','4191: disable_wipe_tower_after_mapping: disable prime tower for only one filament!',
  'only 1 filament colour,  finally set disable_wipe_tower_after_mapping to true','run:2873, can not find system preset file: /missing',
  'no filament colors found in projects','load_nozzle_infos_with_compatibility: building nozzle list from filament map and volume types','mesh repaired: non-manifold',
  'cli mode, Current BambuStudio Version 02.08.02.61 unexpected warning'];
 const stdout=lines.map(line=>'[2026-11-06 12:26:57.210057] [0x000074a9326c9540] [warning] '+line).join('\n');
 const context={engineVersion:serialization.engineVersion,singleFilament:true,primeTowerDisabled:true};
 const result=classifyBambuDiagnostics({stdout,stderr:''},context);
 assert.equal(result.diagnostics.length,3);assert.equal(result.warnings.length,5);assert.ok(result.diagnostics.every(d=>d.severity==='info'&&stdout.includes(d.message)));
 assert.equal(classifyBambuDiagnostics({stdout}, {...context,engineVersion:'future'}).warnings.length,8);
 assert.equal(classifyBambuDiagnostics({stdout}, {...context,singleFilament:false}).warnings.length,7);
 assert.equal(classifyBambuDiagnostics({stdout}, {...context,primeTowerDisabled:false}).warnings.length,7);
});
