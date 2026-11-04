import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { WorkerError } from '../src/errors.js';
import { downloadModelWithRetry, runClaim, validateClaim } from '../src/worker.js';
import { materializePlateInputs } from '../src/plate.js';
import { CAPABILITY_REVISION_ID } from '../src/constants.js';

const digest = `sha256:${'a'.repeat(64)}`;
const config = Object.freeze({
  protocolVersion: 1,
  engineKey: 'fdm.am_pilot_prusa_core',
  imageDigest: digest,
  maximumModelBytes: 32,
  maximumTotalModelBytes: 48,
  maximumModelsPerRun: 2,
  maximumObjectsPerPlate: 2
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
    version: 1,
    models: [{ modelId: 'model-01', sizeBytes: 16 }],
    plate: { objects: [{ id: 'object-01', fileId: 'file-01' }] }
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
  const oversized = claim();
  oversized.inputSnapshot.models = [
    { modelId: 'model-01', sizeBytes: 32 },
    { modelId: 'model-02', sizeBytes: 32 }
  ];
  assert.throws(() => validateClaim(oversized, config), {
    code: 'slicer_source_model_total_size_exceeded'
  });
});

test('painted claims require the painting capability on both immutable identities', () => {
  const painted = claim();
  painted.inputSnapshot.plate.objects[0].supportPaint = { data: '0:4' };
  assert.throws(() => validateClaim(painted, config), { code: 'slicer_support_paint_capability_required' });
  painted.run.capabilityRevisionId = painted.engine.capabilityRevisionId = CAPABILITY_REVISION_ID;
  assert.equal(validateClaim(painted, config), painted);
});

test('admits 33 and 1000 objects and more than eight models within byte budgets', () => {
  for (const count of [33, 1000]) {
    const input = claim();
    input.inputSnapshot.plate.objects = Array.from({length:count}, (_, i) => ({id:`object-${i}`, fileId:'file-01'}));
    input.inputSnapshot.models = Array.from({length:9}, (_, i) => ({modelId:`model-${i}`, sizeBytes:1}));
    assert.equal(validateClaim(input, config), input);
  }
});

test('plate preparation no longer rejects legacy count limits', async () => {
  const input = claim().inputSnapshot;
  input.plate.objects = Array.from({length:33}, (_, i) => ({id:`object-${i}`}));
  // Passing count validation must reach the next required contract check.
  await assert.rejects(materializePlateInputs({inputSnapshot:input, effectiveConfiguration:{}, config}), {
    code:'slicer_effective_configuration_invalid'
  });
});

test('reports input rejection on the verified lease and can process the next job', async () => {
  const failures = [];
  const api = {fail:async details => failures.push(details)};
  const empty = claim();
  empty.inputSnapshot.plate.objects = [];
  await runClaim({claim:empty, api, config});
  const oversized = claim();
  oversized.run.id = 'run-02';
  oversized.inputSnapshot.models[0].sizeBytes = 33;
  await runClaim({claim:oversized, api, config});
  assert.deepEqual(failures.map(({runId,failureCode}) => ({runId,failureCode})), [
    {runId:'run-01',failureCode:'slicer_input_snapshot_invalid'},
    {runId:'run-02',failureCode:'slicer_source_model_size_invalid'}
  ]);
  assert.ok(failures.every(failure => failure.leaseToken === empty.lease.token));
  const invalid = claim();
  invalid.engine.id = 'untrusted';
  await assert.rejects(runClaim({claim:invalid,api,config}), {code:'slicer_worker_claim_invalid'});
  assert.equal(failures.length, 2);
});

