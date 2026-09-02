import assert from 'node:assert/strict';
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
