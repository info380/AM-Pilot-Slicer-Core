import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { buildFixture, prusaRecipe } from './fixture.mjs';
import { validatePlan, sha256, digestObject, parseCpuList, parseCounters, counterDelta, commandChecksum, prusaSettings } from './contract.mjs';
const root='/worker';
const {unzipSync,strFromU8}=createRequire(`${root}/package.json`)('fflate');
const {loadWorkerConfig}=await import(`${root}/src/config.js`);
const {materializePlateInputs}=await import(`${root}/src/plate.js`);
const {runBambuEngine,BAMBU_ENGINE_KEY,verifyBambuStudio}=await import(`${root}/src/bambu-engine.js`);
const {runSlicerEngine,verifyPrusaSlicer}=await import(`${root}/src/engine.js`);
const {resolveBambuPreset}=await import(`${root}/src/bambu-presets.js`);
const cpuStats=async()=>parseCounters(await fs.readFile('/sys/fs/cgroup/cpu.stat','utf8'));
const round=x=>Number(x.toFixed(3));
const configFor=(plan,threads)=>loadWorkerConfig({...process.env,AM_PILOT_API_BASE_URL:'https://api.example.test',
 SLICER_WORKER_CONTROL_TOKEN:'isolated-cpu-scaling-no-network-fixture-token-000000',SLICER_WORKER_ID:'isolated-cpu-scaling',
 SLICER_IMAGE_DIGEST:plan.image.split('@')[1],SLICER_ENGINE_THREADS:String(threads),SLICER_ENGINE_CPU_AFFINITY:'threads',
 SLICER_NORMALIZATION_CACHE_MAX_BYTES:'0',SLICER_JOB_TIMEOUT_MS:String(plan.maximumTrialSeconds*1000)});
