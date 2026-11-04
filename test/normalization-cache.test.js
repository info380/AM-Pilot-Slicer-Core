import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { createNormalizationCache, assertNormalizationCacheEntry, verifyNormalizationCacheSource } from '../src/normalization-cache.js';
import { materializePlateInputs } from '../src/plate.js';

const scope = { version: 1, tenantNamespaceSha256: 'a'.repeat(64) };
const source = { format: 'stl', checksumSha256: 'b'.repeat(64), sizeBytes: 12 };
const identity = { scope, source };
const fixtureCache = (t, options = {}) => {
  const cache = createNormalizationCache({ maximumBytes: 1024, maximumEntries: 8, ttlMs: 60_000,
    normalizerIdentity: 'qualified-converter-release-a', ...options });
  t.after(() => cache.dispose());
  return cache;
};

test('reuse is tenant, immutable source, input format and paint specific', t => {
  const cache = fixtureCache(t);
  cache.put(identity, Buffer.from('normalized'));
  for (const candidate of [
    { ...identity, scope: { ...scope, tenantNamespaceSha256: 'c'.repeat(64) } },
    { ...identity, source: { ...source, checksumSha256: 'd'.repeat(64) } },
    { ...identity, source: { ...source, sizeBytes: 13 } },
    { ...identity, source: { ...source, format: '3mf' } },
    { ...identity, paintChecksumSha256: 'e'.repeat(64) }
  ]) assert.equal(cache.get(candidate), null);
  assert.equal(cache.get(identity).toString(), 'normalized');
  assert.throws(() => cache.get({ ...identity, scope: null }), { code: 'slicer_normalization_cache_invalid' });
  assert.throws(() => cache.get({ ...identity, scope: { version: 2, tenantNamespaceSha256: scope.tenantNamespaceSha256 } }),
    { code: 'slicer_normalization_cache_invalid' });
});

test('callers cannot mutate cached geometry and corrupt entries fail closed', t => {
  const cache = fixtureCache(t), bytes = Buffer.from('original');
  cache.put(identity, bytes);
  bytes.fill(0);
  const first = cache.get(identity); first.fill(0);
  assert.equal(cache.get(identity).toString(), 'original');
  const entry = { bytes: Buffer.from('abc'), checksumSha256: createHash('sha256').update('abc').digest('hex') };
  assert.doesNotThrow(() => assertNormalizationCacheEntry(entry));
  entry.bytes[0] = 0;
  assert.throws(() => assertNormalizationCacheEntry(entry), { code: 'slicer_normalization_cache_invalid' });
});

test('bytes, entry count, LRU order, expiry and shutdown bound retention', t => {
  let time = 0;
  const cache = fixtureCache(t, { maximumBytes: 6, maximumEntries: 2, ttlMs: 1000, now: () => time });
  const second = { ...identity, paintChecksumSha256: 'c'.repeat(64) };
  const third = { ...identity, paintChecksumSha256: 'd'.repeat(64) };
  cache.put(identity, Buffer.from('aaa')); cache.put(second, Buffer.from('bb'));
  cache.get(identity);
  cache.put(third, Buffer.from('ccc'));
  assert.equal(cache.get(second), null);
  assert.equal(cache.stats().bytes, 6);
  assert.equal(cache.put(second, Buffer.alloc(7)), false);
  assert.equal(cache.stats().entries, 2);
  time = 1000;
  assert.equal(cache.get(identity), null);
  assert.equal(cache.stats().bytes, 0);
  cache.put(identity, Buffer.from('a'));
  cache.dispose();
  assert.equal(cache.stats().entries, 0);
  assert.throws(() => cache.get(identity), { code: 'slicer_normalization_cache_invalid' });
});

test('disabled reuse does not require a namespace or retain data', t => {
  const cache = fixtureCache(t, { maximumBytes: 0 });
  assert.equal(cache.enabled, false);
  assert.equal(cache.get(null), null);
  assert.equal(cache.put(null, Buffer.from('bytes')), false);
  assert.equal(cache.stats().bytes, 0);
});

