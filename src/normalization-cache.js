import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { WorkerError } from './errors.js';

const HASH = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => new WorkerError(message, { code: 'slicer_normalization_cache_invalid' });

export const assertNormalizationCacheScope = scope => {
  if (!scope || scope.version !== 1 || !HASH.test(scope.tenantNamespaceSha256 || '')
    || Object.keys(scope).length !== 2) {
    throw invalid('Normalization reuse requires an API-issued tenant cache namespace.');
  }
  return scope;
};

// Each run must still download its authorized source. Recheck the local bytes
// before cache access so reuse cannot bypass the immutable source evidence.
export const verifyNormalizationCacheSource = async ({ sourcePath, model, maximumBytes, signal }) => {
  if (!['stl', '3mf'].includes(model?.sourceFormat) || !HASH.test(model?.checksumSha256 || '')
    || !Number.isSafeInteger(model?.sizeBytes) || model.sizeBytes <= 0
    || !Number.isSafeInteger(maximumBytes) || model.sizeBytes > maximumBytes) {
    throw invalid('Normalization reuse requires bounded immutable source evidence.');
  }
  signal?.throwIfAborted();
  const info = await fs.lstat(sourcePath);
  if (!info.isFile() || info.size !== model.sizeBytes) throw invalid('Cached source size does not match the run.');
  const checksum = createHash('sha256');
  let received = 0;
  for await (const chunk of createReadStream(sourcePath, { signal })) {
    received += chunk.length;
    if (received > model.sizeBytes) throw invalid('Cached source exceeds its immutable size.');
    checksum.update(chunk);
  }
  if (received !== model.sizeBytes || checksum.digest('hex') !== model.checksumSha256) {
    throw invalid('Cached source does not match the run checksum.');
  }
  return Object.freeze({ format: model.sourceFormat, checksumSha256: model.checksumSha256, sizeBytes: received });
};

export const assertNormalizationCacheEntry = entry => {
  if (!Buffer.isBuffer(entry?.bytes) || !entry.bytes.length || !HASH.test(entry.checksumSha256 || '')
    || hash(entry.bytes) !== entry.checksumSha256) throw invalid('Normalized cache data failed its checksum verification.');
};

// Process-local only: no source/G-code disk cache and no cross-tenant lookup.
// Owned copies prevent a caller or native job from changing another cache hit.
export const createNormalizationCache = ({ maximumBytes, maximumEntries, ttlMs, normalizerIdentity,
  now = () => performance.now() }) => {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0
    || !Number.isSafeInteger(maximumEntries) || maximumEntries < 1
    || !Number.isSafeInteger(ttlMs) || ttlMs < 1
    || typeof normalizerIdentity !== 'string' || !normalizerIdentity || normalizerIdentity.length > 2048) {
    throw invalid('Explicit bounded normalization cache configuration is required.');
  }
  const enabled = maximumBytes > 0;
  const entries = new Map();
  let bytes = 0, hits = 0, misses = 0, evictions = 0, closed = false;
  const remove = key => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    bytes -= entry.bytes.length;
    entry.bytes.fill(0);
  };
  const prune = () => {
    const time = now();
    for (const [key, entry] of entries) if (entry.expiresAt <= time) { remove(key); evictions++; }
  };
  const keyFor = ({ scope, source, paintChecksumSha256 = null }) => {
    assertNormalizationCacheScope(scope);
    if (!source || !['stl', '3mf'].includes(source.format) || !HASH.test(source.checksumSha256 || '')
      || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0
      || (paintChecksumSha256 !== null && !HASH.test(paintChecksumSha256))) {
      throw invalid('Normalization cache identity is incomplete.');
    }
    return hash(JSON.stringify([1, normalizerIdentity, scope.tenantNamespaceSha256,
      source.format, source.checksumSha256, source.sizeBytes, paintChecksumSha256]));
  };
  // Reuse expires exactly at ttlMs; bounded housekeeping also releases idle data.
  const timer = enabled ? setInterval(prune, Math.min(ttlMs, 60_000)) : null;
  timer?.unref();
  const assertOpen = () => { if (closed) throw invalid('The normalization cache has been closed.'); };
  return Object.freeze({
    enabled,
    get(identity) {
      assertOpen();
      if (!enabled) return null;
      prune();
      const key = keyFor(identity), entry = entries.get(key);
      if (!entry) { misses++; return null; }
      assertNormalizationCacheEntry(entry);
      entries.delete(key); entries.set(key, entry);
      hits++;
      return Buffer.from(entry.bytes);
    },
    put(identity, value) {
      assertOpen();
      if (!enabled) return false;
      const key = keyFor(identity);
      if (!Buffer.isBuffer(value) || !value.length) throw invalid('Normalized cache data must contain bytes.');
      if (value.length > maximumBytes) return false;
      prune(); remove(key);
      while (entries.size >= maximumEntries || bytes + value.length > maximumBytes) {
        remove(entries.keys().next().value); evictions++;
      }
      const owned = Buffer.from(value);
      entries.set(key, { bytes: owned, checksumSha256: hash(owned), expiresAt: now() + ttlMs });
      bytes += owned.length;
      return true;
    },
    stats() { prune(); return { hits, misses, evictions, entries: entries.size, bytes }; },
    dispose() {
      clearInterval(timer);
      for (const key of entries.keys()) remove(key);
      closed = true;
    }
  });
};
