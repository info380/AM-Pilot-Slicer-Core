import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {validatePlan,trialOrder,parseCpuList,parseCounters,counterDelta,commandChecksum,prusaSettings,digestObject} from './contract.mjs';
import {buildFixture} from './fixture.mjs';
const plan=JSON.parse(await fs.readFile(new URL('./plan.json',import.meta.url)));
test('measurement plan cannot select mutable images, excessive resources or duplicate cases',()=>{
 assert.equal(validatePlan(plan),plan);
 for(const change of [{image:'ghcr.io/info380/am-pilot-slicer-core-bambu:latest'},{memoryBytes:8e9},{repeats:100},{maximumTrialSeconds:999},{cases:[...plan.cases.slice(0,7),plan.cases[0]]}])assert.throws(()=>validatePlan({...plan,...change}));
 const order=trialOrder(plan,'full');assert.equal(order.length,144);
 for(const engine of plan.engines)for(const fixture of plan.fixtures)for(const c of plan.cases)assert.equal(order.filter(x=>x.engine===engine&&x.fixture===fixture&&x.id===c.id).length,3);
 assert.notDeepEqual(order.slice(0,8).map(x=>x.id),order.slice(48,56).map(x=>x.id));assert.equal(trialOrder(plan,'smoke').length,4);
});
test('fixtures separate repeated instances, distinct sources and a dense single model deterministically',()=>{
 const linked=buildFixture('linked-ten'),unique=buildFixture('unique-ten'),dense=buildFixture('single-dense');
 assert.equal(linked.sources.length,1);assert.equal(linked.inputSnapshot.plate.objects.length,10);
 assert.equal(unique.sources.length,10);assert.equal(new Set(unique.inputSnapshot.models.map(m=>m.checksumSha256)).size,10);
 assert.equal(dense.sources[0].readUInt32LE(80),131072);
 for(const name of plan.fixtures)assert.equal(digestObject(buildFixture(name).inputSnapshot),digestObject(buildFixture(name).inputSnapshot));
});
test('resource evidence rejects malformed CPU sets and counter reversals',()=>{
 assert.deepEqual(parseCpuList('2-3,8,10-11'),[2,3,8,10,11]);for(const value of ['2,2','3-2','a','0-99999'])assert.throws(()=>parseCpuList(value));
 assert.deepEqual(counterDelta(parseCounters('usage_usec 2\nnr_throttled 0'),parseCounters('usage_usec 9\nnr_throttled 1')),{usage_usec:7,nr_throttled:1});
 assert.throws(()=>counterDelta({usage_usec:9},{usage_usec:2}));
});
test('output evidence keeps executable changes while separating only Prusa execution threads',()=>{
 assert.equal(commandChecksum('; comment\nG1 X1 E2 ; extrusion\n'),commandChecksum('G1 X1 E2\n'));
 assert.notEqual(commandChecksum('G1 X1 E2'),commandChecksum('G1 X1 E3'));
 const text='; prusaslicer_config = begin\n; threads = 4\n; layer_height = 0.2\n; prusaslicer_config = end';
 assert.deepEqual(prusaSettings(text),{settings:{layer_height:'0.2'},excludedExecutionThreads:'4'});assert.throws(()=>prusaSettings('; missing'));
});
test('benchmark entrypoints parse and validate without launching Docker',()=>{
 for(const file of ['contract.mjs','fixture.mjs','container.mjs','run.mjs'])assert.equal(spawnSync(process.execPath,['--check',`qualification/cpu-scaling/${file}`]).status,0);
 const result=spawnSync(process.execPath,['qualification/cpu-scaling/run.mjs','validate','full'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).trials,144);
});
test('hosted measurements remain one bounded manual-only job without production credentials',async()=>{
 const workflow=await fs.readFile(new URL('../../.github/workflows/cpu-thread-measurements.yml',import.meta.url),'utf8');
 assert.match(workflow,/^  workflow_dispatch:/m);assert.doesNotMatch(workflow,/^  (?:push|pull_request|schedule):/m);
 assert.match(workflow,/timeout-minutes: 20/);assert.match(workflow,/contents: read/);assert.doesNotMatch(workflow,/matrix:|secrets\.|id-token: write|packages: write/);
 assert.match(workflow,/github.ref == 'refs\/heads\/main'/);assert.match(workflow,/retention-days: 7/);
});