test('object overrides cannot enter an incompatible claim', () => {
  const overridden = claim();
  overridden.inputSnapshot.plate.objects[0].printOverrides = {perimeters:4};
  assert.throws(() => validateClaim(overridden, config), {code:'slicer_object_override_capability_required'});
  overridden.run.capabilityRevisionId = overridden.engine.capabilityRevisionId = CAPABILITY_REVISION_ID;
  assert.equal(validateClaim(overridden, config), overridden);
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
      engineKeys: ['fdm.am_pilot_prusa_core'],
      protocolVersion: 1,
      expectedPrusaVersion: '2.9.3',
      prusaSlicerCommand: ${JSON.stringify(prusaCommand)},
      workRoot: ${JSON.stringify(workDir)},
      pollIntervalMs: 1_000,
      requestTimeoutMs: 1_000,
      maximumLogBytes: 65_536,
      normalizationCacheMaximumBytes: 0,
      normalizationCacheMaximumEntries: 128,
      normalizationCacheTtlMs: 900_000,
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

test('enabled normalization reuse rejects an older API before claiming any job', async t => {
  const { runWorker } = await import('../src/worker.js');
  const { loadWorkerConfig } = await import('../src/config.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-api-readiness-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, 'prusa');
  await fs.writeFile(executable, '#!/bin/sh\nprintf "PrusaSlicer-2.9.3\\n"\n', { mode: 0o700 });
  const workerConfig = loadWorkerConfig({ AM_PILOT_API_BASE_URL: 'https://api.example.test',
    SLICER_WORKER_CONTROL_TOKEN: 't'.repeat(48), SLICER_WORKER_ID: 'cache-readiness-test',
    SLICER_IMAGE_DIGEST: digest, PRUSA_SLICER_CMD: executable, SLICER_WORK_ROOT: directory,
    SLICER_NORMALIZATION_CACHE_MAX_BYTES: '1024' });
  let claimed = false;
  await assert.rejects(runWorker({ config: workerConfig, fetchImpl: async url => {
    if (new URL(url).pathname.endsWith('/health')) return new Response(JSON.stringify({ ready: true, workerProtocolVersion: 1 }));
    claimed = true;
    throw new Error('Must not claim on an incompatible API.');
  } }), { code: 'slicer_normalization_cache_unsupported' });
  assert.equal(claimed, false);
});

test('advanced preparation fails closed on old capabilities and malformed fields', () => {
  const value=claim();value.inputSnapshot.plate.geometry={heightMm:200};
  value.inputSnapshot.plate.pausePoints=[{id:'pause',zMm:5.2,message:'Insert nut'}];
  assert.throws(()=>validateClaim(value,config),{code:'slicer_preparation_capability_required'});
  value.run.capabilityRevisionId=CAPABILITY_REVISION_ID;value.engine.capabilityRevisionId=CAPABILITY_REVISION_ID;
  assert.doesNotThrow(()=>validateClaim(value,config));
  value.inputSnapshot.plate.pausePoints=null;
  assert.throws(()=>validateClaim(value,config),{code:'slicer_preparation_invalid'});
});

test('Bambu painting is bound to the exact Bambu worker capability, never the Prusa capability', async()=>{
 const {BAMBU_ENGINE_KEY,BAMBU_CAPABILITY_REVISION}=await import('../src/bambu-engine.js');
 const candidate=claim();
 candidate.run.engineKey=candidate.engine.engineKey=candidate.effectiveConfiguration.engineAdapter=BAMBU_ENGINE_KEY;
 candidate.run.capabilityRevisionId=candidate.engine.capabilityRevisionId=BAMBU_CAPABILITY_REVISION;
 candidate.inputSnapshot.plate.objects[0].supportPaint={data:'0:40003'};
 candidate.effectiveConfiguration.bambuConfig={process:{enable_support:'0'}};
 const bambuConfig={...config,engineKey:BAMBU_ENGINE_KEY};
 assert.throws(()=>validateClaim(candidate,bambuConfig),{code:'slicer_support_paint_supports_disabled'});
 candidate.effectiveConfiguration.bambuConfig.process.enable_support='1';
 assert.doesNotThrow(()=>validateClaim(candidate,bambuConfig));
 for(const old of ['fdm-bambu-2.8.2.61-protocol1-r4',CAPABILITY_REVISION_ID]){
  const other=structuredClone(candidate);other.run.capabilityRevisionId=other.engine.capabilityRevisionId=old;
  assert.throws(()=>validateClaim(other,bambuConfig),{code:'slicer_worker_claim_invalid'});
 }
});
