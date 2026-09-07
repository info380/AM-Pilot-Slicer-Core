import { readFileSync } from 'node:fs';
import { WorkerError } from './errors.js';

const scopes = JSON.parse(readFileSync(new URL('../schemas/prusa-object-settings-2.9.3.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL('../schemas/prusa-print-settings-2.9.3.json', import.meta.url)));
const fields = new Map(catalog.fields.filter(field => Object.hasOwn(scopes.scope, field.key)).map(field => [field.key, field]));
const invalid = key => new WorkerError('Invalid object print setting: ' + key, { code: 'slicer_object_override_invalid' });

// Only native object/region settings may enter 3MF metadata. Never copy source
// profile metadata or permit machine, filament, scripts or output settings.
export const compileObjectOverrides = overrides => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw invalid('map');
  return Object.fromEntries(Object.entries(overrides).map(([key, value]) => {
    const field = fields.get(key);
    if (!field || typeof value === 'object' || typeof value === 'undefined') throw invalid(key);
    if (field.type === 'coBool') {
      if (typeof value !== 'boolean') throw invalid(key);
    } else if (field.type === 'coEnum') {
      if (!field.options.some(option => option.value === value)) throw invalid(key);
    } else {
      const percent = typeof value === 'string' && /^-?(?:\d+\.?\d*|\.\d+)%$/.test(value);
      if (typeof value !== 'number' && !(field.type === 'coFloatOrPercent' && percent)) throw invalid(key);
      const number = percent ? Number(value.slice(0, -1)) : value;
      if (!Number.isFinite(number) || (field.type === 'coInt' && !Number.isInteger(number))
        || (field.min != null && number < field.min) || (field.max != null && number > field.max)) throw invalid(key);
    }
    return [key, field.type === 'coPercent' ? value + '%' : value];
  }));
};
