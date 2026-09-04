import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  RESULT_MANIFEST_SCHEMA,
  RESULT_MANIFEST_VERSION,
  WORKER_PROTOCOL_VERSION
} from './constants.js';
import { WorkerError } from './errors.js';

const stableJson = value => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const buildSliceEvidenceChecksum = ({ run, result }) => {
  if (!run?.id || !result?.artifact) {
    throw new WorkerError('Slice evidence inputs are incomplete.', { code: 'slicer_result_manifest_invalid' });
  }
  return createHash('sha256').update(stableJson({
    runId: run.id,
    inputFingerprint: run.inputFingerprint,
    engine: {
      key: run.engineKey,
      versionId: run.engineVersionId,
      imageDigest: run.engineImageDigest,
      capabilityRevisionId: run.capabilityRevisionId,
      workerProtocolVersion: WORKER_PROTOCOL_VERSION
    },
    effectiveConfigurationChecksumSha256: run.effectiveConfigurationChecksumSha256,
    gcode: result.artifact,
    metrics: result.metrics,
    warnings: result.warnings
  })).digest('hex');
};

export const buildResultManifest = ({ run, engine, result, toolpathPreview, sliceEvidenceChecksumSha256 }) => {
  if (
    !run?.id
    || !run?.inputFingerprint
    || !result?.artifact
    || !toolpathPreview
    || !/^[0-9a-f]{64}$/.test(String(sliceEvidenceChecksumSha256 || ''))
  ) {
    throw new WorkerError('Result manifest inputs are incomplete.', { code: 'slicer_result_manifest_invalid' });
  }
  return Object.freeze({
    schema: RESULT_MANIFEST_SCHEMA,
    version: RESULT_MANIFEST_VERSION,
    runId: run.id,
    inputFingerprint: run.inputFingerprint,
    engine: Object.freeze({
      key: run.engineKey,
      versionId: run.engineVersionId,
      imageDigest: run.engineImageDigest,
      capabilityRevisionId: run.capabilityRevisionId,
      workerProtocolVersion: WORKER_PROTOCOL_VERSION
    }),
    effectiveConfigurationChecksumSha256: run.effectiveConfigurationChecksumSha256,
    sliceEvidenceChecksumSha256,
    outputs: Object.freeze({
      gcode: result.artifact,
      toolpathPreview
    }),
    metrics: result.metrics,
    warnings: result.warnings
  });
};

export const writeResultManifest = async ({ workDir, manifest, maximumBytes }) => {
  const target = path.join(workDir, 'manifest.json');
  const payload = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(payload) > maximumBytes) {
    throw new WorkerError('Result manifest exceeds the qualified output limit.', {
      code: 'slicer_result_manifest_size_invalid'
    });
  }
  await fs.writeFile(target, payload, { mode: 0o600 });
  return target;
};
