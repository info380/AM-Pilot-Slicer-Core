import fs from 'node:fs';

import {
  DEFAULTS,
  ENGINE_KEY,
  PRUSA_SLICER_VERSION,
  WORKER_PROTOCOL_VERSION
} from './constants.js';
import { WorkerError } from './errors.js';

const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,239}$/;

const required = (environment, key) => {
  const value = String(environment[key] || '').trim();
  if (!value) throw new WorkerError(`${key} is required.`, { code: 'slicer_worker_configuration_invalid' });
  return value;
};

const boundedInteger = (environment, key, fallback, minimum, maximum) => {
  const raw = String(environment[key] ?? '').trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkerError(`${key} must be an integer from ${minimum} to ${maximum}.`, {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  return value;
};

const apiBaseUrl = (environment, { allowInsecureLoopback = false } = {}) => {
  const raw = required(environment, 'AM_PILOT_API_BASE_URL');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkerError('AM_PILOT_API_BASE_URL must be an absolute URL.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:')) {
    throw new WorkerError('AM_PILOT_API_BASE_URL must use HTTPS.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new WorkerError('AM_PILOT_API_BASE_URL must not contain credentials, query, or fragment.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
};

export const loadWorkerConfig = (environment = process.env, options = {}) => {
  const controlToken = required(environment, 'SLICER_WORKER_CONTROL_TOKEN');
  if (Buffer.byteLength(controlToken, 'utf8') < 32) {
    throw new WorkerError('SLICER_WORKER_CONTROL_TOKEN must contain at least 32 bytes.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  const workerId = required(environment, 'SLICER_WORKER_ID').toLowerCase();
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new WorkerError('SLICER_WORKER_ID is invalid.', { code: 'slicer_worker_configuration_invalid' });
  }
  const imageDigest = required(environment, 'SLICER_IMAGE_DIGEST').toLowerCase();
  if (!IMAGE_DIGEST_PATTERN.test(imageDigest)) {
    throw new WorkerError('SLICER_IMAGE_DIGEST must be an immutable sha256 OCI digest.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  const prusaSlicerCommand = String(environment.PRUSA_SLICER_CMD || '/opt/prusa/bin/prusa-slicer').trim();
  if (!prusaSlicerCommand.startsWith('/') || !fs.existsSync(prusaSlicerCommand)) {
    throw new WorkerError('PRUSA_SLICER_CMD must identify an existing absolute executable path.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  const workRoot = String(environment.SLICER_WORK_ROOT || '/tmp/am-pilot-slicer-worker').trim();
  if (!workRoot.startsWith('/') || workRoot === '/') {
    throw new WorkerError('SLICER_WORK_ROOT must be a dedicated absolute directory.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  return Object.freeze({
    apiBaseUrl: apiBaseUrl(environment, options),
    controlToken,
    workerId,
    imageDigest,
    engineKey: ENGINE_KEY,
    protocolVersion: WORKER_PROTOCOL_VERSION,
    expectedPrusaVersion: PRUSA_SLICER_VERSION,
    prusaSlicerCommand,
    workRoot,
    pollIntervalMs: boundedInteger(environment, 'SLICER_POLL_INTERVAL_MS', DEFAULTS.pollIntervalMs, 1_000, 60_000),
    heartbeatIntervalMs: boundedInteger(environment, 'SLICER_HEARTBEAT_INTERVAL_MS', DEFAULTS.heartbeatIntervalMs, 5_000, 60_000),
    requestTimeoutMs: boundedInteger(environment, 'SLICER_REQUEST_TIMEOUT_MS', DEFAULTS.requestTimeoutMs, 1_000, 120_000),
    jobTimeoutMs: boundedInteger(environment, 'SLICER_JOB_TIMEOUT_MS', DEFAULTS.jobTimeoutMs, 30_000, 7_200_000),
    maximumModelBytes: boundedInteger(environment, 'SLICER_MAX_MODEL_BYTES', DEFAULTS.maximumModelBytes, 1_048_576, 2_147_483_648),
    maximumGcodeBytes: boundedInteger(environment, 'SLICER_MAX_GCODE_BYTES', DEFAULTS.maximumGcodeBytes, 1_048_576, 2_147_483_648),
    maximumManifestBytes: boundedInteger(environment, 'SLICER_MAX_MANIFEST_BYTES', DEFAULTS.maximumManifestBytes, 1_024, 8_388_608),
    maximumObjectsPerPlate: boundedInteger(environment, 'SLICER_MAX_OBJECTS_PER_PLATE', DEFAULTS.maximumObjectsPerPlate, 1, 10_000),
    maximumModelsPerRun: boundedInteger(environment, 'SLICER_MAX_MODELS_PER_RUN', DEFAULTS.maximumModelsPerRun, 1, 10_000),
    maximumLogBytes: boundedInteger(environment, 'SLICER_MAX_LOG_BYTES', DEFAULTS.maximumLogBytes, 4_096, 4_194_304),
    engineThreads: boundedInteger(environment, 'SLICER_ENGINE_THREADS', DEFAULTS.engineThreads, 1, 4),
    retryBackoffMaximumMs: boundedInteger(environment, 'SLICER_RETRY_BACKOFF_MAX_MS', DEFAULTS.retryBackoffMaximumMs, 3_000, 300_000)
  });
};
