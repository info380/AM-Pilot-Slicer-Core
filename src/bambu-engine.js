import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { WorkerError } from './errors.js';
import { runProcess } from './process.js';
import { inspectGcode, extractWarnings } from './gcode.js';

export const BAMBU_ENGINE_KEY = 'fdm.am_pilot_bambu_core';
export const BAMBU_STUDIO_VERSION = '02.08.02.61';
export const BAMBU_UPSTREAM_REVISION = '926a7192574bcb9b3a732e1ec59a46d79cb45466';
export const BAMBU_ARCHIVE_CONTENT_TYPE = 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml';
export const BAMBU_CAPABILITY_REVISION = 'fdm-bambu-2.8.2.61-protocol1-r2';
const failure = (message, code = 'slicer_bambu_configuration_invalid') => new WorkerError(message, { code });
const single = value => Array.isArray(value) && value.length === 1 ? value[0] : undefined;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// These are engine-supported models, not a tenant or printer-name allowlist.
// The exact nozzle and geometry still come from the immutable machine revision.
export const assertBambuEffectiveConfiguration = configuration => {
  const settings = configuration?.bambuConfig;
  if (configuration?.engineAdapter !== BAMBU_ENGINE_KEY || !settings || settings.version !== 1) {
    throw failure('The Bambu engine requires its own versioned effective configuration.');
  }
  const { machine, process: processSettings, filament } = settings;
  for (const [kind, value] of Object.entries({ machine, process: processSettings, filament })) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.type !== kind || !value.name
      || value.inherits || value.include) throw failure(`The ${kind} preset must be fully resolved.`);
    if (value.post_process && (!Array.isArray(value.post_process) || value.post_process.length)) {
      throw failure('External post-processing is not permitted.');
    }
    for (const field of ['print_host', 'printhost_apikey', 'printhost_cafile', 'bed_custom_model', 'bed_custom_texture']) {
      if (value[field]) throw failure('Presets must not reference external hosts, credentials or files.');
    }
  }
  if (!['Bambu Lab A1', 'Bambu Lab A2L'].includes(machine.printer_model)
    || !(Number(single(machine.nozzle_diameter)) > 0)
    || single(filament.filament_diameter) !== '1.75'
    || typeof single(filament.filament_type) !== 'string') {
    throw failure('A supported single-filament Bambu machine, nozzle and material are required.');
  }
  if (!processSettings.compatible_printers?.includes(machine.name)
    || !filament.compatible_printers?.includes(machine.name)) {
    throw failure('The process or filament preset does not support the selected machine and nozzle.');
  }
  if (!['Textured PEI Plate', 'Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Supertack Plate'].includes(processSettings.curr_bed_type)) {
    throw failure('Select an explicit supported build plate.');
  }
  return settings;
};

export const verifyBambuStudio = async config => {
  const result = await runProcess({ command: config.bambuStudioCommand, args: ['--help'], cwd: config.workRoot,
    timeoutMs: Math.min(config.requestTimeoutMs, 30000), maximumLogBytes: config.maximumLogBytes });
  const expected = `BambuStudio-${BAMBU_STUDIO_VERSION}:`;
  if (!`${result.stdout}\n${result.stderr}`.includes(expected)) {
    throw failure(`Expected Bambu Studio ${BAMBU_STUDIO_VERSION}.`, 'slicer_engine_version_mismatch');
  }
  return expected.slice(0, -1);
};

