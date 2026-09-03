import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkerError } from '../src/errors.js';
import { downloadModelWithRetry, validateClaim } from '../src/worker.js';

const digest = `sha256:${'a'.repeat(64)}`;
const config = Object.freeze({
  protocolVersion: 1,
  engineKey: 'fdm.am_pilot_prusa_core',
  imageDigest: digest
});

const claim = () => ({
  protocolVersion: 1,
  run: {
    id: 'run-01',
    inputFingerprint: `sha256:${'b'.repeat(64)}`,
    engineKey: config.engineKey,
    engineVersionId: 'engine-01',
    engineImageDigest: digest,
    capabilityRevisionId: 'fdm-prusa-2.9.3-protocol1-r1',
    workerProtocolVersion: 1,
    effectiveConfigurationChecksumSha256: 'c'.repeat(64)
  },
  engine: {
    id: 'engine-01',
    engineKey: config.engineKey,
    imageDigest: digest,
    capabilityRevisionId: 'fdm-prusa-2.9.3-protocol1-r1',
    workerProtocolVersion: 1
  },
  lease: { token: 'lease-token'.padEnd(48, 'x') },
  inputSnapshot: {
    schema: 'am-pilot-slicer-input-snapshot',
    version: 1
  },
  effectiveConfiguration: {
    schema: 'am-pilot-slicer-effective-config',
    version: 6,
    engineAdapter: config.engineKey
  }
});

test('accepts only claims pinned to the complete immutable release identity', () => {
  assert.equal(validateClaim(claim(), config).run.id, 'run-01');
  assert.throws(
    () => validateClaim({ ...claim(), engine: { ...claim().engine, id: 'substituted-engine' } }, config),
    { code: 'slicer_worker_claim_invalid' }
  );
  assert.throws(
    () => validateClaim({
      ...claim(),
      effectiveConfiguration: { ...claim().effectiveConfiguration, version: 7 }
    }, config),
    { code: 'slicer_worker_claim_invalid' }
  );
});

test('retries transient model downloads without retaining a partial file', async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-download-retry-'));
  t.after(() => fs.rm(workDir, { recursive: true, force: true }));
  const targetPath = path.join(workDir, 'model.stl');
  let attempts = 0;
  const api = {
    async downloadModel({ targetPath: target }) {
      attempts += 1;
      await fs.writeFile(target, attempts === 1 ? 'partial' : 'complete', { flag: 'wx' });
      if (attempts === 1) {
        throw new WorkerError('Transient transport failure.', {
          code: 'slicer_source_model_download_failed',
          retryable: true
        });
      }
      return target;
    }
  };
  await downloadModelWithRetry({
    api,
    runId: 'run-01',
    leaseToken: 'lease-token',
    model: { modelId: 'model-01' },
    targetPath,
    sleepImpl: async () => {}
  });
  assert.equal(attempts, 2);
  assert.equal(await fs.readFile(targetPath, 'utf8'), 'complete');
});

test('keeps the worker process alive while an empty queue is being polled', async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-worker-liveness-'));
  const prusaCommand = path.join(workDir, 'prusa-slicer');
  await fs.writeFile(
    prusaCommand,
    '#!/bin/sh\nprintf "%s\\n" "PrusaSlicer-2.9.3+UNKNOWN based on Slic3r (without GUI support)"\n',
    { mode: 0o700 }
  );
  const workerModuleUrl = new URL('../src/worker.js', import.meta.url).href;
  const childSource = `
    import { runWorker } from ${JSON.stringify(workerModuleUrl)};
    const shutdown = new AbortController();
    process.once('SIGTERM', () => shutdown.abort(new Error('test shutdown')));
    const config = {
      apiBaseUrl: new URL('https://api.example.test'),
      controlToken: 't'.repeat(48),
      workerId: 'worker-liveness-test',
      imageDigest: 'sha256:${'a'.repeat(64)}',
      engineKey: 'fdm.am_pilot_prusa_core',
      protocolVersion: 1,
      expectedPrusaVersion: '2.9.3',
      prusaSlicerCommand: ${JSON.stringify(prusaCommand)},
      workRoot: ${JSON.stringify(workDir)},
      pollIntervalMs: 1_000,
      requestTimeoutMs: 1_000,
      maximumLogBytes: 65_536,
      retryBackoffMaximumMs: 3_000
    };
    const fetchImpl = async url => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/health')) {
        return new Response(JSON.stringify({ ready: true, workerProtocolVersion: 1 }), {
          headers: { 'content-type': 'application/json' }
        });
      }
      if (pathname.endsWith('/runs/claim')) return new Response(null, { status: 204 });
      throw new Error('Unexpected test request: ' + pathname);
    };
    await runWorker({ config, fetchImpl, signal: shutdown.signal });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    await fs.rm(workDir, { recursive: true, force: true });
  });

  await Promise.race([
    new Promise((resolve, reject) => {
      const onData = () => {
        if (!stdout.includes('"event":"slicer_worker_ready"')) return;
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        resolve();
      };
      const onExit = code => {
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        reject(new Error(`Worker exited before becoming ready with code ${code}: ${stderr}`));
      };
      const timeout = setTimeout(() => {
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        reject(new Error(`Timed out waiting for worker readiness: ${stdout}\n${stderr}`));
      }, 3_000);
      child.stdout.on('data', onData);
      child.once('exit', onExit);
      onData();
    }),
    once(child, 'error').then(([error]) => { throw error; })
  ]);

  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(child.exitCode, null, `Worker exited while idle: ${stderr}`);
  child.kill('SIGTERM');
  const [code, processSignal] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
  assert.equal(processSignal, null);
  assert.match(stdout, /"event":"slicer_worker_stopped"/);
  assert.doesNotMatch(stderr, /unsettled top-level await/i);
});