test('source evidence is checked before a cache lookup, including same-size corruption and links', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'normalization-source-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, 'source.stl');
  await fs.writeFile(sourcePath, 'source bytes');
  const model = { sourceFormat: 'stl', sizeBytes: 12, checksumSha256: createHash('sha256').update('source bytes').digest('hex') };
  const args = { sourcePath, model, maximumBytes: 1024 };
  assert.equal((await verifyNormalizationCacheSource(args)).checksumSha256, model.checksumSha256);
  await fs.writeFile(sourcePath, 'changed data');
  await assert.rejects(verifyNormalizationCacheSource(args), { code: 'slicer_normalization_cache_invalid' });
  await fs.symlink(sourcePath, path.join(directory, 'link.stl'));
  await assert.rejects(verifyNormalizationCacheSource({ ...args, sourcePath: path.join(directory, 'link.stl') }),
    { code: 'slicer_normalization_cache_invalid' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(verifyNormalizationCacheSource({ ...args, signal: controller.signal }), { name: 'AbortError' });
});

test('successive jobs reuse only normalization and rebuild placement, modifiers and byte admission', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'normalization-plate-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const xml = '<model unit="millimeter"><resources><object id="1"><mesh><vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="1"/></vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>';
  const normalized = zipSync({ '3D/3dmodel.model': strToU8(xml) });
  const sourcePath = path.join(directory, 'source.stl'), command = path.join(directory, 'normalize.mjs');
  const fixturePath = path.join(directory, 'normalized.3mf'), countPath = path.join(directory, 'calls.txt');
  await fs.writeFile(sourcePath, 'source bytes'); await fs.writeFile(fixturePath, normalized);
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await fs.writeFile(command, `#!/bin/sh\nprintf 'call\\n' >> ${quote(countPath)}\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = '--output' ]; then shift; cp ${quote(fixturePath)} "$1"; exit; fi\n  shift\ndone\nexit 2\n`, { mode: 0o700 });
  const config = { prusaSlicerCommand: command, jobTimeoutMs: 5000, maximumLogBytes: 4096,
    maximumModelBytes: 1024, maximumNormalizedModelBytes: 8192, maximumTotalNormalizedBytes: 8192, maximumPlateInputBytes: 16384 };
  const cache = fixtureCache(t, { maximumBytes: 8192 });
  const inputSnapshot = { schema: 'am-pilot-slicer-input-snapshot', version: 1,
    models: [{ modelId: 'source', projectFileId: 'file', sourceFormat: 'stl', sizeBytes: 12,
      checksumSha256: createHash('sha256').update('source bytes').digest('hex') }],
    plate: { geometry: { heightMm: 256 }, objects: [{ id: 'object', name: 'Part', fileId: 'file', definitionId: 'linked', placement: { status: 'placed' },
      printOverrides: {}, transform: { positionMm: { x: 0, y: 0, z: 0 }, rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }] } };
  const effectiveConfiguration = { engineAdapter: 'fdm.am_pilot_bambu_core', bambuConfig: { machine: {} },
    coordinateMapping: { projectOrigin: 'center', engineBedOrigin: 'front_left', translationMm: { x: 128, y: 128, z: 0 } } };
  const prepare = async (name, extra = {}) => {
    const workDir = path.join(directory, name); await fs.mkdir(workDir);
    const files = await materializePlateInputs({ inputSnapshot, effectiveConfiguration,
      downloadedModels: new Map([['source', sourcePath]]), config, normalizationCache: cache, sourceCacheScope: scope, workDir, ...extra });
    return fs.readFile(files[0]);
  };
  const first = await prepare('first'), second = await prepare('second');
  assert.deepEqual(second, first);
  inputSnapshot.plate.objects[0].transform.positionMm.x = 7;
  const moved = await prepare('moved');
  assert.notDeepEqual(moved, first);
  inputSnapshot.plate.objects[0].modifiers = [{ id: 'local', name: 'Density', shape: 'box',
    sizeMm: { x: 1, y: 1, z: 1 }, transform: { positionMm: { x: 0, y: 0, z: 0.5 },
      rotationDeg: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, printOverrides: { fill_density: 30 } }];
  const modified = await prepare('modified');
  assert.notDeepEqual(modified, moved);
  assert.equal((await fs.readFile(countPath, 'utf8')).trim().split('\n').length, 1);
  await assert.rejects(prepare('small-budget', { config: { ...config, maximumTotalNormalizedBytes: normalized.length - 1 } }),
    { code: 'slicer_normalized_model_size_exceeded' });
  await prepare('other-tenant', { sourceCacheScope: { ...scope, tenantNamespaceSha256: 'f'.repeat(64) } });
  assert.equal((await fs.readFile(countPath, 'utf8')).trim().split('\n').length, 2);
});
