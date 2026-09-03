import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';

import { createEgressProxyServer, loadEgressProxyConfig } from '../src/egress-proxy.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));

const connectThroughProxy = ({ proxyPort, authority, payload = '' }) => new Promise((resolve, reject) => {
  const socket = connect(proxyPort, '127.0.0.1');
  const chunks = [];
  socket.setTimeout(2_000, () => socket.destroy(new Error('Proxy test timed out.')));
  socket.once('error', reject);
  socket.on('data', chunk => chunks.push(chunk));
  socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  socket.once('connect', () => {
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n${payload}`);
  });
});

test('requires a complete bounded egress proxy configuration', () => {
  const environment = {
    SLICER_EGRESS_PROXY_ALLOWED_HOST: 'api.am-pilot.com',
    SLICER_EGRESS_PROXY_ALLOWED_PORT: '443',
    SLICER_EGRESS_PROXY_LISTEN_HOST: '0.0.0.0',
    SLICER_EGRESS_PROXY_LISTEN_PORT: '3128',
    SLICER_EGRESS_PROXY_IDLE_TIMEOUT_MS: '900000',
    SLICER_EGRESS_PROXY_MAX_CONNECTIONS: '16'
  };
  const config = loadEgressProxyConfig(environment);
  assert.deepEqual(config, {
    allowedHost: 'api.am-pilot.com',
    allowedPort: 443,
    listenHost: '0.0.0.0',
    listenPort: 3128,
    idleTimeoutMs: 900_000,
    maximumConnections: 16
  });
  assert.throws(() => loadEgressProxyConfig({}), /SLICER_EGRESS_PROXY_ALLOWED_HOST is required/);
  assert.throws(() => loadEgressProxyConfig({
    ...environment,
    SLICER_EGRESS_PROXY_ALLOWED_HOST: '*.am-pilot.com'
  }), /one DNS hostname or IP address/);
});

test('permits only CONNECT to the exact configured authority', async () => {
  const target = createServer((_request, response) => response.end('target'));
  await listen(target);
  const targetAddress = target.address();
  assert.equal(typeof targetAddress, 'object');
  const events = [];
  const proxy = createEgressProxyServer({
    allowedHost: '127.0.0.1',
    allowedPort: targetAddress.port,
    listenHost: '127.0.0.1',
    listenPort: 0,
    idleTimeoutMs: 2_000,
    maximumConnections: 8
  }, { log: event => events.push(event) });
  await listen(proxy);
  const proxyAddress = proxy.address();
  assert.equal(typeof proxyAddress, 'object');

  try {
    const rejected = await connectThroughProxy({
      proxyPort: proxyAddress.port,
      authority: 'example.com:443'
    });
    assert.match(rejected, /^HTTP\/1\.1 403 Forbidden/);

    const tunneled = await connectThroughProxy({
      proxyPort: proxyAddress.port,
      authority: `127.0.0.1:${targetAddress.port}`,
      payload: 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'
    });
    assert.match(tunneled, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(tunneled, /target$/);
    assert.deepEqual(events.map(event => event.event), [
      'slicer_egress_proxy_rejected',
      'slicer_egress_proxy_connected'
    ]);
  } finally {
    await Promise.all([close(proxy), close(target)]);
  }
});
