import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { PRODUCTION_TOOLPATH_CONTENT_TYPE } from './constants.js';
import { WorkerError } from './errors.js';

export const PRODUCTION_TOOLPATH_SCHEMA = 'am-pilot-production-toolpath';
export const PRODUCTION_TOOLPATH_VERSION = 1;
export const PRODUCTION_TOOLPATH_MAGIC = 'AMPTP001';
export const PRODUCTION_TOOLPATH_PREFIX_BYTES = 16;
export const PRODUCTION_TOOLPATH_RECORD_BYTES = 64;
export const PRODUCTION_TOOLPATH_MAX_HEADER_BYTES = 8 * 1024 * 1024;

// One chunk is 1 MiB of fixed records. The chunk index lets future clients
// range-fetch independently without changing the version-one record layout.
export const PRODUCTION_TOOLPATH_CHUNK_RECORDS = 16_384;

const MOVE_KINDS = Object.freeze([
  Object.freeze({ id: 0, key: 'travel', displayName: 'Travel' }),
  Object.freeze({ id: 1, key: 'extrusion', displayName: 'Extrusion' }),
  Object.freeze({ id: 2, key: 'retraction', displayName: 'Retraction' }),
  Object.freeze({ id: 3, key: 'unretraction', displayName: 'Unretraction' })
]);

const FEATURES = Object.freeze([
  Object.freeze({ id: 0, key: 'unknown', displayName: 'Unknown' }),
  Object.freeze({ id: 1, key: 'perimeter', displayName: 'Perimeter' }),
  Object.freeze({ id: 2, key: 'external_perimeter', displayName: 'External perimeter' }),
  Object.freeze({ id: 3, key: 'overhang_perimeter', displayName: 'Overhang perimeter' }),
  Object.freeze({ id: 4, key: 'internal_infill', displayName: 'Internal infill' }),
  Object.freeze({ id: 5, key: 'solid_infill', displayName: 'Solid infill' }),
  Object.freeze({ id: 6, key: 'top_solid_infill', displayName: 'Top solid infill' }),
  Object.freeze({ id: 7, key: 'bridge_infill', displayName: 'Bridge infill' }),
  Object.freeze({ id: 8, key: 'support', displayName: 'Support' }),
  Object.freeze({ id: 9, key: 'support_interface', displayName: 'Support interface' }),
  Object.freeze({ id: 10, key: 'skirt_brim', displayName: 'Skirt / brim' }),
  Object.freeze({ id: 11, key: 'gap_fill', displayName: 'Gap fill' }),
  Object.freeze({ id: 12, key: 'wipe_tower', displayName: 'Wipe tower' }),
  Object.freeze({ id: 13, key: 'custom', displayName: 'Custom' })
]);

const FEATURE_BY_COMMENT = new Map([
  ['perimeter', 1],
  ['external perimeter', 2],
  ['overhang perimeter', 3],
  ['internal infill', 4],
  ['solid infill', 5],
  ['top solid infill', 6],
  ['bridge infill', 7],
  ['support material', 8],
  ['support', 8],
  ['support material interface', 9],
  ['support interface', 9],
  ['skirt/brim', 10],
  ['skirt / brim', 10],
  ['gap fill', 11],
  ['wipe tower', 12],
  ['custom', 13]
]);

const MOVE_EPSILON = 1e-7;
const COMMAND_PATTERN = /^\s*([GMT]\d+)\b/i;
const PARAMETER_PATTERN = /([A-Z])([-+]?(?:\d+(?:\.\d*)?|\.\d+))/gi;

const toolpathError = (message, code = 'slicer_toolpath_compilation_invalid') => new WorkerError(message, { code });

const finiteNumber = (value, label) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw toolpathError(`${label} is invalid.`);
  return numeric;
};

const vector = (value, label) => ({
  x: finiteNumber(value?.x, `${label} X`),
  y: finiteNumber(value?.y, `${label} Y`),
  z: finiteNumber(value?.z, `${label} Z`)
});

