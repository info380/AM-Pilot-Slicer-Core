import { isIP } from 'node:net';

import { fetch as undiciFetch, ProxyAgent } from 'undici';

import { WorkerError } from './errors.js';

const privateIpv4 = hostname => {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 127;
};

const privateProxyHost = hostname => {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return privateIpv4(normalized);
  if (ipVersion === 6) return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd');
  return normalized === 'localhost'
    || (!normalized.includes('.') && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(normalized));
};

export const normalizeEgressProxyUrl = value => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new WorkerError('SLICER_EGRESS_PROXY_URL must be an absolute HTTP or HTTPS URL.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WorkerError('SLICER_EGRESS_PROXY_URL must be a credential-free HTTP or HTTPS origin.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  if (url.pathname !== '/') {
    throw new WorkerError('SLICER_EGRESS_PROXY_URL must identify a proxy origin without a path.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  if (url.protocol === 'http:' && !privateProxyHost(url.hostname)) {
    throw new WorkerError('Plain HTTP egress proxies must use a private or container-local origin.', {
      code: 'slicer_worker_configuration_invalid'
    });
  }
  return url;
};

const requestUrl = input => {
  try {
    if (input instanceof URL) return input;
    if (typeof input === 'string') return new URL(input);
    return new URL(input?.url);
  } catch {
    throw new WorkerError('The worker attempted an invalid API request URL.', {
      code: 'slicer_worker_api_origin_invalid'
    });
  }
};

export const createApiTransport = (
  config,
  { fetchImpl = undiciFetch, proxyAgentFactory = options => new ProxyAgent(options) } = {}
) => {
  if (typeof fetchImpl !== 'function') throw new TypeError('A Fetch implementation is required.');
  const apiOrigin = new URL(config.apiBaseUrl).origin;
  const proxyUrl = config.egressProxyUrl ? new URL(config.egressProxyUrl) : null;
  if (config.egressProxyRequired && !proxyUrl) {
    throw new WorkerError('This worker deployment requires a controlled egress proxy.', {
      code: 'slicer_worker_egress_proxy_required'
    });
  }
  const dispatcher = proxyUrl ? proxyAgentFactory({
    uri: proxyUrl,
    proxyTunnel: true,
    connections: 1,
    pipelining: 1
  }) : null;
  const fetchApi = async (input, init = {}) => {
    const url = requestUrl(input);
    if (url.origin !== apiOrigin) {
      throw new WorkerError('The worker blocked a request outside the configured AM Pilot API origin.', {
        code: 'slicer_worker_api_origin_blocked'
      });
    }
    return await fetchImpl(url, {
      ...init,
      ...(dispatcher ? { dispatcher } : {})
    });
  };
  return Object.freeze({
    fetchApi,
    proxied: Boolean(dispatcher),
    close: async () => {
      if (typeof dispatcher?.close === 'function') await dispatcher.close();
    }
  });
};
