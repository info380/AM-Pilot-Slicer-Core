import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { WorkerError } from './errors.js';

// Build-time/offline loader. Resolves upstream inheritance without evaluating
// preset content or fetching anything from the network. The caller pins resources.
export const resolveBambuPreset = async ({ resourceRoot, kind, name }) => {
  if (!['machine', 'process', 'filament'].includes(kind) || !path.isAbsolute(resourceRoot)) {
    throw new WorkerError('Invalid Bambu preset source.', { code: 'slicer_bambu_preset_invalid' });
  }
  const files = new Map();
  const visit = async (presetName, chain = []) => {
    if (typeof presetName !== 'string' || !presetName || presetName.length > 200 || /[\\/\x00-\x1f]/.test(presetName)
      || chain.includes(presetName) || chain.length >= 32) throw new WorkerError('Invalid Bambu preset inheritance.', { code: 'slicer_bambu_preset_invalid' });
    const relative = `${kind}/${presetName}.json`;
    const filename = path.join(resourceRoot, relative);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new WorkerError('Bambu preset source exceeds limits.', { code: 'slicer_bambu_preset_invalid' });
    const raw = await fs.readFile(filename);
    files.set(relative, { path: relative, checksumSha256: createHash('sha256').update(raw).digest('hex') });
    if (files.size > 64) throw new WorkerError('Too many Bambu preset dependencies.', { code: 'slicer_bambu_preset_invalid' });
    const preset = JSON.parse(raw);
    if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new WorkerError('Bambu preset must be an object.', { code: 'slicer_bambu_preset_invalid' });
    if (preset.include != null && (!Array.isArray(preset.include) || preset.include.length > 32)) throw new WorkerError('Invalid Bambu preset includes.', { code: 'slicer_bambu_preset_invalid' });
    const result = preset.inherits ? await visit(preset.inherits, [...chain, presetName]) : {};
    for (const include of preset.include || []) Object.assign(result, await visit(include, [...chain, presetName]));
    Object.assign(result, preset);
    delete result.inherits;
    delete result.include;
    return result;
  };
  const settings = await visit(name);
  return { settings, sources: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
};