// Inspect only bounded, in-memory entries. No archive-supplied path is extracted.
export const inspectBambuOutput = ({ bytes, machine, filament, maximumArchiveBytes, maximumExpandedBytes, maximumGcodeBytes }) => {
  for (const limit of [maximumArchiveBytes, maximumExpandedBytes, maximumGcodeBytes]) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw failure('Explicit archive limits are required.');
  }
  if (!bytes.length || bytes.length > maximumArchiveBytes) throw failure('Bambu archive exceeds its byte limit.', 'slicer_bambu_archive_size_invalid');
  let entries = 0, expanded = 0;
  const seen = new Set(), plates = [];
  let files;
  try {
    files = unzipSync(bytes, { filter: entry => {
      entries += 1;
      expanded += entry.originalSize;
      const lower = entry.name.toLowerCase();
      if (entries > 4096 || seen.has(lower) || entry.name.includes('\\') || entry.name.startsWith('/')
        || entry.name.split('/').includes('..') || !Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0
        || !Number.isSafeInteger(expanded) || expanded > maximumExpandedBytes) {
        throw failure('Bambu archive entries exceed the validated limits.', 'slicer_bambu_archive_invalid');
      }
      seen.add(lower);
      if (/^metadata\/plate_\d+\.gcode$/i.test(entry.name)) {
        if (entry.originalSize > maximumGcodeBytes) throw failure('Bambu G-code exceeds its byte limit.', 'slicer_gcode_size_invalid');
        plates.push(entry.name);
        return true;
      }
      if (entry.name === 'Metadata/project_settings.config') {
        if (entry.originalSize > 2 * 1024 * 1024) throw failure('Bambu settings exceed the byte limit.', 'slicer_bambu_archive_invalid');
        return true;
      }
      return false;
    }});
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw failure('Bambu Studio produced an invalid archive.', 'slicer_bambu_archive_invalid');
  }
  if (plates.length !== 1 || plates[0] !== 'Metadata/plate_1.gcode') {
    throw failure('Native slicing must produce exactly one plate.', 'slicer_bambu_plate_invalid');
  }
  let settings;
  try { settings = JSON.parse(strFromU8(files['Metadata/project_settings.config'])); }
  catch { throw failure('Bambu output lacks settings evidence.', 'slicer_bambu_archive_invalid'); }
  if (settings.printer_model !== machine.printer_model
    || Number(single(settings.nozzle_diameter)) !== Number(single(machine.nozzle_diameter))
    || single(settings.filament_type) !== single(filament.filament_type)) {
    throw failure('Bambu output does not match the requested hardware and material.', 'slicer_bambu_output_mismatch');
  }
  const gcode = files[plates[0]];
  if (!gcode?.length || gcode.includes(0) || !strFromU8(gcode.subarray(0, 256)).includes(`; BambuStudio ${BAMBU_STUDIO_VERSION}`)) {
    throw failure('Bambu output lacks the expected generator evidence.', 'slicer_gcode_header_invalid');
  }
  return { gcode, archiveArtifact: { checksumSha256: digest(bytes), sizeBytes: bytes.length, contentType: BAMBU_ARCHIVE_CONTENT_TYPE },
    platePath: plates[0] };
};

export const runBambuEngine = async ({ plateInputPaths, effectiveConfiguration, workDir, config, signal, onProgress = async () => {} }) => {
  const presets = assertBambuEffectiveConfiguration(effectiveConfiguration);
  // A single geometry package owns all plate objects and their explicit placement.
  if (!Array.isArray(plateInputPaths) || plateInputPaths.length !== 1) {
    throw failure('Bambu slicing requires one assembled plate package.', 'slicer_plate_input_missing');
  }
  const paths = {};
  for (const kind of ['machine', 'process', 'filament']) {
    paths[kind] = path.join(workDir, `${kind}.json`);
    const settings = { ...presets[kind] };
    delete settings.post_process; // Not a Bambu preset option; nonempty values are rejected above.
    await fs.writeFile(paths[kind], JSON.stringify(settings), { mode: 0o600 });
  }
  await onProgress({ stage: 'slicing', progressPercent: 30, message: 'Generating Bambu toolpaths and the print archive.' });
  const processResult = await runProcess({ command: config.bambuStudioCommand,
    args: ['--debug', '2', '--datadir', path.join(workDir, 'bambu-data'), '--arrange', '0', '--orient', '0',
      '--skip-useless-pick', '--min-save', '--load-settings', `${paths.machine};${paths.process}`,
      '--load-filaments', paths.filament, '--slice', '0', '--export-3mf', 'output.gcode.3mf', '--outputdir', workDir, ...plateInputPaths],
    cwd: workDir, timeoutMs: config.jobTimeoutMs, maximumLogBytes: config.maximumLogBytes, signal });
  await onProgress({ stage: 'validating', progressPercent: 85, message: 'Checking Bambu archive and matching preview evidence.' });
  const archivePath = path.join(workDir, 'output.gcode.3mf');
  const info = await fs.lstat(archivePath);
  if (!info.isFile() || info.size > config.maximumArchiveBytes) throw failure('Invalid Bambu archive output.', 'slicer_bambu_archive_size_invalid');
  const inspected = inspectBambuOutput({ bytes: new Uint8Array(await fs.readFile(archivePath)),
    machine: presets.machine, filament: presets.filament, maximumArchiveBytes: config.maximumArchiveBytes,
    maximumExpandedBytes: config.maximumExpandedArchiveBytes, maximumGcodeBytes: config.maximumGcodeBytes });
  const gcodePath = path.join(workDir, 'output.gcode');
  // Preserve bytes exactly: the displayed toolpaths must describe the archive's G-code.
  await fs.writeFile(gcodePath, inspected.gcode, { mode: 0o600 });
  const inspection = await inspectGcode(gcodePath, config.maximumGcodeBytes);
  return { gcodePath, archivePath, artifact: inspection.artifact, archiveArtifact: inspected.archiveArtifact,
    metrics: inspection.metrics, warnings: extractWarnings(processResult) };
};