const emptyBounds = () => ({
  minimum: { x: Infinity, y: Infinity, z: Infinity },
  maximum: { x: -Infinity, y: -Infinity, z: -Infinity }
});

const includePoint = (bounds, point) => {
  for (const axis of ['x', 'y', 'z']) {
    bounds.minimum[axis] = Math.min(bounds.minimum[axis], point[axis]);
    bounds.maximum[axis] = Math.max(bounds.maximum[axis], point[axis]);
  }
};

const frozenBounds = bounds => {
  if (![...Object.values(bounds.minimum), ...Object.values(bounds.maximum)].every(Number.isFinite)) {
    throw toolpathError('Toolpath bounds are empty.');
  }
  return Object.freeze({
    minimum: Object.freeze({ ...bounds.minimum }),
    maximum: Object.freeze({ ...bounds.maximum })
  });
};

const createRange = () => ({ minimum: Infinity, maximum: -Infinity });
const includeRange = (range, value) => {
  if (!Number.isFinite(value)) return;
  range.minimum = Math.min(range.minimum, value);
  range.maximum = Math.max(range.maximum, value);
};
const freezeRange = range => Number.isFinite(range.minimum) && Number.isFinite(range.maximum)
  ? Object.freeze({ minimum: range.minimum, maximum: range.maximum })
  : Object.freeze({ minimum: 0, maximum: 0 });

const writeFully = async (handle, buffer) => {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (!bytesWritten) throw toolpathError('Toolpath artifact could not be written completely.');
    offset += bytesWritten;
  }
};

const inspectArtifact = async (filePath, maximumBytes) => {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
    throw toolpathError('Production toolpath artifact exceeds the qualified output limit.', 'slicer_toolpath_size_invalid');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return Object.freeze({
    checksumSha256: hash.digest('hex'),
    sizeBytes: stat.size,
    contentType: PRODUCTION_TOOLPATH_CONTENT_TYPE
  });
};

const parseParameters = source => {
  const values = new Map();
  for (const match of source.matchAll(PARAMETER_PATTERN)) values.set(match[1].toUpperCase(), Number(match[2]));
  return values;
};

const featureFromComment = value => FEATURE_BY_COMMENT.get(String(value || '').trim().toLowerCase()) ?? 0;

const firstPositiveConfigNumber = (value, label) => {
  const candidate = Array.isArray(value) ? value[0] : value;
  const numeric = Number(candidate);
  if (!Number.isFinite(numeric) || numeric <= 0) throw toolpathError(`${label} is required for toolpath evidence.`);
  return numeric;
};

const buildPrefix = headerBuffer => {
  const prefix = Buffer.alloc(PRODUCTION_TOOLPATH_PREFIX_BYTES);
  prefix.write(PRODUCTION_TOOLPATH_MAGIC, 0, 8, 'ascii');
  prefix.writeUInt32LE(PRODUCTION_TOOLPATH_VERSION, 8);
  prefix.writeUInt32LE(headerBuffer.length, 12);
  return prefix;
};

