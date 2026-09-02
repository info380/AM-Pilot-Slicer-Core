import fs from 'node:fs/promises';
import path from 'node:path';

import { WorkerError } from './errors.js';
import { runProcess } from './process.js';
import { buildTransformed3mf } from './three-mf.js';
import { buildPlateObjectTransform } from './transform.js';

const safeSegment = (value, fallback) => {
  const normalized = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return normalized || fallback;
};

const verifyPlateContract = ({ inputSnapshot, effectiveConfiguration, config }) => {
  if (!inputSnapshot || inputSnapshot.schema !== 'am-pilot-slicer-input-snapshot' || Number(inputSnapshot.version) !== 1) {
    throw new WorkerError('The Slicer input snapshot is unsupported.', { code: 'slicer_input_snapshot_invalid' });
  }
  const models = Array.isArray(inputSnapshot.models) ? inputSnapshot.models : [];
  const objects = Array.isArray(inputSnapshot.plate?.objects) ? inputSnapshot.plate.objects : [];
  if (!models.length || !objects.length) {
    throw new WorkerError('The Slicer input snapshot contains no models or plate objects.', {
      code: 'slicer_input_snapshot_invalid'
    });
  }
  if (models.length > config.maximumModelsPerRun || objects.length > config.maximumObjectsPerPlate) {
    throw new WorkerError('The Slicer input exceeds the qualified worker object limits.', {
      code: 'slicer_input_limit_exceeded'
    });
  }
  if (!effectiveConfiguration?.coordinateMapping || !effectiveConfiguration?.prusaConfig) {
    throw new WorkerError('The effective Slicer configuration is incomplete.', {
      code: 'slicer_effective_configuration_invalid'
    });
  }
  return { models, objects };
};

const normalizeSourceTo3mf = async ({ sourcePath, outputPath, config, signal }) => {
  await runProcess({
    command: config.prusaSlicerCommand,
    args: [
      '--export-3mf',
      '--dont-arrange',
      '--no-ensure-on-bed',
      '--config-compatibility', 'disable',
      '--output', outputPath,
      sourcePath
    ],
    cwd: path.dirname(outputPath),
    timeoutMs: config.jobTimeoutMs,
    maximumLogBytes: config.maximumLogBytes,
    signal
  });
};

export const materializePlateInputs = async ({
  inputSnapshot,
  effectiveConfiguration,
  downloadedModels,
  workDir,
  config,
  signal,
  onProgress = async () => {}
}) => {
  const { models, objects } = verifyPlateContract({ inputSnapshot, effectiveConfiguration, config });
  const sourceByProjectFileId = new Map();
  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    const sourcePath = downloadedModels.get(model.modelId);
    if (!sourcePath) {
      throw new WorkerError('A downloaded source model is missing.', { code: 'slicer_source_model_missing' });
    }
    const normalizedPath = path.join(workDir, `normalized-${String(index + 1).padStart(4, '0')}.3mf`);
    await onProgress({
      stage: 'preparing',
      progressPercent: Math.round(10 + ((index / models.length) * 15)),
      message: `Normalizing source model ${index + 1} of ${models.length}.`
    });
    await normalizeSourceTo3mf({ sourcePath, outputPath: normalizedPath, config, signal });
    sourceByProjectFileId.set(model.projectFileId, await fs.readFile(normalizedPath));
  }

  const result = [];
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    const source = sourceByProjectFileId.get(object.fileId);
    if (!source) {
      throw new WorkerError('A plate object references an unavailable project file.', {
        code: 'slicer_source_model_missing'
      });
    }
    if (object.placement?.status !== 'placed') {
      throw new WorkerError('A plate object has not been placed.', { code: 'slicer_placement_incomplete' });
    }
    const objectTransform = buildPlateObjectTransform({
      transform: object.transform,
      coordinateMapping: effectiveConfiguration.coordinateMapping
    });
    const targetPath = path.join(
      workDir,
      `plate-${String(index + 1).padStart(4, '0')}-${safeSegment(object.id, 'object')}.3mf`
    );
    await fs.writeFile(targetPath, buildTransformed3mf({ source, objectTransform }), { mode: 0o600 });
    result.push(targetPath);
  }
  return result;
};
