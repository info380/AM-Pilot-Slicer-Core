import fs from 'node:fs/promises';
import path from 'node:path';

import { SlicerWorkerApiClient } from './api-client.js';
import {
  EFFECTIVE_CONFIG_SCHEMA,
  EFFECTIVE_CONFIG_VERSION,
  INPUT_SNAPSHOT_SCHEMA,
  INPUT_SNAPSHOT_VERSION
} from './constants.js';
import { boundedFailureMessage, asWorkerError, WorkerError } from './errors.js';
import { verifyPrusaSlicer, runSlicerEngine } from './engine.js';
import { buildResultManifest, writeResultManifest } from './manifest.js';
import { materializePlateInputs } from './plate.js';

const LEASE_TERMINAL_CODES = new Set([
  'slicer_worker_lease_conflict',
  'slicer_worker_lease_expired',
  'slicer_worker_lease_lost',
  'slicer_worker_cancel_requested',
  'slicer_worker_run_cancelled',
  'slicer_run_cancelled'
]);

const sleep = async (milliseconds, signal) => await new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(signal.reason || new Error('Aborted'));
    return;
  }
  const timer = setTimeout(resolve, milliseconds);
  timer.unref?.();
  signal?.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason || new Error('Aborted'));
  }, { once: true });
});

