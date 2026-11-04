import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validatePlan, trialOrder, parseCpuList, median, digestObject, selectCpuSet } from './contract.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const execute=(args,options={})=>{
 const result=spawnSync('docker',args,{encoding:'utf8',maxBuffer:16*1024*1024,timeout:120_000,...options});
 assert.equal(result.status,0,`Docker operation failed: ${result.error?.message||result.stderr?.slice(-4000)||result.stdout?.slice(-4000)}`);
 return result.stdout;
};
export const summarize=(plan,runs)=>{
 const groups=[];
 for(const engine of plan.engines)for(const fixture of plan.fixtures){
  const baseline=runs.filter(r=>r.trial.engine===engine&&r.trial.fixture===fixture&&r.trial.id==='q1-t1');if(!baseline.length)continue;
  const baselineMs=median(baseline.map(r=>r.durationsMs.nativeSubprocess));
  for(const item of plan.cases){
   const values=runs.filter(r=>r.trial.engine===engine&&r.trial.fixture===fixture&&r.trial.id===item.id);if(!values.length)continue;
   const times=values.map(r=>r.durationsMs.nativeSubprocess),settings=new Set([...baseline,...values].map(r=>r.nativeSettingsChecksum));
   groups.push({engine,fixture,...item,repeats:values.length,nativeMedianMs:median(times),nativeMinMs:Math.min(...times),nativeMaxMs:Math.max(...times),
    speedupVsOneCpuOneThread:baselineMs/median(times),adapterMedianMs:median(values.map(r=>r.durationsMs.adapterTotal)),
    nativeCpuSecondsMedian:median(values.map(r=>r.cpu.native.usage_usec/1e6)),peakMemoryBytes:Math.max(...values.map(r=>r.memoryPeakBytes)),
    nativeSettingsMatchBaseline:settings.size===1,inputRecipesMatchBaseline:new Set([...baseline,...values].map(r=>r.recipeChecksum)).size===1,
    preparedGeometryMatchBaseline:new Set([...baseline,...values].map(r=>JSON.stringify(r.preparedPlateChecksums))).size===1,
    gcodeCommandsUnique:new Set(values.map(r=>r.gcode.commandsSha256)).size,baselineGcodeCommandsUnique:new Set(baseline.map(r=>r.gcode.commandsSha256)).size,
    layerCounts:[...new Set(values.map(r=>r.metrics.layerCount))],filamentLengthMm:{min:Math.min(...values.map(r=>r.metrics.filamentLengthMm)),max:Math.max(...values.map(r=>r.metrics.filamentLengthMm))},
    estimatedTimeSeconds:{min:Math.min(...values.map(r=>r.metrics.estimatedTimeSeconds)),max:Math.max(...values.map(r=>r.metrics.estimatedTimeSeconds))},
    peakObservedNativeThreads:Math.max(...values.flatMap(r=>r.observedNativeProcesses.filter(p=>p.stage==='slicing').map(p=>p.peakThreads)))});
  }
 }
 return groups;
};
export async function main(args=process.argv.slice(2)){
 const [mode='validate',profile='full',destination,engine='all',fixture='all']=args;assert(['validate','run'].includes(mode));
 const plan=validatePlan(JSON.parse(await fs.readFile(path.join(here,'plan.json'),'utf8'))),trials=trialOrder(plan,profile,engine,fixture);
 if(mode==='validate'){console.log(JSON.stringify({profile,trials:trials.length,maximumCpus:4,memoryBytes:plan.memoryBytes,execution:'sequential; manual only',image:plan.image}));return;}
 assert(engine!=='all'&&fixture!=='all','Select one engine/workload per bounded native job');
 assert(process.platform==='linux'&&process.arch==='x64','Measurements require a native Linux x64 host; emulated measurements are not accepted.');
 assert(destination&&path.isAbsolute(destination),'An explicit absolute evidence directory is required');
 assert(process.getuid()>0,'Run the benchmark controller as a non-root user');
 const info=JSON.parse(execute(['info','--format','{{json .}}']));assert.equal(info.OSType,'linux');assert(['x86_64','amd64'].includes(info.Architecture));assert.equal(info.CgroupVersion,'2');
 const allowed=parseCpuList(/^Cpus_allowed_list:\s*(\S+)/m.exec(await fs.readFile('/proc/self/status','utf8'))[1]);assert(allowed.length>=4&&info.NCPU>=4,'The full plan needs four permitted CPUs');
 const cpus=allowed.slice(0,4);await fs.mkdir(destination,{recursive:false,mode:0o755});
 const topology=await Promise.all(cpus.map(async cpu=>({cpu,coreId:(await fs.readFile(`/sys/devices/system/cpu/cpu${cpu}/topology/core_id`,'utf8')).trim(),packageId:(await fs.readFile(`/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id`,'utf8')).trim()})));
 const cpuDescription=(await fs.readFile('/proc/cpuinfo','utf8')).split('\n').find(l=>l.startsWith('model name'))||'unreported';
 execute(['pull',plan.image]);const labels=JSON.parse(execute(['image','inspect',plan.image,'--format','{{json .Config.Labels}}']));assert.equal(labels['org.opencontainers.image.revision'],plan.workerRevision);
 const prepared=path.join(destination,'prepared');await fs.mkdir(prepared,{mode:0o755});
 const evidence={schema:'am-pilot-native-cpu-scaling',version:1,startedAt:new Date().toISOString(),plan,planChecksum:digestObject(plan),profile,selection:{engine,fixture},
  environment:{platform:process.platform,architecture:process.arch,nativeX64:true,cpuDescription,topology,node:process.version,runner:process.env.RUNNER_OS||null,
   githubRunId:process.env.GITHUB_RUN_ID||null,harnessRevision:process.env.GITHUB_SHA||null,workerImageLabels:labels},nativeSettingsEvidence:{},runs:[],summary:[],status:'running',
  limitations:['Synthetic measurements are not a production latency guarantee.','Bambu engineThreads controls CPU affinity; observed process threads are reported separately.','Prusa execution-only threads is excluded from its native physical-settings hash, but recorded separately.','G-code command differences are retained, not silently normalized away beyond whitespace/comments.','Source preparation, queueing, downloads, preview generation and publication are outside the measured native adapter.','No print recipe, production capacity, live worker setting or printer job is changed.']};
 const write=async()=>{evidence.summary=summarize(plan,evidence.runs);await fs.writeFile(path.join(destination,'report.json'),JSON.stringify(evidence,null,2)+'\n');};
 const prefix=`am-pilot-cpu-${process.pid}-${Date.now()}`;let active=null;
 const clean=()=>{if(active){spawnSync('docker',['rm','--force',active],{stdio:'ignore',timeout:15_000});active=null;}};
 process.once('SIGTERM',()=>{clean();process.exit(143);});process.once('SIGINT',()=>{clean();process.exit(130);});
 const common=(name,quota,cpuSet=cpus)=>['run','--rm','--name',name,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges',
  '--memory',String(plan.memoryBytes),'--memory-swap',String(plan.memoryBytes),'--cpus',String(quota),'--cpuset-cpus',cpuSet.join(','),'--pids-limit','256',
  '--user',`${process.getuid()}:${process.getgid()}`,'--tmpfs',`/tmp:rw,nosuid,nodev,size=${plan.temporaryBytes}`,
  '--mount',`type=bind,src=${here},dst=/benchmark,readonly`,'--entrypoint','node'];
 try{
  active=prefix+'-prepare';const preparation=execute([...common(active,1),'--mount',`type=bind,src=${prepared},dst=/prepared`,plan.image,
   '/benchmark/container.mjs','prepare','/benchmark/plan.json','/prepared',profile,engine,fixture],{timeout:180_000});active=null;
  evidence.preparation=JSON.parse(preparation.trim().split('\n').at(-1));await write();
  for(let index=0;index<trials.length;index++){
   const trial={...trials[index],cpuSet:selectCpuSet(topology,trials[index].cpuPlacement,trials[index].engineThreads)};active=prefix+'-'+index;const output=execute([...common(active,trial.cpuQuota,trial.cpuSet),'--mount',`type=bind,src=${prepared},dst=/inputs,readonly`,plan.image,
    '/benchmark/container.mjs','trial','/benchmark/plan.json','/inputs',JSON.stringify(trial)],{timeout:(plan.maximumTrialSeconds+15)*1000});active=null;
   const result=JSON.parse(output.trim().split('\n').at(-1));assert.deepEqual(result.trial,trial);evidence.nativeSettingsEvidence[result.nativeSettingsChecksum]=result.nativeSettings;delete result.nativeSettings;evidence.runs.push(result);await write();
   console.log(`${index+1}/${trials.length} ${trial.engine}/${trial.fixture} ${trial.id} repeat ${trial.repeat+1}: ${result.durationsMs.nativeSubprocess} ms`);
  }
  assert(evidence.summary.every(g=>g.inputRecipesMatchBaseline&&g.preparedGeometryMatchBaseline&&g.nativeSettingsMatchBaseline),'Input or native physical settings changed; inspect report before interpreting speed');
  evidence.status='passed';evidence.finishedAt=new Date().toISOString();await write();
 }catch(error){evidence.status='failed';evidence.error=error.message;await write();throw error;}finally{clean();}
 console.log(JSON.stringify({status:evidence.status,trials:evidence.runs.length,evidence:path.join(destination,'report.json')}));
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))await main();
