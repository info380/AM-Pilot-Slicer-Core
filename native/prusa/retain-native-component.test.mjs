import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {verifyNativeIdentity,verifyNativeEvidence,verifyNativeSignatureClaims} from './retain-native-component.mjs';
const hash=x=>createHash('sha256').update(x).digest('hex');
const fixture=()=>{
 const log=Buffer.from('sha256:'+'b'.repeat(64)+'\nok 2 - native statistics exporter preserves stock Prusa G-code bytes\n# fail 0\n# skipped 0\n');
 const source=Buffer.from('synthetic source'),scan=Buffer.from('synthetic standalone runtime scan');
 const plan={schema:'am-pilot-prusa-native-statistics-component',version:1,repository:'info380/AM-Pilot-Slicer-Core',repositoryId:1,
 sourceRevision:'a'.repeat(40),image:'ghcr.io/info380/am-pilot-slicer-core@sha256:'+'b'.repeat(64),buildRunId:2,jobId:3,
 binarySha256:'c'.repeat(64),patchSha256:'d'.repeat(64),jobLogSha256:hash(log),sourceArchiveSha256:hash(source),standaloneScanSha256:hash(scan),
 reusedPaths:['/opt/prusa'],standaloneRuntimeIncluded:false,standaloneRuntimeScan:'failure'};
 const run={id:2,head_sha:plan.sourceRevision,repository:{id:1,full_name:plan.repository},path:'.github/workflows/release.yml',event:'workflow_dispatch',status:'completed',conclusion:'failure'};
 const job={id:3,run_id:2,head_sha:plan.sourceRevision,status:'completed',conclusion:'failure',steps:[
 ...['Build and publish immutable image','Sign immutable image digest','Verify published PrusaSlicer runtime through the worker process boundary',
 'Qualify the native statistics exporter against stock G-code'].map(name=>({name,conclusion:'success'})),{name:'Scan immutable image digest',conclusion:'failure'}]};
 const provenance={buildDefinition:{externalParameters:{request:{args:{'label:org.opencontainers.image.revision':plan.sourceRevision,'label:org.opencontainers.image.source':'https://github.com/'+plan.repository}}},
 internalParameters:{github_workflow_sha:plan.sourceRevision,github_run_id:'2',targetPlatform:'linux/amd64'}}};
 return {plan,run,job,log,source,scan,provenance};
};

test('native reuse requires signed build, passed stock parity and explicit standalone runtime exclusion',()=>{
 const {plan,run,job}=fixture();verifyNativeIdentity(plan,run,job);
 assert.throws(()=>verifyNativeIdentity({...plan,standaloneRuntimeIncluded:true},run,job));
 assert.throws(()=>verifyNativeIdentity({...plan,reusedPaths:['/']},run,job));
 for(const name of ['Build and publish immutable image','Sign immutable image digest','Qualify the native statistics exporter against stock G-code']) {
  assert.throws(()=>verifyNativeIdentity(plan,run,{...job,steps:job.steps.map(s=>s.name===name?{...s,conclusion:'failure'}:s)}));
 }
 assert.throws(()=>verifyNativeIdentity(plan,{...run,head_sha:'e'.repeat(40)},job));
 assert.throws(()=>verifyNativeIdentity(plan,run,{...job,run_id:4}));
 assert.throws(()=>verifyNativeIdentity(plan,run,{...job,steps:[...job.steps,{name:'Unrelated failure',conclusion:'failure'}]}));
});

test('native reuse binds the complete proof and source to the exact image provenance',()=>{
 const f=fixture();verifyNativeEvidence(f.plan,f.log,f.source,f.scan,f.provenance);
 for(const key of ['log','source','scan']) {
  const changed={...f,[key]:Buffer.from('changed')};
  assert.throws(()=>verifyNativeEvidence(changed.plan,changed.log,changed.source,changed.scan,changed.provenance));
 }
 const bad=structuredClone(f.provenance);bad.buildDefinition.internalParameters.github_workflow_sha='e'.repeat(40);
 assert.throws(()=>verifyNativeEvidence(f.plan,f.log,f.source,f.scan,bad));
 const skipped=Buffer.from('sha256:'+'b'.repeat(64)+'\nok 2 - native statistics exporter preserves stock Prusa G-code bytes\n# fail 0\n# skipped 1\n');
 assert.throws(()=>verifyNativeEvidence({...f.plan,jobLogSha256:hash(skipped)},skipped,f.source,f.scan,f.provenance));
});


test('native signature claims bind the signed image to its workflow source revision',()=>{
 const {plan}=fixture();
 const signatures=[{critical:{image:{'docker-manifest-digest':plan.image.split('@')[1]}},optional:{Issuer:'https://token.actions.githubusercontent.com',
 githubWorkflowRepository:plan.repository,githubWorkflowSha:plan.sourceRevision,githubWorkflowTrigger:'workflow_dispatch'}}];
 verifyNativeSignatureClaims(plan,signatures);
 assert.throws(()=>verifyNativeSignatureClaims(plan,[]));
 for(const [key,value] of [['githubWorkflowSha','e'.repeat(40)],['githubWorkflowRepository','other/repo'],['Issuer','https://untrusted.example']]) {
  const changed=structuredClone(signatures);changed[0].optional[key]=value;assert.throws(()=>verifyNativeSignatureClaims(plan,changed));
 }
 const changed=structuredClone(signatures);changed[0].critical.image['docker-manifest-digest']='sha256:'+'e'.repeat(64);
 assert.throws(()=>verifyNativeSignatureClaims(plan,changed));
});
