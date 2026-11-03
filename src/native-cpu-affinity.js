import fs from 'node:fs/promises';
import { WorkerError } from './errors.js';

const invalid = message => new WorkerError(message, { code: 'slicer_worker_cpu_affinity_invalid' });

// Opt-in Linux execution policy. Use the actual permitted CPU set and the
// existing qualified engine-thread budget, never host CPU count or client data.
export const nativeCpuInvocation = async ({ command, args, count = null,
  platform = process.platform, readStatus = () => fs.readFile('/proc/self/status', 'utf8') }) => {
  if (count === null) return { command, args };
  if (platform !== 'linux' || !Number.isSafeInteger(count) || count < 1 || count > 32) {
    throw invalid('Native CPU affinity requires Linux and an explicit thread budget from 1 to 32.');
  }
  const status = await readStatus();
  const list = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status)?.[1];
  if (!list) throw invalid('The native CPU affinity policy cannot read the permitted CPU set.');
  const selected = [];
  let previous = -1;
  for (const range of list.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(range);
    if (!match) throw invalid('The permitted CPU set is malformed.');
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(last) || first <= previous || last < first) throw invalid('The permitted CPU set is malformed.');
    for (let cpu = first; cpu <= last && selected.length < count; cpu++) selected.push(cpu);
    previous = last;
  }
  if (selected.length !== count) throw invalid('The configured native thread budget exceeds the permitted CPU set.');
  return { command: '/usr/bin/taskset', args: ['--cpu-list', selected.join(','), command, ...args] };
};
