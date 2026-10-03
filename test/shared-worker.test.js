import assert from 'node:assert/strict';
import test from 'node:test';
import { loadWorkerConfig } from '../src/config.js';
import { runWorkerLoop, validateClaim } from '../src/worker.js';
import { SlicerWorkerApiClient } from '../src/api-client.js';
import { WorkerError } from '../src/errors.js';

const keys = ['fdm.am_pilot_prusa_core', 'fdm.am_pilot_bambu_core'];
const env = {
  AM_PILOT_API_BASE_URL: 'https://api.example.test',
  SLICER_WORKER_CONTROL_TOKEN: 't'.repeat(48),
  SLICER_WORKER_ID: 'shared-worker',
  SLICER_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  PRUSA_SLICER_CMD: process.execPath,
  BAMBU_STUDIO_CMD: process.execPath,
  SLICER_ENGINE_KEYS: keys.join(',')
};

test('shared engine configuration is explicit, immutable and rejects ambiguity', () => {
  const config = loadWorkerConfig(env);
  assert.deepEqual(config.engineKeys, keys);
  assert.ok(Object.isFrozen(config.engineKeys));
  assert.ok(config.bambuStudioCommand);
  for (const changes of [
    { SLICER_ENGINE_KEYS: '' },
    { SLICER_ENGINE_KEYS: keys[0] + ',' },
    { SLICER_ENGINE_KEYS: keys[0] + ',' + keys[0] },
    { SLICER_ENGINE_KEYS: 'unknown' },
    { SLICER_ENGINE_KEY: keys[0] },
    { BAMBU_STUDIO_CMD: '' }
  ]) assert.throws(() => loadWorkerConfig({ ...env, ...changes }), { code: 'slicer_worker_configuration_invalid' });
});

test('each engine claims with its own key but the same immutable image and worker', async () => {
  const base = loadWorkerConfig(env);
  const headers = [];
  for (const engineKey of keys) {
    const config = { ...base, engineKey };
    const api = new SlicerWorkerApiClient(config, { fetchImpl: async (url, options) => {
      headers.push(options.headers);
      return new Response(null, { status: 204 });
    } });
    assert.equal(await api.claim(), null);
    assert.throws(() => validateClaim({ run: { engineKey: keys.find(key => key !== engineKey) } }, config), {
      code: 'slicer_worker_claim_invalid'
    });
  }
  assert.deepEqual(headers.map(h => h['X-AM-Pilot-Slicer-Engine-Key']), keys);
  assert.ok(headers.every(h => h['X-AM-Pilot-Slicer-Image-Digest'] === base.imageDigest
    && h['X-AM-Pilot-Slicer-Worker-ID'] === base.workerId));
});

test('busy queues alternate without parallel claims or executions', async () => {
  const controller = new AbortController();
  const order = [];
  let active = 0;
  let peak = 0;
  const engines = keys.map(engineKey => ({
    config: { engineKey },
    api: { claim: async () => {
      assert.equal(active, 0);
      return { engineKey };
    } }
  }));
  await runWorkerLoop({ engines, signal: controller.signal,
    wait: async () => assert.fail('Busy queues should not sleep'),
    execute: async ({ claim, config }) => {
      assert.equal(claim.engineKey, config.engineKey);
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setImmediate(resolve));
      order.push(claim.engineKey);
      active--;
      if (order.length === 6) controller.abort();
    }
  });
  assert.equal(peak, 1);
  assert.deepEqual(order, [...keys, ...keys, ...keys]);
});

test('an empty queue does not delay another engine; idle polling waits once per cycle', async () => {
  const controller = new AbortController();
  const order = [];
  let bambuClaims = 0;
  const engines = keys.map((engineKey, i) => ({
    config: { engineKey, pollIntervalMs: 3000 },
    api: { claim: async () => {
      order.push(engineKey);
      return i === 1 && bambuClaims++ === 0 ? { engineKey } : null;
    } }
  }));
  let completed = 0;
  await runWorkerLoop({ engines, signal: controller.signal,
    execute: async () => { completed++; },
    wait: async ms => { assert.equal(ms, 3000); controller.abort(); }
  });
  assert.equal(completed, 1);
  assert.deepEqual(order, [...keys, ...keys]);
});

test('transient control failure backs off then services the other queue; fatal errors stop', async () => {
  const controller = new AbortController();
  const waits = [];
  const engines = keys.map((engineKey, i) => ({
    config: { engineKey, retryBackoffMaximumMs: 3000 },
    api: { claim: async () => {
      if (i === 0) throw new WorkerError('Transient', { retryable: true });
      return { engineKey };
    } }
  }));
  await runWorkerLoop({ engines, signal: controller.signal,
    wait: async ms => { waits.push(ms); },
    execute: async ({ config }) => { assert.equal(config.engineKey, keys[1]); controller.abort(); }
  });
  assert.deepEqual(waits, [2000]);
  engines[0].api.claim = async () => { throw new WorkerError('Invalid identity', { code: 'invalid' }); };
  await assert.rejects(runWorkerLoop({ engines }), { code: 'invalid' });
});
