import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseNativeStatistics,readNativeStatistics,nativeFeatureCatalog} from '../src/native-feature-statistics.js';

const bambu = () => ({return_code:0,sliced_plates:[{id:1,total_predication:120,main_predication:100,
  feature_type_times:{'Outer wall':60,'Bottom surface':10,'Gap infill':2,'Internal solid infill':20,Travel:8,Undefined:8}}]});
test('preserves native Bambu times without double counting Undefined travel',()=>{
  const result=parseNativeStatistics(bambu(),true);
  assert.equal(result.totalTimeSeconds,120);
  assert.deepEqual(result.rows,[{featureId:2,timeSeconds:60},{featureId:18,timeSeconds:10},{featureId:11,timeSeconds:2},{featureId:5,timeSeconds:20},{moveKey:'travel',timeSeconds:8}]);
  assert.equal(result.rows.reduce((sum,row)=>sum+row.timeSeconds,0),100,'Does not scale feature times up to total');
  assert.equal(nativeFeatureCatalog([{id:18,key:'bottom_surface',displayName:'bottom'}],true)[0].displayName,'Bottom surface');
});
test('converts native Prusa role consumption units and preserves movement times',()=>{
  const result=parseNativeStatistics({schemaVersion:1,engine:'PrusaSlicer-2.9.3',totalTimeSeconds:100,
    roles:[[7,12,0.25,0.76],[8,3,1,3.03]],moves:[[8,10],[9,2]]},false);
  assert.deepEqual(result.rows,[{featureId:14,timeSeconds:12,filamentLengthMm:250,filamentMassG:.76},
    {featureId:7,timeSeconds:3,filamentLengthMm:1000,filamentMassG:3.03},{moveKey:'travel',timeSeconds:10},{moveKey:'wipe',timeSeconds:2}]);
});
test('fails closed for malformed, ambiguous, oversized and unsupported native reports',async t=>{
  for(const change of [r=>r.return_code=1,r=>r.sliced_plates.push(r.sliced_plates[0]),r=>r.sliced_plates[0].id=2,
    r=>r.sliced_plates[0].feature_type_times['New unknown role']=1,r=>r.sliced_plates[0].feature_type_times.Travel=-1,
    r=>r.sliced_plates[0].total_predication=NaN,r=>r.sliced_plates[0].main_predication=121]) {
    const report=bambu();change(report);assert.throws(()=>parseNativeStatistics(report,true));
  }
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-report-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const file=path.join(root,'result.json');await fs.writeFile(file,JSON.stringify(bambu()));
  assert.match((await readNativeStatistics(file,true)).reportChecksumSha256,/^[a-f0-9]{64}$/);
  await fs.writeFile(file,' '.repeat(262145));await assert.rejects(readNativeStatistics(file,true));
  await fs.writeFile(file,'{');await assert.rejects(readNativeStatistics(file,true));
  await fs.unlink(file);await fs.symlink(root,file);await assert.rejects(readNativeStatistics(file,true));
});
