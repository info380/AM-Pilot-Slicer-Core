import fs from 'node:fs/promises';
import path from 'node:path';

import { PRUSA_SLICER_VERSION } from './constants.js';
import { serializePrusaConfig } from './config-ini.js';
import { WorkerError } from './errors.js';
import { canonicalizeGcodeHeader, extractWarnings, inspectGcode } from './gcode.js';
import { runProcess } from './process.js';

export const verifyPrusaSlicer = async config => {
  const result = await runProcess({
    command: config.prusaSlicerCommand,
    args: ['--help'],
    cwd: config.workRoot,
    timeoutMs: Math.min(config.requestTimeoutMs, 30_000),
    maximumLogBytes: config.maximumLogBytes
  });
  const versionText = `${result.stdout}\n${result.stderr}`.trim();
  if (!new RegExp(`\\b${PRUSA_SLICER_VERSION.replaceAll('.', '\\.') }\\b`).test(versionText)) {
    throw new WorkerError(`Expected PrusaSlicer ${PRUSA_SLICER_VERSION}, but the runtime reported a different version.`, {
      code: 'slicer_engine_version_mismatch'
    });
  }
  return versionText.split(/\r?\n/).find(Boolean) || `PrusaSlicer ${PRUSA_SLICER_VERSION}`;
};

export const runSlicerEngine = async ({
  plateInputPaths,
  effectiveConfiguration,
  workDir,
  config,
  signal,
  onProgress = async () => {}
}) => {
  if (!Array.isArray(plateInputPaths) || !plateInputPaths.length) {
    throw new WorkerError('No prepared plate inputs were provided to PrusaSlicer.', {
      code: 'slicer_plate_input_missing'
    });
  }
  const configPath = path.join(workDir, 'effective-config.ini');
  const gcodePath = path.join(workDir, 'output.gcode');
  const canonicalConfig = serializePrusaConfig(effectiveConfiguration?.prusaConfig);
  const hardenedConfig = `${canonicalConfig}post_process =\noutput_filename_format = output.gcode\n`;
  await fs.writeFile(configPath, hardenedConfig, { mode: 0o600 });
  await onProgress({
    stage: 'slicing',
    progressPercent: 30,
    message: 'Generating toolpaths with the qualified PrusaSlicer core.'
  });
  const result = await runProcess({
    command: config.prusaSlicerCommand,
    args: [
      '--export-gcode',
      '--merge',
      '--dont-arrange',
      '--no-ensure-on-bed',
      '--config-compatibility', 'disable',
      '--threads', String(config.engineThreads),
      '--load', configPath,
      '--post-process', '',
      '--output', gcodePath,
      ...plateInputPaths
    ],
    cwd: workDir,
    timeoutMs: config.jobTimeoutMs,
    maximumLogBytes: config.maximumLogBytes,
    signal
  });
  await onProgress({
    stage: 'validating',
    progressPercent: 85,
    message: 'Validating G-code and immutable output evidence.'
  });
  await canonicalizeGcodeHeader(gcodePath);
  const inspection = await inspectGcode(gcodePath, config.maximumGcodeBytes);
  return Object.freeze({
    gcodePath,
    artifact: inspection.artifact,
    metrics: inspection.metrics,
    warnings: extractWarnings(result)
  });
};