export const compileProductionToolpath = async ({
  gcodePath,
  workDir,
  run,
  effectiveConfiguration,
  gcodeArtifact,
  sliceEvidenceChecksumSha256,
  summary,
  warnings = [],
  maximumBytes
} = {}) => {
  if (
    !gcodePath
    || !workDir
    || !run?.id
    || !/^[0-9a-f]{64}$/.test(String(gcodeArtifact?.checksumSha256 || ''))
    || !/^[0-9a-f]{64}$/.test(String(sliceEvidenceChecksumSha256 || ''))
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes <= PRODUCTION_TOOLPATH_PREFIX_BYTES
  ) throw toolpathError('Production toolpath compiler inputs are incomplete.');

  const translation = vector(effectiveConfiguration?.coordinateMapping?.translationMm, 'Coordinate translation');
  if (effectiveConfiguration?.coordinateMapping?.projectOrigin !== 'center') {
    throw toolpathError('Production toolpaths require a center-origin project coordinate system.');
  }
  const filamentDiameterMm = firstPositiveConfigNumber(
    effectiveConfiguration?.prusaConfig?.filament_diameter,
    'Filament diameter'
  );
  const filamentAreaMm2 = Math.PI * Math.pow(filamentDiameterMm / 2, 2);
  const recordPath = path.join(workDir, 'production-toolpath-records.bin');
  const recordHandle = await fs.open(recordPath, 'wx', 0o600);
  const chunkBuffer = Buffer.allocUnsafe(PRODUCTION_TOOLPATH_CHUNK_RECORDS * PRODUCTION_TOOLPATH_RECORD_BYTES);
  const chunks = [];
  const layers = [];
  const bounds = emptyBounds();
  const speedRange = createRange();
  const flowRange = createRange();
  const layerTimeRange = createRange();
  const moveRecordCounts = Object.fromEntries(MOVE_KINDS.map(entry => [entry.key, 0]));
  const featureRecordCounts = Object.fromEntries(FEATURES.map(entry => [entry.key, 0]));
  const tools = new Set([0]);
  let recordCount = 0;
  let chunkRecordCount = 0;
  let chunkFirstRecord = 0;
  let chunkFirstLayer = 0;
  let chunkLastLayer = 0;
  let currentLayer = null;
  let currentFeature = 0;
  let currentWidthMm = null;
  let currentHeightMm = null;
  let coordinatesAbsolute = true;
  let extrusionAbsolute = true;
  let activeTool = 0;
  let lineNumber = 0;
  const position = { x: 0, y: 0, z: 0, e: 0, feedMmPerMinute: 0 };

  const flushChunk = async () => {
    if (!chunkRecordCount) return;
    const byteLength = chunkRecordCount * PRODUCTION_TOOLPATH_RECORD_BYTES;
    const payload = chunkBuffer.subarray(0, byteLength);
    await writeFully(recordHandle, payload);
    chunks.push(Object.freeze({
      firstRecord: chunkFirstRecord,
      recordCount: chunkRecordCount,
      firstLayer: chunkFirstLayer,
      lastLayer: chunkLastLayer,
      byteOffset: chunkFirstRecord * PRODUCTION_TOOLPATH_RECORD_BYTES,
      byteLength,
      checksumSha256: createHash('sha256').update(payload).digest('hex')
    }));
    chunkRecordCount = 0;
    chunkFirstRecord = recordCount;
  };

  const finalizeLayer = () => {
    if (!currentLayer || currentLayer.recordCount === 0) return;
    if (!Number.isFinite(currentLayer.zMm) || !Number.isFinite(currentLayer.heightMm) || currentLayer.heightMm <= 0) {
      throw toolpathError(`Layer ${currentLayer.index + 1} is missing PrusaSlicer Z or height evidence.`);
    }
    currentLayer.boundsMm = frozenBounds(currentLayer.boundsMm);
    currentLayer.timeSeconds = Number(currentLayer.timeSeconds.toFixed(6));
    includeRange(layerTimeRange, currentLayer.timeSeconds);
    layers.push(Object.freeze(currentLayer));
    currentLayer = null;
  };

  const appendRecord = async record => {
    if ((recordCount + 1) * PRODUCTION_TOOLPATH_RECORD_BYTES > maximumBytes) {
      throw toolpathError('Production toolpath records exceed the qualified output limit.', 'slicer_toolpath_size_invalid');
    }
    if (chunkRecordCount === 0) {
      chunkFirstRecord = recordCount;
      chunkFirstLayer = record.layerIndex;
    }
    chunkLastLayer = record.layerIndex;
    const offset = chunkRecordCount * PRODUCTION_TOOLPATH_RECORD_BYTES;
    const view = new DataView(chunkBuffer.buffer, chunkBuffer.byteOffset + offset, PRODUCTION_TOOLPATH_RECORD_BYTES);
    view.setFloat32(0, record.start.x, true);
    view.setFloat32(4, record.start.y, true);
    view.setFloat32(8, record.start.z, true);
    view.setFloat32(12, record.end.x, true);
    view.setFloat32(16, record.end.y, true);
    view.setFloat32(20, record.end.z, true);
    view.setFloat32(24, record.widthMm, true);
    view.setFloat32(28, record.heightMm, true);
    view.setFloat32(32, record.speedMmPerS, true);
    view.setFloat32(36, record.volumetricFlowMm3PerS, true);
    view.setFloat32(40, record.durationSeconds, true);
    view.setUint32(44, record.layerIndex, true);
    view.setUint32(48, record.sourceLine, true);
    view.setUint8(52, record.moveKind);
    view.setUint8(53, record.featureKind);
    view.setUint16(54, record.toolIndex, true);
    view.setUint32(56, record.flags, true);
    view.setUint32(60, 0, true);
    recordCount += 1;
    chunkRecordCount += 1;
    currentLayer.recordCount += 1;
    currentLayer.timeSeconds += record.durationSeconds;
    includePoint(currentLayer.boundsMm, record.start);
    includePoint(currentLayer.boundsMm, record.end);
    includePoint(bounds, record.start);
    includePoint(bounds, record.end);
    includeRange(speedRange, record.speedMmPerS);
    if (record.moveKind === 1) includeRange(flowRange, record.volumetricFlowMm3PerS);
    moveRecordCounts[MOVE_KINDS[record.moveKind].key] += 1;
    featureRecordCounts[FEATURES[record.featureKind]?.key || 'unknown'] += 1;
    tools.add(record.toolIndex);
    if (chunkRecordCount === PRODUCTION_TOOLPATH_CHUNK_RECORDS) await flushChunk();
  };

  try {
    const lines = createInterface({ input: createReadStream(gcodePath, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const rawLine of lines) {
      lineNumber += 1;
      if (lineNumber > 0xffffffff) throw toolpathError('G-code contains too many source lines.');
      let match = rawLine.match(/^;\s*LAYER_CHANGE\b/i);
      if (match) {
        finalizeLayer();
        currentLayer = {
          index: layers.length,
          zMm: null,
          heightMm: null,
          firstRecord: recordCount,
          recordCount: 0,
          timeSeconds: 0,
          boundsMm: emptyBounds()
        };
        continue;
      }
      match = rawLine.match(/^;\s*Z:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/i);
      if (match && currentLayer) {
        currentLayer.zMm = Number(match[1]) - translation.z;
        continue;
      }
      match = rawLine.match(/^;\s*HEIGHT:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/i);
      if (match && currentLayer) {
        currentLayer.heightMm = Number(match[1]);
        currentHeightMm = currentLayer.heightMm;
        continue;
      }
      match = rawLine.match(/^;\s*TYPE:\s*(.+?)\s*$/i);
      if (match) {
        currentFeature = featureFromComment(match[1]);
        continue;
      }
      match = rawLine.match(/^;\s*WIDTH:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+))/i);
      if (match) {
        currentWidthMm = Number(match[1]);
        continue;
      }

      const commandSource = rawLine.split(';', 1)[0];
      const commandMatch = commandSource.match(COMMAND_PATTERN);
      if (!commandMatch) continue;
      const command = commandMatch[1].toUpperCase();
      const parameters = parseParameters(commandSource.slice(commandMatch.index + commandMatch[0].length));
      if (command === 'G20') throw toolpathError('Inch-mode G-code is unsupported.', 'slicer_toolpath_command_unsupported');
      if (command === 'G21') continue;
      if (command === 'G90') { coordinatesAbsolute = true; continue; }
      if (command === 'G91') { coordinatesAbsolute = false; continue; }
      if (command === 'M82') { extrusionAbsolute = true; continue; }
      if (command === 'M83') { extrusionAbsolute = false; continue; }
      if (command.startsWith('T')) {
        activeTool = Number(command.slice(1));
        if (!Number.isInteger(activeTool) || activeTool < 0 || activeTool > 65535) {
          throw toolpathError('G-code tool index is unsupported.', 'slicer_toolpath_command_unsupported');
        }
        tools.add(activeTool);
        continue;
      }
      if (command === 'G92') {
        for (const axis of ['X', 'Y', 'Z']) {
          if (parameters.has(axis)) position[axis.toLowerCase()] = finiteNumber(parameters.get(axis), `G92 ${axis}`);
        }
        if (parameters.has('E')) position.e = finiteNumber(parameters.get('E'), 'G92 E');
        continue;
      }
      if ((command === 'G2' || command === 'G3') && currentLayer) {
        throw toolpathError('Arc moves require a future production toolpath dialect.', 'slicer_toolpath_command_unsupported');
      }
      if (command === 'G10' || command === 'G11') {
        if (!currentLayer) continue;
        const projectPoint = {
          x: position.x - translation.x,
          y: position.y - translation.y,
          z: position.z - translation.z
        };
        await appendRecord({
          start: projectPoint,
          end: projectPoint,
          widthMm: 0,
          heightMm: 0,
          speedMmPerS: 0,
          volumetricFlowMm3PerS: 0,
          durationSeconds: 0,
          layerIndex: currentLayer.index,
          sourceLine: lineNumber,
          moveKind: command === 'G10' ? 2 : 3,
          featureKind: currentFeature,
          toolIndex: activeTool,
          flags: 1
        });
        continue;
      }
      if (command !== 'G0' && command !== 'G1') {
        if (command.startsWith('G') && currentLayer && command !== 'G4') {
          throw toolpathError(
            `G-code command ${command} requires a reviewed production toolpath interpretation.`,
            'slicer_toolpath_command_unsupported'
          );
        }
        continue;
      }

      const next = { ...position };
      for (const axis of ['X', 'Y', 'Z']) {
        if (!parameters.has(axis)) continue;
        const key = axis.toLowerCase();
        next[key] = coordinatesAbsolute ? parameters.get(axis) : position[key] + parameters.get(axis);
      }
      if (parameters.has('E')) next.e = extrusionAbsolute ? parameters.get('E') : position.e + parameters.get('E');
      if (parameters.has('F')) next.feedMmPerMinute = parameters.get('F');
      const extrusionDelta = parameters.has('E') ? next.e - position.e : 0;
      const dx = next.x - position.x;
      const dy = next.y - position.y;
      const dz = next.z - position.z;
      const distanceMm = Math.hypot(dx, dy, dz);
      const hasMotion = distanceMm > MOVE_EPSILON;
      const hasExtrusion = extrusionDelta > MOVE_EPSILON;
      const hasRetraction = extrusionDelta < -MOVE_EPSILON;
      const start = {
        x: position.x - translation.x,
        y: position.y - translation.y,
        z: position.z - translation.z
      };
      const end = {
        x: next.x - translation.x,
        y: next.y - translation.y,
        z: next.z - translation.z
      };
      Object.assign(position, next);
      if (!currentLayer || (!hasMotion && !hasExtrusion && !hasRetraction)) continue;
      const speedMmPerS = next.feedMmPerMinute / 60;
      if (hasMotion && (!Number.isFinite(speedMmPerS) || speedMmPerS <= 0)) {
        throw toolpathError(`G-code line ${lineNumber} moves without a positive feed rate.`);
      }
      const durationSeconds = hasMotion ? distanceMm / speedMmPerS : 0;
      const moveKind = hasMotion ? (hasExtrusion ? 1 : 0) : (hasRetraction ? 2 : 3);
      const widthMm = moveKind === 1 ? Number(currentWidthMm) : 0;
      const heightMm = moveKind === 1 ? Number(currentHeightMm) : 0;
      if (moveKind === 1 && (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0)) {
        throw toolpathError(`Extrusion at G-code line ${lineNumber} lacks width or height evidence.`);
      }
      const volumetricFlowMm3PerS = moveKind === 1 && durationSeconds > 0
        ? (extrusionDelta * filamentAreaMm2) / durationSeconds
        : 0;
      await appendRecord({
        start,
        end,
        widthMm,
        heightMm,
        speedMmPerS: Number.isFinite(speedMmPerS) ? Math.max(0, speedMmPerS) : 0,
        volumetricFlowMm3PerS,
        durationSeconds,
        layerIndex: currentLayer.index,
        sourceLine: lineNumber,
        moveKind,
        featureKind: currentFeature,
        toolIndex: activeTool,
        flags: 0
      });
    }
    finalizeLayer();
    await flushChunk();
  } finally {
    await recordHandle.close();
  }

  if (!recordCount || !layers.length || Number(summary?.layerCount) !== layers.length) {
    throw toolpathError('Production toolpath layers do not reconcile with the G-code summary.');
  }
  const header = Object.freeze({
    schema: PRODUCTION_TOOLPATH_SCHEMA,
    version: PRODUCTION_TOOLPATH_VERSION,
    encoding: Object.freeze({ endianness: 'little', recordStrideBytes: PRODUCTION_TOOLPATH_RECORD_BYTES }),
    source: Object.freeze({
      runId: run.id,
      inputFingerprint: run.inputFingerprint,
      engineKey: run.engineKey,
      engineVersionId: run.engineVersionId,
      engineImageDigest: run.engineImageDigest,
      capabilityRevisionId: run.capabilityRevisionId,
      effectiveConfigurationChecksumSha256: run.effectiveConfigurationChecksumSha256,
      gcodeChecksumSha256: gcodeArtifact.checksumSha256,
      sliceEvidenceChecksumSha256
    }),
    coordinateSystem: Object.freeze({
      units: 'millimetres',
      handedness: 'right',
      plateOrigin: 'center',
      axes: 'x-right,y-back,z-up'
    }),
    recordCount,
    layerCount: layers.length,
    boundsMm: frozenBounds(bounds),
    layers: Object.freeze(layers),
    chunks: Object.freeze(chunks),
    catalogs: Object.freeze({
      moveKinds: MOVE_KINDS,
      features: FEATURES,
      tools: Object.freeze([...tools].sort((a, b) => a - b).map(id => Object.freeze({
        id,
        key: `tool_${id}`,
        displayName: `Tool ${id}`
      })))
    }),
    statistics: Object.freeze({
      ranges: Object.freeze({
        speedMmPerS: freezeRange(speedRange),
        volumetricFlowMm3PerS: freezeRange(flowRange),
        layerTimeSeconds: freezeRange(layerTimeRange)
      }),
      moveRecordCounts: Object.freeze(moveRecordCounts),
      featureRecordCounts: Object.freeze(featureRecordCounts)
    }),
    summary: Object.freeze({ ...summary }),
    warnings: Object.freeze([...warnings])
  });
  const headerBuffer = Buffer.from(JSON.stringify(header), 'utf8');
  if (headerBuffer.length > PRODUCTION_TOOLPATH_MAX_HEADER_BYTES) {
    throw toolpathError('Production toolpath header exceeds its format limit.', 'slicer_toolpath_size_invalid');
  }
  const prefix = buildPrefix(headerBuffer);
  const paddingBytes = (8 - ((prefix.length + headerBuffer.length) % 8)) % 8;
  const recordBytes = recordCount * PRODUCTION_TOOLPATH_RECORD_BYTES;
  const totalBytes = prefix.length + headerBuffer.length + paddingBytes + recordBytes;
  if (totalBytes > maximumBytes) {
    throw toolpathError('Production toolpath artifact exceeds the qualified output limit.', 'slicer_toolpath_size_invalid');
  }
  const targetPath = path.join(workDir, 'output.toolpath.amptp');
  const outputHandle = await fs.open(targetPath, 'wx', 0o600);
  try {
    await writeFully(outputHandle, prefix);
    await writeFully(outputHandle, headerBuffer);
    if (paddingBytes) await writeFully(outputHandle, Buffer.alloc(paddingBytes));
    for await (const chunk of createReadStream(recordPath)) await writeFully(outputHandle, chunk);
  } finally {
    await outputHandle.close();
    await fs.rm(recordPath, { force: true });
  }
  const artifact = await inspectArtifact(targetPath, maximumBytes);
  return Object.freeze({ path: targetPath, artifact, header });
};
