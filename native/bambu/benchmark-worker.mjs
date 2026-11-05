// Private-input diagnostic only. No API client, publication or printer access.
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { getPriority } from 'node:os';
import { performance } from 'node:perf_hooks';
import { summarizeToolpaths, compareToolpaths } from './toolpath-comparison.mjs';
import { boundSegmentVariation } from './floating-geometry.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const payload = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
assert.match(payload.diagnosticId, /^[0-9a-f-]{36}$/);
const resultPath = '/tmp/fdm-seam-result-' + payload.diagnosticId + '.json';
const base = await fs.mkdtemp('/tmp/fdm-seam-benchmark-');
const controllers = new Set(), nativePaths = new Set(['/opt/bambu/bin/bambu-studio']);
let fatal = null, sampling = false, watch, deadline;
const report = { schema: 'am-pilot-one-cpu-seam-prototype', version: 1, startedAt: new Date().toISOString(), diagnosticOnly: true, preflight: payload.preflight === true, executionContext: payload.executionContext, serverPlanChanged: false, printerCommandsSent: false, runs: [] };

const children = async () => {
  const rows = [];
  for (const pid of (await fs.readdir('/proc')).filter(value => /^\d+$/.test(value))) {
    try {
      const status = await fs.readFile('/proc/' + pid + '/status', 'utf8'), exe = await fs.readlink('/proc/' + pid + '/exe');
      rows.push({ pid: Number(pid), ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]), exe, allowed: /^Cpus_allowed_list:\s+(\S+)/m.exec(status)?.[1], rssKiB: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0), threads: Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 0) });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  const byId = new Map(rows.map(row => [row.pid, row]));
  return rows.filter(row => nativePaths.has(row.exe) || row.exe.startsWith('/opt/bambu/') || row.exe.startsWith('/opt/prusa/')).map(row => {
    const seen = new Set(); let at = row.pid, owned = false;
    while (at && !seen.has(at)) { if (at === process.pid) { owned = true; break; } seen.add(at); at = byId.get(at)?.ppid; }
    return { ...row, owned };
  });
};
const stop = async reason => {
  fatal ??= reason;
  for (const controller of controllers) controller.abort();
  for (const row of await children()) if (row.owned) try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
};
const monitor = async () => {
  if (sampling) return; sampling = true;
  try {
    const rows = await children();
    if (rows.some(row => !row.owned)) await stop('Production native work detected; diagnostic aborted');
    for (const row of rows.filter(row => row.owned)) {
      assert(/^\d+$/.test(row.allowed), 'Native diagnostic exceeded single-CPU affinity');
      report.peakNativeRssKiB = Math.max(report.peakNativeRssKiB ?? 0, row.rssKiB);
      report.peakNativeThreads = Math.max(report.peakNativeThreads ?? 0, row.threads);
      report.nativeAllowedCpuLists ??= [];
      if (!report.nativeAllowedCpuLists.includes(row.allowed)) report.nativeAllowedCpuLists.push(row.allowed);
    }
  } catch (error) { fatal ??= 'Process guard failed: ' + error.message; for (const controller of controllers) controller.abort(); }
  finally { sampling = false; }
};