const log = (level, event, details = {}) => {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details
  })}\n`);
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export const validateClaim = (claim, config) => {
  const run = claim?.run;
  const engine = claim?.engine;
  const inputFingerprint = String(run?.inputFingerprint || '').toLowerCase();
  const effectiveConfigurationChecksum = String(run?.effectiveConfigurationChecksumSha256 || '').toLowerCase();
  if (
    Number(claim?.protocolVersion) !== config.protocolVersion
    || !run?.id
    || run.engineKey !== config.engineKey
    || run.engineImageDigest !== config.imageDigest
    || !IMAGE_DIGEST_PATTERN.test(String(run.engineImageDigest || ''))
    || Number(run.workerProtocolVersion) !== config.protocolVersion
    || !/^sha256:[0-9a-f]{64}$/.test(inputFingerprint)
    || !SHA256_PATTERN.test(effectiveConfigurationChecksum)
    || !engine?.id
    || engine.id !== run.engineVersionId
    || engine.engineKey !== run.engineKey
    || engine.imageDigest !== run.engineImageDigest
    || engine.capabilityRevisionId !== run.capabilityRevisionId
    || Number(engine.workerProtocolVersion) !== config.protocolVersion
    || !claim?.lease?.token
    || claim?.inputSnapshot?.schema !== INPUT_SNAPSHOT_SCHEMA
    || Number(claim?.inputSnapshot?.version) !== INPUT_SNAPSHOT_VERSION
    || claim?.effectiveConfiguration?.schema !== EFFECTIVE_CONFIG_SCHEMA
    || Number(claim?.effectiveConfiguration?.version) !== EFFECTIVE_CONFIG_VERSION
    || claim?.effectiveConfiguration?.engineAdapter !== config.engineKey
  ) {
    throw new WorkerError('The claimed Slicer run does not match this worker release.', {
      code: 'slicer_worker_claim_invalid'
    });
  }
  return claim;
};

export const downloadModelWithRetry = async ({
  api,
  runId,
  leaseToken,
  model,
  targetPath,
  signal,
  sleepImpl = sleep
}) => {
  let delayMs = 1_000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await api.downloadModel({ runId, leaseToken, model, targetPath, signal });
    } catch (error) {
      await fs.rm(targetPath, { force: true });
      if (!error.retryable || attempt === 3) throw error;
      await sleepImpl(delayMs, signal);
      delayMs *= 2;
    }
  }
  throw new WorkerError('Source model download retry budget was exhausted.', {
    code: 'slicer_source_model_download_failed'
  });
};

const completeWithRetry = async ({ api, run, leaseToken, gcodePath, manifestPath, signal, config }) => {
  let delayMs = 1_000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await api.complete({ run, leaseToken, gcodePath, manifestPath, signal });
    } catch (error) {
      if (!error.retryable || attempt === 3) throw error;
      await sleep(delayMs, signal);
      delayMs *= 2;
    }
  }
  throw new WorkerError('Slicer result upload retry budget was exhausted.', {
    code: 'slicer_worker_completion_failed'
  });
};

const runClaim = async ({ claim: rawClaim, api, config, shutdownSignal }) => {
  const claim = validateClaim(rawClaim, config);
  const { run, lease, inputSnapshot, effectiveConfiguration } = claim;
  const safeRunId = String(run.id).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'run';
  const workDir = await fs.mkdtemp(path.join(config.workRoot, `${safeRunId}-`));
  await fs.chmod(workDir, 0o700);
  const jobAbort = new AbortController();
  const jobSignal = shutdownSignal
    ? AbortSignal.any([shutdownSignal, jobAbort.signal])
    : jobAbort.signal;
  let progress = {
    stage: 'claimed',
    progressPercent: 1,
    message: 'Slicer worker claimed the immutable run.'
  };
  let heartbeatActive = false;
  const sendProgress = async update => {
    progress = { ...progress, ...update };
    await api.progress({
      runId: run.id,
      leaseToken: lease.token,
      ...progress,
      markRunning: true,
      signal: jobSignal
    });
  };
  const heartbeat = setInterval(async () => {
    if (heartbeatActive || jobSignal.aborted) return;
    heartbeatActive = true;
    try {
      await sendProgress(progress);
    } catch (error) {
      jobAbort.abort(error);
    } finally {
      heartbeatActive = false;
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  try {
    await sendProgress({ stage: 'downloading', progressPercent: 3, message: 'Downloading immutable source models.' });
    const downloadedModels = new Map();
    const models = inputSnapshot.models;
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      const format = String(model.sourceFormat || '').toLowerCase();
      if (!['stl', '3mf'].includes(format)) {
        throw new WorkerError('The source model format is unsupported.', { code: 'slicer_source_format_unsupported' });
      }
      const targetPath = path.join(workDir, `source-${String(index + 1).padStart(4, '0')}.${format}`);
      await downloadModelWithRetry({
        api,
        runId: run.id,
        leaseToken: lease.token,
        model,
        targetPath,
        signal: jobSignal
      });
      downloadedModels.set(model.modelId, targetPath);
    }
    const plateInputPaths = await materializePlateInputs({
      inputSnapshot,
      effectiveConfiguration,
      downloadedModels,
      workDir,
      config,
      signal: jobSignal,
      onProgress: sendProgress
    });
    const result = await runSlicerEngine({
      plateInputPaths,
      effectiveConfiguration,
      workDir,
      config,
      signal: jobSignal,
      onProgress: sendProgress
    });
    const manifest = buildResultManifest({ run, engine: claim.engine, result });
    const manifestPath = await writeResultManifest({
      workDir,
      manifest,
      maximumBytes: config.maximumManifestBytes
    });
    await sendProgress({
      stage: 'finalizing',
      progressPercent: 95,
      message: 'Publishing immutable Slicer result evidence.'
    });
    await completeWithRetry({
      api,
      run,
      leaseToken: lease.token,
      gcodePath: result.gcodePath,
      manifestPath,
      signal: jobSignal,
      config
    });
    log('info', 'slicer_run_completed', { runId: run.id });
  } catch (rawError) {
    const error = jobSignal.aborted && jobSignal.reason instanceof Error
      ? asWorkerError(jobSignal.reason)
      : asWorkerError(rawError);
    log('error', 'slicer_run_failed', { runId: run.id, failureCode: error.code });
    if (!shutdownSignal?.aborted && !LEASE_TERMINAL_CODES.has(error.code)) {
      try {
        await api.fail({
          runId: run.id,
          leaseToken: lease.token,
          failureCode: error.code,
          failureMessage: boundedFailureMessage(error),
          signal: shutdownSignal?.aborted ? null : shutdownSignal
        });
      } catch (failError) {
        log('error', 'slicer_run_failure_report_rejected', {
          runId: run.id,
          failureCode: asWorkerError(failError).code
        });
      }
    }
  } finally {
    clearInterval(heartbeat);
    await fs.rm(workDir, { recursive: true, force: true });
  }
};

export const runWorker = async ({ config, fetchImpl = globalThis.fetch, signal = null }) => {
  await fs.mkdir(config.workRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(config.workRoot, 0o700);
  const api = new SlicerWorkerApiClient(config, { fetchImpl });
  const engineVersion = await verifyPrusaSlicer(config);
  const health = await api.health();
  if (health?.ready !== true || Number(health?.workerProtocolVersion) !== config.protocolVersion) {
    throw new WorkerError('The AM Pilot API does not support this worker protocol.', {
      code: 'slicer_worker_protocol_unsupported'
    });
  }
  log('info', 'slicer_worker_ready', {
    workerId: config.workerId,
    engineKey: config.engineKey,
    imageDigest: config.imageDigest,
    protocolVersion: config.protocolVersion,
    engineVersion
  });

  let consecutiveErrors = 0;
  while (!signal?.aborted) {
    try {
      const claim = await api.claim({ signal });
      consecutiveErrors = 0;
      if (claim) await runClaim({ claim, api, config, shutdownSignal: signal });
      else await sleep(config.pollIntervalMs, signal);
    } catch (rawError) {
      if (signal?.aborted) break;
      const error = asWorkerError(rawError);
      consecutiveErrors += 1;
      log('error', 'slicer_worker_control_error', { failureCode: error.code, retryable: error.retryable });
      if (!error.retryable) throw error;
      const delay = Math.min(config.retryBackoffMaximumMs, 1_000 * (2 ** Math.min(consecutiveErrors, 5)));
      await sleep(delay, signal);
    }
  }
  log('info', 'slicer_worker_stopped', { workerId: config.workerId });
};
