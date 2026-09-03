import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SlicerWorkerApiClient } from 'file:///worker/src/api-client.js';
import { inspectGcode } from 'file:///worker/src/gcode.js';
import { writeResultManifest } from 'file:///worker/src/manifest.js';
import { materializePlateInputs } from 'file:///worker/src/plate.js';
import { runProcess } from 'file:///worker/src/process.js';
import { buildTransformed3mf } from 'file:///worker/src/three-mf.js';
import { IDENTITY_3MF_TRANSFORM } from 'file:///worker/src/transform.js';
import { WorkerError } from 'file:///worker/src/errors.js';
import { downloadModelWithRetry } from 'file:///worker/src/worker.js';

const REPORT_SCHEMA = 'am-pilot-slicer-core-failure-corpus-report';
const REPORT_VERSION = 1;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PRUSA_SLICER = '/opt/prusa/bin/prusa-slicer';
const WORK_ROOT = '/tmp/am-pilot-slicer-failure-qualification';
const OUTPUT_ROOT = String(process.env.QUALIFICATION_OUTPUT_DIR || '/qualification-output').trim();
const IMAGE_DIGEST = String(process.env.QUALIFICATION_IMAGE_DIGEST || '').trim().toLowerCase();
const RELEASE_TAG = String(process.env.QUALIFICATION_RELEASE_TAG || '').trim();

if (!IMAGE_DIGEST_PATTERN.test(IMAGE_DIGEST)) {
  throw new Error('QUALIFICATION_IMAGE_DIGEST must be an immutable SHA-256 OCI digest.');
}
if (!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(RELEASE_TAG)) {
  throw new Error('QUALIFICATION_RELEASE_TAG must be a semantic release tag.');
}
if (!OUTPUT_ROOT.startsWith('/') || OUTPUT_ROOT === '/') {
  throw new Error('QUALIFICATION_OUTPUT_DIR must be a dedicated absolute directory.');
}

const config = Object.freeze({
  apiBaseUrl: new URL('https://qualification.invalid'),
  controlToken: 'synthetic-control-token'.padEnd(48, 'x'),
  workerId: 'digest-failure-qualification',
  engineKey: 'fdm.am_pilot_prusa_core',
  imageDigest: IMAGE_DIGEST,
  protocolVersion: 1,
  prusaSlicerCommand: PRUSA_SLICER,
  workRoot: WORK_ROOT,
  requestTimeoutMs: 5_000,
  jobTimeoutMs: 30_000,
  maximumLogBytes: 65_536,
  maximumModelBytes: 32 * 1024 * 1024,
  maximumTotalModelBytes: 128 * 1024 * 1024,
  maximumNormalizedModelBytes: 64 * 1024 * 1024,
  maximumTotalNormalizedBytes: 128 * 1024 * 1024,
  maximumPlateInputBytes: 192 * 1024 * 1024,
  maximumModelsPerRun: 8,
  maximumObjectsPerPlate: 16
});

const effectiveConfiguration = Object.freeze({
  coordinateMapping: Object.freeze({
    projectOrigin: 'center',
    engineBedOrigin: 'front_left',
    translationMm: Object.freeze({ x: 100, y: 100, z: 0 })
  }),
  prusaConfig: Object.freeze({ printer_technology: 'FFF' })
});

const results = [];

const expectFailure = async ({ name, expectedCode, expectedRetryable = false, execute }) => {
  let failure = null;
  try {
    await execute();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure, `${name} unexpectedly succeeded.`);
  assert.equal(failure.code, expectedCode, `${name} returned the wrong failure code.`);
  assert.equal(failure.retryable === true, expectedRetryable, `${name} returned the wrong retry policy.`);
  results.push(Object.freeze({
    name,
    status: 'passed',
    failureCode: failure.code,
    retryable: failure.retryable === true
  }));
};

const recordSuccess = (name, evidence) => {
  results.push(Object.freeze({ name, status: 'passed', ...evidence }));
};

await fs.mkdir(OUTPUT_ROOT, { recursive: true, mode: 0o700 });
await fs.rm(WORK_ROOT, { recursive: true, force: true });
await fs.mkdir(WORK_ROOT, { recursive: true, mode: 0o700 });

const malformedStlRoot = path.join(WORK_ROOT, 'malformed-stl');
await fs.mkdir(malformedStlRoot, { recursive: true, mode: 0o700 });
const malformedStlPath = path.join(malformedStlRoot, 'malformed.stl');
await fs.writeFile(malformedStlPath, 'this is not an STL payload\n', { mode: 0o600 });
await expectFailure({
  name: 'malformed-stl-normalization',
  expectedCode: 'slicer_engine_failed',
  execute: async () => await materializePlateInputs({
    inputSnapshot: {
      schema: 'am-pilot-slicer-input-snapshot',
      version: 1,
      models: [{ modelId: 'malformed-stl', projectFileId: 'malformed-stl-file' }],
      plate: {
        objects: [{
          id: 'malformed-stl-object',
          fileId: 'malformed-stl-file',
          placement: { status: 'placed' },
          transform: {
            positionMm: { x: 0, y: 0, z: 0 },
            rotationDeg: { x: 0, y: 0, z: 0 },
            scale: { x: 1, y: 1, z: 1 }
          }
        }]
      }
    },
    effectiveConfiguration,
    downloadedModels: new Map([['malformed-stl', malformedStlPath]]),
    workDir: malformedStlRoot,
    config
  })
});

await expectFailure({
  name: 'malformed-3mf-package',
  expectedCode: 'slicer_source_3mf_invalid',
  execute: async () => buildTransformed3mf({
    source: Buffer.from('this is not a 3MF archive'),
    objectTransform: IDENTITY_3MF_TRANSFORM,
    maximumUncompressedBytes: config.maximumNormalizedModelBytes
  })
});

