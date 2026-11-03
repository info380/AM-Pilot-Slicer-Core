import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { materializePlateInputs } from '../src/plate.js';
import { runBambuEngine, BAMBU_ENGINE_KEY } from '../src/bambu-engine.js';
import { resolveBambuPreset } from '../src/bambu-presets.js';
import { compileProductionToolpath } from '../src/toolpath.js';
import { DEFAULTS } from '../src/constants.js';
const required = key => {if(!process.env[key])throw Error(`${key} is required for this synthetic benchmark.`);return process.env[key];};
const root=required('SLICER_BENCHMARK_OUTPUT_DIR');if(!path.isAbsolute(root))throw Error('Benchmark output directory must be absolute.');
await fs.mkdir(root,{recursive:true});if((await fs.readdir(root)).length)throw Error('Benchmark output directory must be empty.');
const resources=required('BAMBU_STUDIO_INTEGRATION_RESOURCES');
const presets={machine:(await resolveBambuPreset({resourceRoot:resources,kind:'machine',name:'Bambu Lab A1 0.4 nozzle'})).settings};
for(const [kind,name] of [['process',presets.machine.default_print_profile],['filament','Generic PLA @BBL A1']])presets[kind]=(await resolveBambuPreset({resourceRoot:resources,kind,name})).settings;
presets.process.curr_bed_type='Textured PEI Plate';presets.process.enable_support='0';
// Closed torus: 16,384 source facets, no customer geometry.
const nu=128,nv=64,faces=[];
const point=(u,v)=>{const a=u/nu*Math.PI*2,b=v/nv*Math.PI*2;return [(9+3*Math.cos(b))*Math.cos(a),(9+3*Math.cos(b))*Math.sin(a),3+3*Math.sin(b)];};
for(let u=0;u<nu;u++)for(let v=0;v<nv;v++){const a=point(u,v),b=point(u+1,v),c=point(u+1,v+1),d=point(u,v+1);faces.push([a,b,c],[a,c,d]);}
const stl=Buffer.alloc(84+faces.length*50);stl.writeUInt32LE(faces.length,80);faces.forEach((f,i)=>f.flat().forEach((x,j)=>stl.writeFloatLE(x,84+i*50+12+j*4)));
const sourcePath=path.join(root,'source.stl');await fs.writeFile(sourcePath,stl);
const effectiveConfiguration={engineAdapter:BAMBU_ENGINE_KEY,bambuConfig:{version:1,...presets},coordinateMapping:{projectOrigin:'center',engineBedOrigin:'front_left',translationMm:{x:128,y:128,z:0}}};
const config={...DEFAULTS,prusaSlicerCommand:required('PRUSA_SLICER_INTEGRATION_CMD'),bambuStudioCommand:required('BAMBU_STUDIO_INTEGRATION_CMD'),maximumArchiveBytes:134217728,maximumExpandedArchiveBytes:268435456,jobTimeoutMs:300000,engineKey:BAMBU_ENGINE_KEY,engineCpuAffinity:process.env.SLICER_TEST_CPU_AFFINITY||'none'};
const report=[];
const counts=(process.env.SLICER_BENCHMARK_COUNTS||'1,10').split(',').map(Number);
if(!counts.length||counts.some(n=>!Number.isSafeInteger(n)||n<1||n>10))throw Error('This fixed synthetic layout supports 1 to 10 objects.');
for(const count of counts){
 const workDir=path.join(root,'plate-'+count);await fs.mkdir(workDir,{recursive:true});
 const inputSnapshot={schema:'am-pilot-slicer-input-snapshot',version:1,models:[{modelId:'synthetic',projectFileId:'file',sourceFormat:'stl',checksumSha256:createHash('sha256').update(stl).digest('hex'),sizeBytes:stl.length}],plate:{geometry:{heightMm:256},objects:Array.from({length:count},(_,i)=>({id:'object-'+i,definitionId:'synthetic-linked',name:'Synthetic torus',fileId:'file',...(process.env.SLICER_BENCHMARK_REGION?{modifiers:[{id:'region',name:'Lower density',shape:'box',sizeMm:{x:30,y:30,z:3},transform:{positionMm:{x:0,y:0,z:1.5},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},printOverrides:{fill_density:30}}]}:{}),placement:{status:'placed'},printOverrides:{},transform:{positionMm:{x:(i%5)*35-70,y:Math.floor(i/5)*35-20,z:0},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}}}))}};
 const start=performance.now();const paths=await materializePlateInputs({inputSnapshot,effectiveConfiguration,downloadedModels:new Map([['synthetic',sourcePath]]),workDir,config});const prepared=performance.now();
 const result=await runBambuEngine({plateInputPaths:paths,effectiveConfiguration,workDir,config});const sliced=performance.now();
 const preview=await compileProductionToolpath({gcodePath:result.gcodePath,workDir,run:{id:'synthetic',engineKey:BAMBU_ENGINE_KEY},effectiveConfiguration,gcodeArtifact:result.artifact,sliceEvidenceChecksumSha256:'a'.repeat(64),summary:result.metrics,maximumBytes:config.maximumToolpathPreviewBytes});const done=performance.now();
 const entry={count,trianglesPerSource:faces.length,preparationMs:Math.round(prepared-start),slicingAndValidationMs:Math.round(sliced-prepared),previewMs:Math.round(done-sliced),totalMs:Math.round(done-start),plateBytes:(await fs.stat(paths[0])).size,gcodeBytes:result.artifact.sizeBytes,previewBytes:preview.artifact.sizeBytes,metrics:result.metrics};report.push(entry);console.log(JSON.stringify(entry));await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
}

const resourceEvidence=process.platform==='linux'?{memoryPeakBytes:Number(await fs.readFile('/sys/fs/cgroup/memory.peak','utf8')),cpuMax:(await fs.readFile('/sys/fs/cgroup/cpu.max','utf8')).trim()}:null;
await fs.writeFile(path.join(root,'environment.json'),JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node,sourceChecksumSha256:createHash('sha256').update(stl).digest('hex'),engineCpuAffinity:config.engineCpuAffinity,engineThreads:config.engineThreads,resourceEvidence},null,2));
