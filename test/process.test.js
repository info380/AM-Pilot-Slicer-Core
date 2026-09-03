import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProcess } from '../src/process.js';

test('passes only the runtime loader path to the slicer subprocess', async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-process-env-'));
  const previousLibraryPath = process.env.LD_LIBRARY_PATH;
  const previousControlToken = process.env.SLICER_WORKER_CONTROL_TOKEN;
  t.after(async () => {
    if (previousLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = previousLibraryPath;
    if (previousControlToken === undefined) delete process.env.SLICER_WORKER_CONTROL_TOKEN;
    else process.env.SLICER_WORKER_CONTROL_TOKEN = previousControlToken;
    await fs.rm(workDir, { recursive: true, force: true });
  });

  process.env.LD_LIBRARY_PATH = '/opt/prusa/lib:/opt/prusa/secondary-lib';
  process.env.SLICER_WORKER_CONTROL_TOKEN = 'must-not-reach-the-slicer-process';

  const result = await runProcess({
    command: process.execPath,
    args: ['--input-type=module', '--eval', 'process.stdout.write(JSON.stringify(process.env))'],
    cwd: workDir,
    timeoutMs: 10_000,
    maximumLogBytes: 64 * 1024
  });
  const childEnvironment = JSON.parse(result.stdout);

  assert.equal(childEnvironment.LD_LIBRARY_PATH, '/opt/prusa/lib:/opt/prusa/secondary-lib');
  assert.equal(childEnvironment.SLICER_WORKER_CONTROL_TOKEN, undefined);
  assert.equal(childEnvironment.HOME, workDir);
  assert.equal(childEnvironment.TMPDIR, workDir);
});