const expectedPayload = Buffer.from('expected-source-model');
const tamperedPayload = Buffer.from('tampered-source-model');
assert.equal(expectedPayload.length, tamperedPayload.length);
const expectedChecksum = createHash('sha256').update(expectedPayload).digest('hex');
const integrityTarget = path.join(WORK_ROOT, 'integrity-mismatch.stl');
const integrityClient = new SlicerWorkerApiClient(config, {
  fetchImpl: async () => new Response(tamperedPayload, {
    headers: {
      'content-length': String(expectedPayload.length),
      'x-content-sha256': expectedChecksum
    }
  })
});
await expectFailure({
  name: 'download-integrity-mismatch',
  expectedCode: 'slicer_source_model_integrity_mismatch',
  execute: async () => integrityClient.downloadModel({
    runId: 'failure-corpus-run',
    leaseToken: 'synthetic-lease-token',
    model: {
      modelId: 'integrity-model',
      sizeBytes: expectedPayload.length,
      checksumSha256: expectedChecksum
    },
    targetPath: integrityTarget
  })
});
await assert.rejects(fs.access(integrityTarget), { code: 'ENOENT' });

const cancelledController = new AbortController();
const cancelTimer = setTimeout(() => cancelledController.abort(new Error('Synthetic cancellation')), 25);
try {
  await expectFailure({
    name: 'process-cancellation',
    expectedCode: 'slicer_worker_cancelled',
    execute: async () => runProcess({
      command: process.execPath,
      args: ['--input-type=module', '--eval', 'setInterval(() => {}, 1000)'],
      cwd: WORK_ROOT,
      timeoutMs: 5_000,
      maximumLogBytes: config.maximumLogBytes,
      signal: cancelledController.signal
    })
  });
} finally {
  clearTimeout(cancelTimer);
}

const leaseClient = new SlicerWorkerApiClient(config, {
  fetchImpl: async () => Response.json({
    code: 'slicer_worker_lease_lost',
    error: 'The synthetic lease is no longer owned by this worker.'
  }, { status: 409 })
});
await expectFailure({
  name: 'lease-loss',
  expectedCode: 'slicer_worker_lease_lost',
  execute: async () => leaseClient.progress({
    runId: 'failure-corpus-run',
    leaseToken: 'synthetic-lease-token',
    stage: 'slicing',
    progressPercent: 50,
    message: 'Synthetic progress.'
  })
});

await expectFailure({
  name: 'process-timeout',
  expectedCode: 'slicer_engine_timeout',
  execute: async () => runProcess({
    command: process.execPath,
    args: ['--input-type=module', '--eval', 'setInterval(() => {}, 1000)'],
    cwd: WORK_ROOT,
    timeoutMs: 25,
    maximumLogBytes: config.maximumLogBytes
  })
});

const retryTarget = path.join(WORK_ROOT, 'retry-model.stl');
let retryAttempts = 0;
const retryApi = {
  async downloadModel({ targetPath }) {
    retryAttempts += 1;
    await fs.writeFile(targetPath, retryAttempts < 3 ? 'partial' : 'complete', { flag: 'wx', mode: 0o600 });
    if (retryAttempts < 3) {
      throw new WorkerError('Synthetic transient download failure.', {
        code: 'slicer_source_model_download_failed',
        retryable: true
      });
    }
    return targetPath;
  }
};
await downloadModelWithRetry({
  api: retryApi,
  runId: 'failure-corpus-run',
  leaseToken: 'synthetic-lease-token',
  model: { modelId: 'retry-model' },
  targetPath: retryTarget,
  sleepImpl: async () => {}
});
assert.equal(retryAttempts, 3);
assert.equal(await fs.readFile(retryTarget, 'utf8'), 'complete');
recordSuccess('transient-download-retry', { attempts: retryAttempts, partialFileRetained: false });

const oversizedGcodePath = path.join(WORK_ROOT, 'oversized.gcode');
await fs.writeFile(oversizedGcodePath, 'G28\n', { mode: 0o600 });
await expectFailure({
  name: 'gcode-output-limit',
  expectedCode: 'slicer_gcode_size_invalid',
  execute: async () => inspectGcode(oversizedGcodePath, 3)
});

await expectFailure({
  name: 'manifest-output-limit',
  expectedCode: 'slicer_result_manifest_size_invalid',
  execute: async () => writeResultManifest({
    workDir: WORK_ROOT,
    manifest: { synthetic: 'x'.repeat(256) },
    maximumBytes: 32
  })
});

assert.deepEqual(results.map(result => result.name), [
  'malformed-stl-normalization',
  'malformed-3mf-package',
  'download-integrity-mismatch',
  'process-cancellation',
  'lease-loss',
  'process-timeout',
  'transient-download-retry',
  'gcode-output-limit',
  'manifest-output-limit'
]);

const report = Object.freeze({
  schema: REPORT_SCHEMA,
  version: REPORT_VERSION,
  status: 'passed',
  generatedAt: new Date().toISOString(),
  release: Object.freeze({
    tag: RELEASE_TAG,
    image: 'ghcr.io/info380/am-pilot-slicer-core',
    imageDigest: IMAGE_DIGEST
  }),
  corpus: Object.freeze({
    source: 'synthetic-non-customer',
    networkRequired: false,
    cases: results.length
  }),
  cases: Object.freeze(results)
});

const reportPath = path.join(OUTPUT_ROOT, 'failure-corpus-report.json');
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
await fs.chmod(reportPath, 0o644);
process.stdout.write(`${JSON.stringify(report)}\n`);
