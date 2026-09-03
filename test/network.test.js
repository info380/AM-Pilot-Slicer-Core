import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';

import { createApiTransport, normalizeEgressProxyUrl } from '../src/network.js';

test('accepts only credential-free proxy origins and keeps plaintext proxy traffic private', () => {
  assert.equal(normalizeEgressProxyUrl(''), null);
  assert.equal(normalizeEgressProxyUrl('http://egress-proxy:3128').toString(), 'http://egress-proxy:3128/');
  assert.equal(normalizeEgressProxyUrl('http://10.0.0.2:3128').toString(), 'http://10.0.0.2:3128/');
  assert.equal(normalizeEgressProxyUrl('http://[fd00::2]:3128').toString(), 'http://[fd00::2]:3128/');
  assert.equal(normalizeEgressProxyUrl('https://proxy.example.com').toString(), 'https://proxy.example.com/');
  assert.throws(() => normalizeEgressProxyUrl('http://proxy.example.com:3128'), /private or container-local/);
  assert.throws(() => normalizeEgressProxyUrl('http://fcproxy.example.com:3128'), /private or container-local/);
  assert.throws(() => normalizeEgressProxyUrl('https://user:secret@proxy.example.com'), /credential-free/);
  assert.throws(() => normalizeEgressProxyUrl('https://proxy.example.com/path'), /without a path/);
});

test('routes only the configured API origin through the dedicated dispatcher', async () => {
  const calls = [];
  const dispatcher = { close: async () => calls.push({ closed: true }) };
  const transport = createApiTransport({
    apiBaseUrl: new URL('https://api.am-pilot.com'),
    egressProxyUrl: new URL('http://egress-proxy:3128'),
    egressProxyRequired: true
  }, {
    proxyAgentFactory: options => {
      calls.push({ options });
      return dispatcher;
    },
    fetchImpl: async (url, init) => {
      calls.push({ url: url.toString(), init });
      return { ok: true };
    }
  });

  assert.equal(transport.proxied, true);
  await transport.fetchApi('https://api.am-pilot.com/api/internal/slicer-worker/v1/health', {
    redirect: 'error'
  });
  assert.equal(calls[0].options.uri.toString(), 'http://egress-proxy:3128/');
  assert.equal(calls[0].options.proxyTunnel, true);
  assert.equal(calls[1].url, 'https://api.am-pilot.com/api/internal/slicer-worker/v1/health');
  assert.equal(calls[1].init.dispatcher, dispatcher);
  await assert.rejects(
    () => transport.fetchApi('https://example.com/exfiltrate'),
    error => error?.code === 'slicer_worker_api_origin_blocked'
  );
  await transport.close();
  assert.deepEqual(calls.at(-1), { closed: true });
});

test('fails closed when a deployment requires a proxy but none is configured', () => {
  assert.throws(() => createApiTransport({
    apiBaseUrl: new URL('https://api.am-pilot.com'),
    egressProxyUrl: null,
    egressProxyRequired: true
  }), error => error?.code === 'slicer_worker_egress_proxy_required');
});

test('uses the configured CONNECT proxy for an API request', async () => {
  const target = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('proxied');
  });
  const connectTargets = [];
  const proxy = createServer();
  proxy.on('connect', (request, clientSocket, head) => {
    connectTargets.push(request.url);
    const targetUrl = new URL(`http://${request.url}`);
    const targetSocket = connect(Number(targetUrl.port), targetUrl.hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });
    targetSocket.on('error', error => clientSocket.destroy(error));
  });
  await Promise.all([
    new Promise(resolve => target.listen(0, '127.0.0.1', resolve)),
    new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  ]);
  const targetAddress = target.address();
  const proxyAddress = proxy.address();
  assert.equal(typeof targetAddress, 'object');
  assert.equal(typeof proxyAddress, 'object');
  const apiBaseUrl = new URL(`http://127.0.0.1:${targetAddress.port}`);
  const transport = createApiTransport({
    apiBaseUrl,
    egressProxyUrl: new URL(`http://127.0.0.1:${proxyAddress.port}`),
    egressProxyRequired: true
  });

  try {
    const response = await transport.fetchApi(new URL('/health', apiBaseUrl));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'proxied');
    assert.deepEqual(connectTargets, [`127.0.0.1:${targetAddress.port}`]);
  } finally {
    await transport.close();
    await Promise.all([
      new Promise((resolve, reject) => target.close(error => error ? reject(error) : resolve())),
      new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    ]);
  }
});
