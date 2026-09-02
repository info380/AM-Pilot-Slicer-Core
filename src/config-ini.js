import { WorkerError } from './errors.js';

const FORBIDDEN_KEYS = new Set([
  'post_process',
  'output_filename_format',
  'notes',
  'compatible_printers_condition',
  'compatible_prints_condition'
]);

const encodeValue = value => {
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (Array.isArray(value)) return value.map(encodeValue).join(',');
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    throw new WorkerError('PrusaSlicer configuration values must be scalar or arrays.', {
      code: 'slicer_effective_configuration_invalid'
    });
  }
  return String(value).replace(/\r\n?/g, '\n').replace(/\n/g, '\\n');
};

export const serializePrusaConfig = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WorkerError('The effective PrusaSlicer configuration is invalid.', {
      code: 'slicer_effective_configuration_invalid'
    });
  }
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (!entries.length) {
    throw new WorkerError('The effective PrusaSlicer configuration is empty.', {
      code: 'slicer_effective_configuration_invalid'
    });
  }
  for (const [key, setting] of entries) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || FORBIDDEN_KEYS.has(key)) {
      throw new WorkerError(`PrusaSlicer configuration key ${key} is not permitted.`, {
        code: 'slicer_effective_configuration_invalid'
      });
    }
    if (key === 'post_process' && String(setting || '').trim()) {
      throw new WorkerError('PrusaSlicer post-processing scripts are disabled.', {
        code: 'slicer_post_processing_forbidden'
      });
    }
  }
  return `${entries.map(([key, setting]) => `${key} = ${encodeValue(setting)}`).join('\n')}\n`;
};
