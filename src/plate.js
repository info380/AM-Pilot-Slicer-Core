import { BAMBU_ENGINE_KEY } from './bambu-engine.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import { WorkerError } from './errors.js';
import { runProcess } from './process.js';
import { buildTransformed3mf, mergePlate3mf } from './three-mf.js';
import { buildPlateObjectTransform } from './transform.js';
import { compileObjectOverrides } from './object-overrides.js';
import { buildSupportPainted3mf, assertSupportPaintRoundtrip } from './support-paint.js';

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
  if (!effectiveConfiguration?.coordinateMapping || !(effectiveConfiguration?.prusaConfig || effectiveConfiguration?.engineAdapter === BAMBU_ENGINE_KEY && effectiveConfiguration?.bambuConfig)) {
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
  let totalNormalizedBytes = 0;
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
    const normalizedSize = Number((await fs.stat(normalizedPath)).size);
    totalNormalizedBytes += normalizedSize;
    if (
      !Number.isSafeInteger(normalizedSize)
      || normalizedSize <= 0
      || normalizedSize > config.maximumNormalizedModelBytes
      || !Number.isSafeInteger(totalNormalizedBytes)
      || totalNormalizedBytes > config.maximumTotalNormalizedBytes
    ) {
      throw new WorkerError('Normalized Slicer geometry exceeds the qualified byte limits.', {
        code: 'slicer_normalized_model_size_exceeded'
      });
    }
    sourceByProjectFileId.set(model.projectFileId, await fs.readFile(normalizedPath));
  }

  const bambu = effectiveConfiguration.engineAdapter === BAMBU_ENGINE_KEY;
  if (bambu && objects.some(object => object.supportPaint?.data || Object.keys(object.printOverrides || {}).length)) {
    throw new WorkerError('This Bambu revision does not support object overrides or painted supports.', { code: 'slicer_object_overrides_unqualified' });
  }
  const result = [];
  let totalPlateInputBytes = 0;
  for (let index = 0; index < objects.length; index += 1) {
    const object = objects[index];
    let source = sourceByProjectFileId.get(object.fileId);
    if (!source) {
      throw new WorkerError('A plate object references an unavailable project file.', {
        code: 'slicer_source_model_missing'
      });
    }
    if (object.placement?.status !== 'placed') {
      throw new WorkerError('A plate object has not been placed.', { code: 'slicer_placement_incomplete' });
    }
    if (object.supportPaint?.data) {
      const model = models.find(entry => entry.projectFileId === object.fileId);
      const annotatedPath = path.join(workDir, `paint-source-${index}.3mf`);
      const normalizedPath = path.join(workDir, `paint-normalized-${index}.3mf`);
      const annotated = buildSupportPainted3mf({
        source: await fs.readFile(downloadedModels.get(model.modelId)), model,
        paint: object.supportPaint, maximumUncompressedBytes: config.maximumNormalizedModelBytes
      });
      await fs.writeFile(annotatedPath, annotated, { mode: 0o600 });
      await normalizeSourceTo3mf({ sourcePath: annotatedPath, outputPath: normalizedPath, config, signal });
      const size = (await fs.stat(normalizedPath)).size;
      totalNormalizedBytes += size;
      if (size > config.maximumNormalizedModelBytes || totalNormalizedBytes > config.maximumTotalNormalizedBytes) {
        throw new WorkerError('Painted geometry exceeds qualified normalization limits.', { code: 'slicer_normalized_model_size_exceeded' });
      }
      source = await fs.readFile(normalizedPath);
      assertSupportPaintRoundtrip({ before: annotated, after: source, maximumUncompressedBytes: config.maximumNormalizedModelBytes });
    }
    const objectTransform = buildPlateObjectTransform({
      transform: object.transform,
      coordinateMapping: effectiveConfiguration.coordinateMapping
    });
    const targetPath = path.join(
      workDir,
      `plate-${String(index + 1).padStart(4, '0')}-${safeSegment(object.id, 'object')}.3mf`
    );
    const transformed = buildTransformed3mf({
      source,
      objectTransform,
      objectOverrides: compileObjectOverrides(object.printOverrides || {}),
      maximumUncompressedBytes: config.maximumNormalizedModelBytes
    });
    totalPlateInputBytes += transformed.length;
    if (!Number.isSafeInteger(totalPlateInputBytes) || totalPlateInputBytes > config.maximumPlateInputBytes) {
      throw new WorkerError('Generated plate inputs exceed the qualified aggregate byte limit.', {
        code: 'slicer_plate_input_size_exceeded'
      });
    }
    await fs.writeFile(targetPath, transformed, { mode: 0o600 });
    result.push(targetPath);
  }
  if (bambu) {
    const merged = mergePlate3mf({ sources: await Promise.all(result.map(filename => fs.readFile(filename))), maximumUncompressedBytes: config.maximumPlateInputBytes });
    const filename = path.join(workDir, 'bambu-plate.3mf');
    await fs.writeFile(filename, merged, { mode: 0o600 });
    return [filename];
  }
  return result;
};