try {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64');
  for (const [file, checksum] of Object.entries(payload.runtimeHashes)) assert.equal(sha(await fs.readFile('/worker/' + file)), checksum, 'Runtime source mismatch: ' + file);
  report.runtimeSourceFilesVerified = Object.keys(payload.runtimeHashes).length;
  report.imageDigest = process.env.SLICER_IMAGE_DIGEST; assert.equal(report.imageDigest, payload.expectedImageDigest);
  report.cpuMax = (await fs.readFile('/sys/fs/cgroup/cpu.max', 'utf8')).trim(); assert.equal(report.cpuMax, '100000 100000');
  report.memoryMax = (await fs.readFile('/sys/fs/cgroup/memory.max', 'utf8')).trim(); assert.equal(report.memoryMax, '2147483648');
  report.nativePriority = getPriority(process.pid); assert.equal(report.nativePriority, 19);
  report.floatingVariationLimits = payload.floatingVariationLimits;
  report.instanceId = process.env.RENDER_INSTANCE_ID ?? null;
  report.serviceId = process.env.RENDER_SERVICE_ID ?? null;
  report.binaryChecksums = {};
  assert.deepEqual(Object.keys(payload.binaries).sort(), report.preflight ? ['official'] : ['candidate', 'control', 'official']);
  for (const [label, binary] of Object.entries(payload.binaries)) {
    const actual = sha(await fs.readFile(binary.path)); assert.equal(actual, binary.sha256, 'Native binary identity changed: ' + label);
    assert.equal(sha(await fs.readFile(binary.launcher)), binary.launcherSha256, 'Native launcher identity changed: ' + label);
    nativePaths.add(await fs.realpath(binary.path)); report.binaryChecksums[label] = actual;
  }
  assert(!(await children()).some(row => !row.owned), 'Production native work is already active');
  watch = setInterval(() => void monitor(), 100); watch.unref();
  deadline = setTimeout(() => void stop('Diagnostic reached its six-minute deadline'), 360000); deadline.unref();
  const { loadWorkerConfig } = await import('/worker/src/config.js');
  const { assertBambuEffectiveConfiguration, inspectBambuOutput } = await import('/worker/src/bambu-engine.js');
  const { prepareBambuMachineProject } = await import('/worker/src/bambu-machine-project.js');
  const { normalizeFdmPausePoints, normalizeFdmCustomGcodePoints } = await import('/worker/src/preparation-contract.js');
  const { layerGcodeBlock, verifyNativeLayerGcode } = await import('/worker/src/layer-gcode.js');
  const { verifyNativePauseEvents } = await import('/worker/src/pause-verification.js');
  const { runProcess } = await import('/worker/src/process.js');
  const { unzipSync } = createRequire('/worker/package.json')('fflate');
  const config = loadWorkerConfig({ ...process.env, SLICER_WORK_ROOT: base, SLICER_ENGINE_THREADS: '1', SLICER_ENGINE_CPU_AFFINITY: 'threads', SLICER_JOB_TIMEOUT_MS: '60000' });
  const presets = assertBambuEffectiveConfiguration(payload.effectiveConfiguration);
  const input = Buffer.from(payload.preparedInputBase64, 'base64'); assert.equal(sha(input), payload.preparedInputSha256);
  report.preparedInputSha256 = sha(input);
  const sourcePath = path.join(base, 'input.3mf'); await fs.writeFile(sourcePath, input, { mode: 0o600 });
  const paths = {};
  for (const kind of ['machine', 'process', 'filament']) { paths[kind] = path.join(base, kind + '.json'); const settings = { ...presets[kind] }; delete settings.post_process; await fs.writeFile(paths[kind], JSON.stringify(settings), { mode: 0o600 }); }
  const pauses = normalizeFdmPausePoints(payload.pausePoints), custom = normalizeFdmCustomGcodePoints(payload.customGcodePoints);
  paths.pauses = path.join(base, 'pause-events.json'); await fs.writeFile(paths.pauses, JSON.stringify({ mode: 'SingleExtruder', gcodes: [...pauses.map(point => ({ print_z: point.zMm, type: 'PausePrint', extruder: 1, color: '', extra: point.message })), ...custom.map(point => ({ print_z: point.zMm, type: 'Custom', extruder: 1, color: '', extra: layerGcodeBlock(point) }))].sort((a, b) => a.print_z - b.print_z) }), { mode: 0o600 });
  const prepController = new AbortController(); controllers.add(prepController);
  const nativeInput = await prepareBambuMachineProject({ ownership: payload.effectiveConfiguration.ownership?.machine, presets, paths, sourcePath, workDir: base, config, signal: prepController.signal, cpuAffinityCount: 1 }); controllers.delete(prepController);
  report.nativePreparedProjectSha256 = sha(await fs.readFile(nativeInput));
  const summaries = [];
  // Paired order alternates to avoid assigning all warm runs to the candidate.
  const order = report.preflight ? ['official'] : ['official', 'control', 'candidate', 'candidate', 'control', 'control', 'candidate'];
  for (const [index, label] of order.entries()) {
    await monitor(); if (fatal) throw Error(fatal);
    assert.equal(sha(await fs.readFile(nativeInput)), report.nativePreparedProjectSha256, 'Prepared native project changed between runs');
    const work = await fs.mkdtemp(base + '/run-'), controller = new AbortController(); controllers.add(controller);
    const logPath = path.join(work, 'native.log'), fd = syncFs.openSync(logPath, 'wx', 0o600); let logBytes = 0, logOpen = true;
    const beforeCpu = (await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).trim(); const start = performance.now();
    try {
      await runProcess({ command: payload.binaries[label].launcher, args: ['--debug', '4', '--datadir', work + '/data', '--arrange', '0', '--orient', '0', '--skip-useless-pick', '--min-save', '--load-settings', paths.machine + ';' + paths.process, '--load-filaments', paths.filament, '--load-custom-gcodes', paths.pauses, '--slice', '0', '--export-3mf', 'output.gcode.3mf', '--outputdir', work, nativeInput], cwd: work, timeoutMs: 60000, maximumLogBytes: config.maximumLogBytes, cpuAffinityCount: 1, signal: controller.signal, onOutput: (_stream, chunk) => { if (!logOpen) return; logBytes += Buffer.byteLength(chunk); if (logBytes > 32 * 1024 * 1024) { fatal = 'Native diagnostic log limit exceeded'; controller.abort(); return; } syncFs.writeSync(fd, chunk); } });
    } finally { logOpen = false; syncFs.closeSync(fd); controllers.delete(controller); }
    const nativeMs = performance.now() - start, afterCpu = (await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8')).trim();
    if (fatal) throw Error(fatal);
    const archive = await fs.readFile(work + '/output.gcode.3mf');
    const checked = inspectBambuOutput({ bytes: archive, machine: presets.machine, filament: presets.filament, machineOverrides: payload.effectiveConfiguration.ownership?.machine, maximumArchiveBytes: config.maximumArchiveBytes, maximumExpandedBytes: config.maximumExpandedArchiveBytes, maximumGcodeBytes: config.maximumGcodeBytes });
    const entries = unzipSync(archive, { filter: entry => ['Metadata/project_settings.config', 'Metadata/plate_1.gcode.md5'].includes(entry.name) });
    const settings = JSON.parse(Buffer.from(entries['Metadata/project_settings.config'])); assert.deepEqual(settings, payload.referenceNativeSettings); assert.equal(Object.keys(settings).length, 575);
    assert.equal(createHash('md5').update(checked.gcode).digest('hex'), Buffer.from(entries['Metadata/plate_1.gcode.md5']).toString().trim().toLowerCase());
    const gcode = Buffer.from(checked.gcode).toString(); verifyNativeLayerGcode({ gcode, customGcodePoints: custom, pausePoints: pauses, bambu: true }); verifyNativePauseEvents({ gcode, pausePoints: pauses, bambu: true });
    const summary = summarizeToolpaths(gcode, { retainFloatingSegments: true }); assert.equal(summary.layers.length, 90);
    const ironing = Object.values(summary.ironingByObject); assert.equal(ironing.length, 10); assert(ironing.every(entry => entry.count === 4489), 'Ironing changed on at least one part');
    const comparison = summaries.length ? compareToolpaths(summaries[0], summary) : null;
    if (comparison) {
      assert(comparison.layersMatch && comparison.seamsMatch, 'Layer or outer-wall seam positions changed');
      assert(comparison.changedFeatureLayers.every(key => key.endsWith(':Floating vertical shell')), 'Deposited toolpaths changed outside the previously identified floating-shell variation');
      comparison.floatingGeometry = {};
      const limits = payload.floatingVariationLimits;
      assert(limits && limits.reference && limits.toleranceMm > 0 && limits.maximumDistanceMm > 0 && limits.maximumExtrusionDeltaMm > 0 && limits.maximumLengthDeltaMm > 0, 'Explicit measured floating-shell comparison limits are required');
      for (const key of comparison.changedFeatureLayers) {
        const bounds = boundSegmentVariation(summaries[0].floatingSegments[key] ?? [], summary.floatingSegments[key] ?? [], limits.toleranceMm);
        comparison.floatingGeometry[key] = bounds;
        assert(bounds.hausdorffUpperBoundMm <= limits.maximumDistanceMm, 'Floating-shell displacement exceeded the measured comparison envelope');
        assert(Math.abs(bounds.extrusionDeltaMm) <= limits.maximumExtrusionDeltaMm && Math.abs(bounds.lengthDeltaMm) <= limits.maximumLengthDeltaMm, 'Floating-shell extrusion/length exceeded the measured comparison envelope');
      }
    }
    summaries.push(summary);
    const log = await fs.readFile(logPath, 'utf8');
    const reuse = /total object counts (\d+) in current print, need to slice (\d+)/.exec(log); assert(reuse);
    const passes = (log.match(/raycast visibility of/g) ?? []).length / 2, hits = (log.match(/reused equivalent object visibility/g) ?? []).length;
    assert.equal(Number(reuse[1]), 10); assert.equal(Number(reuse[2]), 1); assert.equal(passes, label === 'candidate' ? 1 : 10); assert.equal(hits, label === 'candidate' ? 9 : 0);
    const events = log.split('\n').map(line => /^\[([^\]]+)\].*?\[(?:info|debug)\]\s+(.*)/.exec(line)).filter(Boolean).map(match => ({ at: match[1], message: match[2] }));
    const stamp = value => { const match = /^(.*\.)(\d+)$/.exec(value); assert(match); return Date.parse(match[1] + match[2].slice(0, 3) + 'Z') + Number('0.' + match[2].slice(3)); };
    const at = prefix => stamp(events.find(event => event.message.startsWith(prefix)).at);
    const rays = events.filter(event => event.message.includes('raycast visibility of'));
    const seamStart = events.find(event => event.message === 'SeamPlacer: build AABB trees for raycasting enforcers/blockers: start');
    const seamEnd = events.filter(event => event.message === 'SeamPlacer: check_enable_scarf_seam : end').at(-1);
    const row = { index, label, nativeMs, beforeCpu, afterCpu, nativeSettingsMatch: true, nativeSettingsCount: 575, layerCount: 90, ironingByObject: summary.ironingByObject, archiveSha256: sha(archive), gcodeSha256: sha(checked.gcode), nativeObjectCount: 10, objectsNeedingSlice: 1, visibilityPasses: passes, reuseHits: hits, comparisonToOfficial: comparison, outerWallStarts: summary.outerWallStarts, nativeStageMs: { geometryToExport: at('Exporting G-code...') - at('Starting the slicing process.'), gcodeExport: at('Exporting G-code finished') - at('Exporting G-code...'), seamInitialization: stamp(seamEnd.at) - stamp(seamStart.at), visibilityRaycasts: rays.reduce((sum, event, i) => i % 2 ? sum + stamp(event.at) - stamp(rays[i - 1].at) : sum, 0) } };
    report.runs.push(row); console.log('FDM_SEAM_RUN ' + JSON.stringify({ label, index, nativeMs, visibilityPasses: passes, reuseHits: hits, nativeStageMs: row.nativeStageMs }));
  }
  report.status = report.preflight ? 'fixture-preflight-passed' : 'passed';
} catch (error) { report.status = 'failed'; report.error = fatal ?? error.message; process.exitCode = 1; }
finally {
  clearInterval(watch); clearTimeout(deadline); while (sampling) await new Promise(resolve => setTimeout(resolve, 10));
  if (fatal) { report.status = 'failed'; report.error = fatal; process.exitCode = 1; }
  await fs.rm(base, { recursive: true, force: true }); report.temporarySliceFilesRemoved = true;
  report.finishedAt = new Date().toISOString(); await fs.writeFile(resultPath, JSON.stringify(report), { mode: 0o600, flag: 'wx' });
  console.log('FDM_SEAM_FINAL ' + JSON.stringify({ status: report.status, error: report.error, runs: report.runs.length, resultPath }));
}
