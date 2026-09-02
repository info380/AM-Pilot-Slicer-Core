import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';

import { GCODE_CONTENT_TYPE, MANIFEST_CONTENT_TYPE } from './constants.js';
import { WorkerError } from './errors.js';

const JSON_CONTENT_TYPE = 'application/json';

const encodePath = value => encodeURIComponent(String(value));

const combineSignal = (signal, timeoutMs) => {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
};

const apiError = async response => {
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const code = String(payload?.code || '').trim() || `slicer_worker_api_${response.status}`;
  const message = String(payload?.error || '').trim() || `AM Pilot API returned HTTP ${response.status}.`;
  return new WorkerError(message, {
    code,
    retryable: response.status >= 500 || response.status === 429
  });
};

const safeFilename = (value, fallback) => {
  const result = String(value || '').replace(/[\r\n"\\/\u0000-\u001f]/g, '-').trim().slice(0, 180);
  return result || fallback;
};

async function* multipartBody({ boundary, gcodePath, manifestPath, gcodeFilename }) {
  const files = [
    { field: 'gcode', path: gcodePath, filename: gcodeFilename, contentType: GCODE_CONTENT_TYPE },
    { field: 'manifest', path: manifestPath, filename: 'manifest.json', contentType: MANIFEST_CONTENT_TYPE }
  ];
  for (const file of files) {
    yield Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`
    );
    for await (const chunk of createReadStream(file.path)) yield chunk;
    yield Buffer.from('\r\n');
  }
  yield Buffer.from(`--${boundary}--\r\n`);
}

const multipartLength = async ({ boundary, gcodePath, manifestPath, gcodeFilename }) => {
  const files = [
    { field: 'gcode', path: gcodePath, filename: gcodeFilename, contentType: GCODE_CONTENT_TYPE },
    { field: 'manifest', path: manifestPath, filename: 'manifest.json', contentType: MANIFEST_CONTENT_TYPE }
  ];
  let length = Buffer.byteLength(`--${boundary}--\r\n`);
  for (const file of files) {
    const stat = await fs.stat(file.path);
    length += Buffer.byteLength(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`
    ) + stat.size + 2;
  }
  return length;
};

export class SlicerWorkerApiClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch implementation is required.');
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.protocolBase = new URL('/api/internal/slicer-worker/v1', config.apiBaseUrl);
  }

  headers({ leaseToken = null, includeEngine = false, contentType = null } = {}) {
    return {
      Authorization: `Bearer ${this.config.controlToken}`,
      'X-AM-Pilot-Slicer-Worker-ID': this.config.workerId,
      ...(includeEngine ? {
        'X-AM-Pilot-Slicer-Engine-Key': this.config.engineKey,
        'X-AM-Pilot-Slicer-Image-Digest': this.config.imageDigest,
        'X-AM-Pilot-Slicer-Protocol-Version': String(this.config.protocolVersion)
      } : {}),
      ...(leaseToken ? { 'X-AM-Pilot-Slicer-Lease-Token': leaseToken } : {}),
      ...(contentType ? { 'Content-Type': contentType } : {})
    };
  }

  url(relativePath) {
    const base = this.protocolBase.toString().replace(/\/$/, '');
    return new URL(`${base}/${String(relativePath).replace(/^\//, '')}`);
  }

  async requestJson(relativePath, {
    method = 'GET',
    headers = {},
    body = null,
    signal = null,
    timeoutMs = this.config.requestTimeoutMs
  } = {}) {
    let response;
    try {
      response = await this.fetchImpl(this.url(relativePath), {
        method,
        headers,
        body,
        signal: combineSignal(signal, timeoutMs),
        redirect: 'error',
        cache: 'no-store'
      });
    } catch (error) {
      throw new WorkerError('AM Pilot API request failed.', {
        code: 'slicer_worker_api_unreachable',
        retryable: true,
        cause: error
      });
    }
    if (!response.ok) throw await apiError(response);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch (error) {
      throw new WorkerError('AM Pilot API returned invalid JSON.', {
        code: 'slicer_worker_api_response_invalid',
        cause: error
      });
    }
  }

  async health() {
    return await this.requestJson('health', { headers: this.headers() });
  }

  async claim({ signal = null } = {}) {
    return await this.requestJson('runs/claim', {
      method: 'POST',
      headers: this.headers({ includeEngine: true }),
      signal
    });
  }

  async progress({ runId, leaseToken, stage, progressPercent, message, markRunning = true, signal = null }) {
    return await this.requestJson(`runs/${encodePath(runId)}/progress`, {
      method: 'POST',
      headers: this.headers({ leaseToken, contentType: JSON_CONTENT_TYPE }),
      body: JSON.stringify({ stage, progressPercent, message, markRunning }),
      signal
    });
  }

  async fail({ runId, leaseToken, failureCode, failureMessage, signal = null }) {
    return await this.requestJson(`runs/${encodePath(runId)}/fail`, {
      method: 'POST',
      headers: this.headers({ leaseToken, contentType: JSON_CONTENT_TYPE }),
      body: JSON.stringify({ failureCode, failureMessage }),
      signal
    });
  }

  async downloadModel({ runId, leaseToken, model, targetPath, signal = null }) {
    const expectedSize = Number(model?.sizeBytes);
    const expectedChecksum = String(model?.checksumSha256 || '').toLowerCase();
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0 || expectedSize > this.config.maximumModelBytes) {
      throw new WorkerError('A source model exceeds the qualified worker input limit.', {
        code: 'slicer_source_model_size_invalid'
      });
    }
    if (!/^[0-9a-f]{64}$/.test(expectedChecksum)) {
      throw new WorkerError('A source model checksum is invalid.', { code: 'slicer_source_model_checksum_invalid' });
    }
    let response;
    try {
      response = await this.fetchImpl(this.url(
        `runs/${encodePath(runId)}/models/${encodePath(model.modelId)}`
      ), {
        headers: this.headers({ leaseToken }),
        signal: combineSignal(signal, this.config.jobTimeoutMs),
        redirect: 'error',
        cache: 'no-store'
      });
    } catch (error) {
      throw new WorkerError('Source model download failed.', {
        code: 'slicer_source_model_download_failed',
        retryable: true,
        cause: error
      });
    }
    if (!response.ok) throw await apiError(response);
    const responseChecksum = String(response.headers.get('x-content-sha256') || '').toLowerCase();
    const responseLength = Number(response.headers.get('content-length'));
    if (responseChecksum !== expectedChecksum || responseLength !== expectedSize || !response.body) {
      throw new WorkerError('Source model response evidence does not match the immutable run snapshot.', {
        code: 'slicer_source_model_integrity_mismatch'
      });
    }
    const handle = await fs.open(targetPath, 'wx', 0o600);
    const hash = createHash('sha256');
    let received = 0;
    try {
      for await (const rawChunk of response.body) {
        const chunk = Buffer.from(rawChunk);
        received += chunk.length;
        if (received > expectedSize || received > this.config.maximumModelBytes) {
          throw new WorkerError('Source model download exceeded its immutable size.', {
            code: 'slicer_source_model_size_mismatch'
          });
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close().catch(() => {});
      await fs.rm(targetPath, { force: true });
      if (error instanceof WorkerError) throw error;
      throw new WorkerError('Source model stream was interrupted.', {
        code: 'slicer_source_model_download_failed',
        retryable: true,
        cause: error
      });
    } finally {
      await handle.close().catch(() => {});
    }
    if (received !== expectedSize || hash.digest('hex') !== expectedChecksum) {
      await fs.rm(targetPath, { force: true });
      throw new WorkerError('Downloaded source model failed its checksum or size verification.', {
        code: 'slicer_source_model_integrity_mismatch'
      });
    }
    return targetPath;
  }

  async complete({ run, leaseToken, gcodePath, manifestPath, signal = null }) {
    const boundary = `am-pilot-slicer-${crypto.randomUUID()}`;
    const gcodeFilename = safeFilename(run.plateName || run.plateId, 'slice') + '.gcode';
    const length = await multipartLength({ boundary, gcodePath, manifestPath, gcodeFilename });
    let response;
    try {
      response = await this.fetchImpl(this.url(`runs/${encodePath(run.id)}/complete`), {
        method: 'POST',
        headers: {
          ...this.headers({ leaseToken }),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(length)
        },
        body: Readable.toWeb(Readable.from(multipartBody({ boundary, gcodePath, manifestPath, gcodeFilename }))),
        duplex: 'half',
        signal: combineSignal(signal, this.config.jobTimeoutMs),
        redirect: 'error',
        cache: 'no-store'
      });
    } catch (error) {
      throw new WorkerError('Slicer result upload failed.', {
        code: 'slicer_worker_completion_unreachable',
        retryable: true,
        cause: error
      });
    }
    if (!response.ok) throw await apiError(response);
    try {
      return await response.json();
    } catch (error) {
      throw new WorkerError('AM Pilot API returned an invalid completion response.', {
        code: 'slicer_worker_api_response_invalid',
        cause: error
      });
    }
  }
}
