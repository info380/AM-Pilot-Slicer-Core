import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeCpuInvocation } from '../src/native-cpu-affinity.js';

test('native affinity is explicit, respects permitted CPUs and preserves arguments', async () => {
 const input={command:'/engine',args:['--output','path with spaces'],count:2,platform:'linux',readStatus:async()=> 'Cpus_allowed_list:\t4-5,8-11\n'};
 assert.deepEqual(await nativeCpuInvocation(input),{command:'/usr/bin/taskset',args:['--cpu-list','4,5','/engine','--output','path with spaces']});
 assert.deepEqual(await nativeCpuInvocation({...input,count:null}),{command:'/engine',args:input.args});
 for(const changed of [{platform:'darwin'},{count:0},{count:33},{count:9},{readStatus:async()=>''},{readStatus:async()=> 'Cpus_allowed_list:\t4-2\n'},{readStatus:async()=> 'Cpus_allowed_list:\t4-5,5-8\n'}]){
  await assert.rejects(nativeCpuInvocation({...input,...changed}),{code:'slicer_worker_cpu_affinity_invalid'});
 }
});
