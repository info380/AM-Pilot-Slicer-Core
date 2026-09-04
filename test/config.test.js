import assert from 'node:assert/strict';
import test from 'node:test';

import { loadWorkerConfig } from '../src/config.js';
import { serializePrusaConfig } from '../src/config-ini.js';

const environment = overrides => ({
  AM_PILOT_API_BASE_URL: 'http://127.0.0.1:4321',
  SLICER_WORKER_CONTROL_TOKEN: 't'.repeat(48),
  SLICER_WORKER_ID: 'worker-test-01',
  SLICER_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  PRUSA_SLICER_CMD: process.execPath,
  ...overrides
});

test('loads an immutable fail-closed worker identity', () => {
  const config = loadWorkerConfig(environment(), { allowInsecureLoopback: true });
  assert.equal(config.engineKey, 'fdm.am_pilot_prusa_core');
  assert.equal(config.protocolVersion, 1);
  assert.equal(config.engineThreads, 1);
  assert.equal(config.maximumModelBytes, 33_554_432);
  assert.equal(config.maximumTotalModelBytes, 134_217_728);
  assert.equal(config.maximumNormalizedModelBytes, 67_108_864);
  assert.equal(config.maximumTotalNormalizedBytes, 134_217_728);
  assert.equal(config.maximumPlateInputBytes, 201_326_592);
  assert.equal(config.maximumGcodeBytes, 67_108_864);
  assert.equal(config.maximumModelsPerRun, 8);
  assert.equal(config.maximumObjectsPerPlate, 32);
  assert.ok(Object.isFrozen(config));
  assert.throws(() => loadWorkerConfig(environment({
    SLICER_MAX_MODEL_BYTES: '2097152',
    SLICER_MAX_TOTAL_MODEL_BYTES: '1048576'
  }), { allowInsecureLoopback: true }), /Aggregate Slicer byte limits/);
});

test('rejects insecure non-loopback API origins', () => {
  assert.throws(
    () => loadWorkerConfig(environment({ AM_PILOT_API_BASE_URL: 'http://example.com' })),
    error => error.code === 'slicer_worker_configuration_invalid'
  );
});

test('requires an explicit private proxy origin when proxy enforcement is enabled', () => {
  assert.throws(() => loadWorkerConfig(environment({
    SLICER_EGRESS_PROXY_REQUIRED: 'true',
  }), { allowInsecureLoopback: true }), /SLICER_EGRESS_PROXY_URL is required/);
  const config = loadWorkerConfig(environment({
    SLICER_EGRESS_PROXY_REQUIRED: 'true',
    SLICER_EGRESS_PROXY_URL: 'http://egress-proxy:3128'
  }), { allowInsecureLoopback: true });
  assert.equal(config.egressProxyRequired, true);
  assert.equal(config.egressProxyUrl.toString(), 'http://egress-proxy:3128/');
  assert.throws(() => loadWorkerConfig(environment({
    SLICER_EGRESS_PROXY_REQUIRED: 'yes'
  }), { allowInsecureLoopback: true }), /must be true or false/);
});

test('serializes the canonical Prusa config deterministically', () => {
  assert.equal(serializePrusaConfig({
    custom_parameters_printer: '',
    end_filament_gcode: '',
    start_gcode: 'G28\r\nM117 Ready',
    start_filament_gcode: '',
    layer_height: 0.2,
    cooling: true,
    nozzle_diameter: [0.4]
  }), [
    'cooling = 1',
    'custom_parameters_printer = ',
    'end_filament_gcode = ""',
    'layer_height = 0.2',
    'nozzle_diameter = 0.4',
    'start_filament_gcode = ""',
    'start_gcode = G28\\nM117 Ready',
    ''
  ].join('\n'));
});

test('rejects post-processing and output-path control from a run', () => {
  assert.throws(() => serializePrusaConfig({ post_process: '/tmp/script' }), {
    code: 'slicer_effective_configuration_invalid'
  });
  assert.throws(() => serializePrusaConfig({ output_filename_format: '../../escape.gcode' }), {
    code: 'slicer_effective_configuration_invalid'
  });
});