const bambuRecipe=async()=>{
 const resourceRoot=path.join(path.dirname(process.env.BAMBU_STUDIO_CMD),'resources/profiles/BBL');
 const machine=(await resolveBambuPreset({resourceRoot,kind:'machine',name:'Bambu Lab A1 0.4 nozzle'})).settings;
 const processSettings=(await resolveBambuPreset({resourceRoot,kind:'process',name:'0.20mm Standard @BBL A1'})).settings;
 const filament=(await resolveBambuPreset({resourceRoot,kind:'filament',name:'Generic PLA @BBL A1'})).settings;
 return {version:1,machine,process:{...processSettings,curr_bed_type:'Textured PEI Plate',enable_support:'0'},filament};
};
const monitorNative=()=>{
 let active=false,stage='adapter-preparation';const observed=new Map();let failure=null;
 const sample=async()=>{if(active)return;active=true;try{
  for(const pid of (await fs.readdir('/proc')).filter(x=>/^\d+$/.test(x)&&Number(x)!==process.pid)){
   let status,exe;try{[status,exe]=await Promise.all([fs.readFile(`/proc/${pid}/status`,'utf8'),fs.readlink(`/proc/${pid}/exe`)]);}catch(error){if(['ENOENT','ESRCH'].includes(error.code))continue;throw error;}
   if(!/^\/opt\/(?:bambu|prusa)\//.test(exe))continue;
   const threads=Number(/^Threads:\s+(\d+)/m.exec(status)?.[1]);const allowed=/^Cpus_allowed_list:\s*(\S+)/m.exec(status)?.[1];
   assert(Number.isSafeInteger(threads)&&threads>0&&allowed);parseCpuList(allowed);
   const key=stage+':'+path.basename(exe),item=observed.get(key)||{stage,binary:path.basename(exe),peakThreads:0,peakRssKiB:0,allowedCpuLists:[],samples:0};
   item.peakThreads=Math.max(item.peakThreads,threads);item.peakRssKiB=Math.max(item.peakRssKiB,Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1]||0));item.samples++;
   if(!item.allowedCpuLists.includes(allowed))item.allowedCpuLists.push(allowed);observed.set(key,item);
  }
 }catch(error){failure=error;}finally{active=false;}};
 const timer=setInterval(()=>void sample(),25);timer.unref();
 return {setStage:value=>{stage=value;},async stop(){clearInterval(timer);while(active)await new Promise(resolve=>setTimeout(resolve,1));if(failure)throw failure;return [...observed.values()];}};
};
export async function main(args=process.argv.slice(2)){
 const [mode,planFile,location,profileOrTrial,selectedEngine='all',selectedFixture='all']=args;assert(['prepare','trial'].includes(mode));
 const plan=validatePlan(JSON.parse(await fs.readFile(planFile,'utf8')));const config=configFor(plan,mode==='trial'?JSON.parse(profileOrTrial).engineThreads:1);
 assert.equal(JSON.parse(await fs.readFile('/worker/package.json','utf8')).version,plan.workerVersion);
 if(mode==='prepare'){
  assert(['smoke','full'].includes(profileOrTrial));await fs.mkdir(location,{recursive:true});await fs.mkdir(config.workRoot,{recursive:true});
  const versions={prusa:await verifyPrusaSlicer(config),bambu:await verifyBambuStudio(config)};
  const presets=await bambuRecipe();const result=[];
  assert(selectedEngine==='all'||plan.engines.includes(selectedEngine));assert(selectedFixture==='all'||plan.fixtures.includes(selectedFixture));
  for(const engine of plan.engines.filter(x=>selectedEngine==='all'||x===selectedEngine))for(const fixture of (profileOrTrial==='smoke'&&selectedFixture==='all'?['linked-ten']:plan.fixtures).filter(x=>selectedFixture==='all'||x===selectedFixture)){
   const workDir=path.join(location,engine,fixture);await fs.mkdir(workDir,{recursive:true});const {sources,inputSnapshot}=buildFixture(fixture);const downloadedModels=new Map();
   for(let i=0;i<sources.length;i++){const p=path.join(workDir,`source-${i}.stl`);await fs.writeFile(p,sources[i]);downloadedModels.set(`source-${i}`,p);}
   const effectiveConfiguration={coordinateMapping:{projectOrigin:'center',engineBedOrigin:'front_left',translationMm:{x:128,y:128,z:0}},
    ...(engine==='bambu'?{engineAdapter:BAMBU_ENGINE_KEY,bambuConfig:presets}:{prusaConfig:prusaRecipe})};
   const paths=await materializePlateInputs({inputSnapshot,effectiveConfiguration,downloadedModels,workDir,config});
   const metadata={engine,fixture,effectiveConfiguration,versions,sourceChecksums:inputSnapshot.models.map(m=>m.checksumSha256),
    plateFiles:paths.map(p=>path.basename(p)),plateChecksums:await Promise.all(paths.map(async p=>sha256(await fs.readFile(p)))),recipeChecksum:digestObject(effectiveConfiguration),
    objects:inputSnapshot.plate.objects.length,facetsPerSource:sources.map(b=>b.readUInt32LE(80))};
   await fs.writeFile(path.join(workDir,'input.json'),JSON.stringify(metadata));result.push(metadata);
  }
  console.log(JSON.stringify({prepared:result}));return;
 }
 const trial=JSON.parse(profileOrTrial);assert(plan.cases.some(c=>c.id===trial.id&&c.cpuQuota===trial.cpuQuota&&c.engineThreads===trial.engineThreads&&c.cpuPlacement===trial.cpuPlacement));assert(plan.engines.includes(trial.engine)&&plan.fixtures.includes(trial.fixture));
 const inputRoot=path.join(location,trial.engine,trial.fixture);const metadata=JSON.parse(await fs.readFile(path.join(inputRoot,'input.json'),'utf8'));
 assert.equal(metadata.recipeChecksum,digestObject(metadata.effectiveConfiguration));const paths=metadata.plateFiles.map(name=>{assert.equal(path.basename(name),name);return path.join(inputRoot,name);});
 assert.deepEqual(await Promise.all(paths.map(async p=>sha256(await fs.readFile(p)))),metadata.plateChecksums);
 const workDir='/tmp/cpu-scaling-trial';await fs.mkdir(workDir,{recursive:true});
 const quota=(await fs.readFile('/sys/fs/cgroup/cpu.max','utf8')).trim().split(' ').map(Number);assert.equal(quota[0]/quota[1],trial.cpuQuota);
 assert.equal(Number(await fs.readFile('/sys/fs/cgroup/memory.max','utf8')),plan.memoryBytes);
 const actualCpuSet=parseCpuList(/^Cpus_allowed_list:\s*(\S+)/m.exec(await fs.readFile('/proc/self/status','utf8'))[1]);assert.deepEqual(actualCpuSet,trial.cpuSet);
 const stages={},counters={},monitor=monitorNative();let result;const started=performance.now();const before=await cpuStats();
 try{result=await(trial.engine==='bambu'?runBambuEngine:runSlicerEngine)({plateInputPaths:paths,effectiveConfiguration:metadata.effectiveConfiguration,workDir,config,onProgress:async update=>{
  stages[update.stage]=performance.now();counters[update.stage]=await cpuStats();monitor.setStage(update.stage);
 }});}finally{var observed=await monitor.stop();}
 const ended=performance.now(),after=await cpuStats();assert(stages.slicing&&stages.validating);
 const nativeObserved=observed.filter(x=>x.stage==='slicing');assert(nativeObserved.length,'Native sampling did not observe the slicing executable');
 if(trial.engine==='bambu')for(const sample of nativeObserved)for(const list of sample.allowedCpuLists)assert.equal(parseCpuList(list).length,trial.engineThreads);
 const gcode=await fs.readFile(result.gcodePath,'utf8');let nativeSettings,excludedExecutionThreads=null,nativeTimings=null;
 if(trial.engine==='bambu'){
  const archive=unzipSync(await fs.readFile(result.archivePath),{filter:entry=>entry.name==='Metadata/project_settings.config'});nativeSettings=JSON.parse(strFromU8(archive['Metadata/project_settings.config']));
  const native=JSON.parse(await fs.readFile(path.join(workDir,'result.json'),'utf8'));nativeTimings={prepareMs:native.prepare_time,exportMs:native.export_time,slicingMs:native.sliced_plates[0].sliced_time};
 }else{({settings:nativeSettings,excludedExecutionThreads}=prusaSettings(gcode));}
 const events=parseCounters(await fs.readFile('/sys/fs/cgroup/memory.events','utf8'));assert.equal(events.oom,0);assert.equal(events.oom_kill,0);
 const report={trial,versions:metadata.versions,fixtureEvidence:{objects:metadata.objects,facetsPerSource:metadata.facetsPerSource,sourceChecksums:metadata.sourceChecksums},
  preparedPlateChecksums:metadata.plateChecksums,recipeChecksum:metadata.recipeChecksum,nativeSettingsChecksum:digestObject(nativeSettings),nativeSettings,excludedExecutionThreads,
  durationsMs:{adapterPreparation:round(stages.slicing-started),nativeSubprocess:round(stages.validating-stages.slicing),validation:round(ended-stages.validating),adapterTotal:round(ended-started)},
  cpu:{adapter:counterDelta(before,after),native:counterDelta(counters.slicing,counters.validating)},observedNativeProcesses:observed,samplingIntervalMs:25,nativeTimings,
  memoryPeakBytes:Number(await fs.readFile('/sys/fs/cgroup/memory.peak','utf8')),memoryEvents:events,cpuMax:quota,
  gcode:{sha256:sha256(gcode),commandsSha256:commandChecksum(gcode),sizeBytes:Buffer.byteLength(gcode)},metrics:result.metrics,warnings:result.warnings};
 console.log(JSON.stringify(report));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))await main();
