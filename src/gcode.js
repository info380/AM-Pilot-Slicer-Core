import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { GCODE_CONTENT_TYPE } from './constants.js';
import { WorkerError } from './errors.js';

const durationSeconds = value => {
  const text = String(value || '').trim().toLowerCase();
  let seconds = 0;
  let matched = false;
  for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/g)) {
    matched = true;
    const amount = Number(match[1]);
    if (match[2] === 'd') seconds += amount * 86_400;
    if (match[2] === 'h') seconds += amount * 3_600;
    if (match[2] === 'm') seconds += amount * 60;
    if (match[2] === 's') seconds += amount;
  }
  return matched && Number.isFinite(seconds) ? seconds : null;
};

export const inspectGcode = async (gcodePath, maximumBytes) => {
  const stat = await fs.stat(gcodePath);
  if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
    throw new WorkerError('PrusaSlicer G-code output exceeds the qualified output limit.', {
      code: 'slicer_gcode_size_invalid'
    });
  }
  const hash = createHash('sha256');
  let containsNul = false;
  for await (const chunk of createReadStream(gcodePath)) {
    hash.update(chunk);
    if (!containsNul && chunk.includes(0)) containsNul = true;
  }
  if (containsNul) {
    throw new WorkerError('PrusaSlicer output is not textual G-code.', { code: 'slicer_gcode_binary_invalid' });
  }

  const metrics = {};
  let layerCount = 0;
  const lines = createInterface({ input: createReadStream(gcodePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let match = line.match(/^;\s*estimated printing time(?: \(normal mode\))?\s*=\s*(.+)$/i);
    if (match) {
      const parsed = durationSeconds(match[1]);
      if (parsed !== null) metrics.estimatedTimeSeconds = parsed;
    }
    match = line.match(/^;\s*filament used \[mm\]\s*=\s*([0-9.]+)/i);
    if (match && Number.isFinite(Number(match[1]))) metrics.filamentLengthMm = Number(match[1]);
    match = line.match(/^;\s*filament used \[g\]\s*=\s*([0-9.]+)/i);
    if (match && Number.isFinite(Number(match[1]))) metrics.filamentMassG = Number(match[1]);
    if (/^;\s*LAYER_CHANGE\b/i.test(line)) layerCount += 1;
  }
  if (layerCount > 0) metrics.layerCount = layerCount;
  return Object.freeze({
    artifact: Object.freeze({
      checksumSha256: hash.digest('hex'),
      sizeBytes: stat.size,
      contentType: GCODE_CONTENT_TYPE
    }),
    metrics: Object.freeze(metrics)
  });
};

export const extractWarnings = ({ stdout = '', stderr = '' } = {}) => {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/)
    .map(line => line.replace(/[\t\r\n]+/g, ' ').trim())
    .filter(line => /\b(?:warn(?:ing)?|repair(?:ed)?|non-manifold)\b/i.test(line))
    .map(line => line.slice(0, 1_000));
  return [...new Set(lines)].slice(0, 200);
};
