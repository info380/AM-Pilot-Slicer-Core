import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
export const digestObject = value => sha256(JSON.stringify(stable(value)));
export const validatePlan = plan => {
  assert.equal(plan.version, 2);
  assert.match(plan.image, /^ghcr\.io\/info380\/am-pilot-slicer-core-bambu@sha256:[a-f0-9]{64}$/);
  assert.match(plan.workerRevision, /^[a-f0-9]{40}$/);
  assert.match(plan.workerVersion, /^\d+\.\d+\.\d+$/);
  assert.match(plan.releaseTag, /^bambu-v\d+\.\d+\.\d+$/);
  assert.equal(plan.memoryBytes, 2_147_483_648); assert.equal(plan.temporaryBytes, 536_870_912);
  assert.equal(plan.repeats, 3); assert.equal(plan.maximumTrialSeconds, 90);
  assert.deepEqual(plan.engines, ['bambu', 'prusa']);
  assert.deepEqual(plan.fixtures, ['linked-ten', 'unique-ten', 'single-dense']);
  assert.equal(plan.cases.length, 9);
  const ids = new Set();
  for (const item of plan.cases) {
    assert.deepEqual(Object.keys(item).sort(), ['cpuPlacement', 'cpuQuota', 'engineThreads', 'id']);
    assert.match(item.id, /^q(?:05|1|2|4)-t[124](?:-distinct)?$/);
    assert([0.5, 1, 2, 4].includes(item.cpuQuota)); assert([1, 2, 4].includes(item.engineThreads));
    assert(['logical-first','distinct-cores'].includes(item.cpuPlacement));
    if(item.cpuPlacement==='distinct-cores')assert(item.cpuQuota===2&&item.engineThreads===2);
    assert.equal(item.id, `q${item.cpuQuota === 0.5 ? '05' : item.cpuQuota}-t${item.engineThreads}${item.cpuPlacement==='distinct-cores'?'-distinct':''}`);
    assert(!ids.has(item.id)); ids.add(item.id);
  }
  assert(ids.has('q1-t1') && ids.has('q2-t2') && ids.has('q4-t4') && ids.has('q2-t2-distinct'));
  return plan;
};
export const parseCpuList = text => {
  const cpus = []; let previous = -1;
  for (const part of text.split(',')) {
    assert.match(part, /^\d+(?:-\d+)?$/);
    const [first, last = first] = part.split('-').map(Number);
    assert(first > previous && last >= first && last - first < 4096);
    for (let cpu = first; cpu <= last; cpu++) cpus.push(cpu);
    previous = last;
  }
  return cpus;
};
export const parseCounters = text => Object.fromEntries(text.trim().split('\n').map(line => {
  const match = /^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)\s+(\d+)$/.exec(line.trim());
  assert(match, 'Malformed kernel counter evidence');
  const [, key, raw] = match, value = Number(raw);
  assert(Number.isSafeInteger(value) && value >= 0); return [key, value];
}));
export const counterDelta = (before, after) => Object.fromEntries(Object.keys(before).map(key => {
  assert(Number.isFinite(after[key]) && after[key] >= before[key]); return [key, after[key] - before[key]];
}));
export const commandChecksum = text => sha256(text.split(/\r?\n/).map(line => line.split(';')[0].trim()).filter(Boolean).join('\n'));
export const prusaSettings = text => {
  const block = /; prusaslicer_config = begin\r?\n([\s\S]*?); prusaslicer_config = end/.exec(text);
  assert(block, 'Prusa output must retain its native settings evidence');
  const fields = Object.fromEntries(block[1].split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^; ([a-z][a-z0-9_]*) = (.*)$/.exec(line); assert(match, 'Malformed native config evidence'); return [match[1], match[2]];
  }));
  const executionThreads = fields.threads ?? null; delete fields.threads;
  return { settings: fields, excludedExecutionThreads: executionThreads };
};
export const median = values => { const sorted = [...values].sort((a,b) => a-b); return sorted.length % 2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2; };
export const trialOrder = (plan, profile, engine='all', fixture='all') => {
  assert(engine==='all'||plan.engines.includes(engine));assert(fixture==='all'||plan.fixtures.includes(fixture));
  assert(['full', 'smoke'].includes(profile));
  const cases = profile === 'smoke' ? plan.cases.filter(c => ['q1-t1','q2-t2','q2-t2-distinct'].includes(c.id)) : plan.cases;
  const fixtures = (profile === 'smoke' && fixture==='all' ? ['linked-ten'] : plan.fixtures).filter(x=>fixture==='all'||x===fixture);
  const engines=plan.engines.filter(x=>engine==='all'||x===engine);
  assert(fixtures.length&&engines.length);
  const trials = [];
  for (let repeat=0; repeat<(profile === 'smoke' ? 1 : plan.repeats); repeat++) {
    // Rotate and reverse the order to avoid always giving one case a cold host.
    const rotated = cases.map((_, i) => cases[(i+repeat*3)%cases.length]);
    if (repeat % 2) rotated.reverse();
    for (const fixture of fixtures) for (const engine of engines) for (const item of rotated) trials.push({ repeat, fixture, engine, ...item });
  }
  return trials;
};

export const selectCpuSet = (topology, placement, count) => {
  assert(['logical-first','distinct-cores'].includes(placement));
  if(placement==='logical-first')return topology.map(x=>x.cpu);
  const keys=new Set(),selected=[];
  for(const row of topology){assert(/^\d+$/.test(row.packageId)&&/^\d+$/.test(row.coreId),'Missing reported core topology');const key=JSON.stringify([row.packageId,row.coreId]);if(!keys.has(key)){keys.add(key);selected.push(row.cpu);if(selected.length===count)break;}}
  assert.equal(selected.length,count,'Not enough distinct physical cores in the permitted CPU set');
  return selected;
};
