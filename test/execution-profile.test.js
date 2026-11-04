import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExecutionProfile, profileExecutionPhase } from '../src/execution-profile.js';
import { runProcess } from '../src/process.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
test('separates blocked progress from child lifetime without exposing arguments or output', async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-profile-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const profile = createExecutionProfile();
  await profileExecutionPhase(profile, 'slicingProgress', () => wait(60));
  const result = await runProcess({ command: process.execPath,
    args: ['-e', 'setTimeout(() => process.stdout.write("private-output"), 20)'],
    cwd: workDir, timeoutMs: 5000, maximumLogBytes: 1024, profile });
  assert.equal(result.stdout, 'private-output');
  assert.deepEqual(Object.keys(result).sort(), ['stderr', 'stdout']);
  assert.deepEqual(profile.completedPhases, ['slicingProgress', 'affinitySetup', 'nativeSubprocess']);
  assert.ok(profile.timingsMs.slicingProgress >= 50);
  assert.ok(profile.timingsMs.nativeSubprocess >= 15);
  assert.ok(Object.values(profile.timingsMs).every(value => Number.isFinite(value) && value >= 0));
  assert.doesNotMatch(JSON.stringify(profile), /private-output|setTimeout|execution-profile-|lease|token/);
});
test('retains a partial failed phase and preserves the original error and cancellation', async t => {
  const failure = new Error('private-failure');
  const profile = createExecutionProfile();
  await assert.rejects(profileExecutionPhase(profile, 'archiveValidation', async () => { throw failure; }), error => error === failure);
  assert.equal(profile.failedPhase, 'archiveValidation');
  assert.deepEqual(profile.completedPhases, []);
  assert.ok(profile.timingsMs.archiveValidation >= 0);
  assert.doesNotMatch(JSON.stringify(profile), /private-failure/);
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'execution-cancel-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const controller = new AbortController(); controller.abort();
  const cancelled = createExecutionProfile();
  await assert.rejects(runProcess({ command: process.execPath, args: ['-e', 'process.exit(0)'],
    cwd: workDir, timeoutMs: 5000, maximumLogBytes: 1024, signal: controller.signal, profile: cancelled }), { code: 'slicer_worker_cancelled' });
  assert.equal(cancelled.failedPhase, 'nativeSubprocess');
  assert.deepEqual(cancelled.completedPhases, ['affinitySetup']);
});
test('disabled profiling preserves results and failures', async () => {
  const result = {};
  assert.equal(await profileExecutionPhase(null, 'unused', () => result), result);
  const failure = new Error('unchanged');
  await assert.rejects(profileExecutionPhase(null, 'unused', () => { throw failure; }), error => error === failure);
});
