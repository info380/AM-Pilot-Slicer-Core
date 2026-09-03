import { createServer } from 'node:http';
import { isIP, connect as networkConnect } from 'node:net';
import { pathToFileURL } from 'node:url';

import { WorkerError } from './errors.js';

const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const required = (environment, key) => {
  const value = String(environment[key] || '').trim();
  if (!value) {
    throw new WorkerError(`${key} is required.`, { code: 'slicer_egress_proxy_configuration_invalid' });
  }
  return value;
};

const boundedInteger = (environment, key, minimum, maximum) => {
  const raw = required(environment, key);
  if (!/^\d+$/.test(raw)) {
    throw new WorkerError(`${key} must be an integer.`, { code: 'slicer_egress_proxy_configuration_invalid' });
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new WorkerError(`${key} must be between ${minimum} and ${maximum}.`, {
      code: 'slicer_egress_proxy_configuration_invalid'
    });
  }
  return value;
};

const normalizedHost = value => {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host || (!isIP(host) && !HOSTNAME_PATTERN.test(host))) {
    throw new WorkerError('SLICER_EGRESS_PROXY_ALLOWED_HOST must be one DNS hostname or IP address.', {
      code: 'slicer_egress_proxy_configuration_invalid'
    });
  }
  return host;
};

export const loadEgressProxyConfig = (environment = process.env) => Object.freeze({
  allowedHost: normalizedHost(required(environment, 'SLICER_EGRESS_PROXY_ALLOWED_HOST')),
  allowedPort: boundedInteger(environment, 'SLICER_EGRESS_PROXY_ALLOWED_PORT', 1, 65_535),
  listenHost: normalizedHost(required(environment, 'SLICER_EGRESS_PROXY_LISTEN_HOST')),
  listenPort: boundedInteger(environment, 'SLICER_EGRESS_PROXY_LISTEN_PORT', 1_024, 65_535),
  idleTimeoutMs: boundedInteger(environment, 'SLICER_EGRESS_PROXY_IDLE_TIMEOUT_MS', 5_000, 3_600_000),
  maximumConnections: boundedInteger(environment, 'SLICER_EGRESS_PROXY_MAX_CONNECTIONS', 1, 128)
});

const rejectTunnel = (socket, status, message) => {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }
};

const parseConnectAuthority = authority => {
  const match = /^([^:\s]+):(\d{1,5})$/.exec(String(authority || '').trim());
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  let host;
  try {
    host = normalizedHost(match[1]);
  } catch {
    return null;
  }
  return Object.freeze({ host, port });
};

export const createEgressProxyServer = (
  config,
  { connectImpl = networkConnect, log = event => process.stdout.write(`${JSON.stringify(event)}\n`) } = {}
) => {
  const server = createServer((_request, response) => {
    response.writeHead(405, { connection: 'close', 'content-length': '0' });
    response.end();
  });
  server.maxConnections = config.maximumConnections;
  server.on('clientError', (_error, socket) => rejectTunnel(socket, 400, 'Bad Request'));
  server.on('connect', (request, clientSocket, head) => {
    const authority = parseConnectAuthority(request.url);
    if (!authority || authority.host !== config.allowedHost || authority.port !== config.allowedPort) {
      log({ event: 'slicer_egress_proxy_rejected', authority: String(request.url || '').slice(0, 300) });
      rejectTunnel(clientSocket, 403, 'Forbidden');
      return;
    }

    const upstreamSocket = connectImpl({ host: config.allowedHost, port: config.allowedPort });
    let established = false;
    const closeBoth = error => {
      if (!clientSocket.destroyed) clientSocket.destroy(error);
      if (!upstreamSocket.destroyed) upstreamSocket.destroy(error);
    };
    clientSocket.setTimeout(config.idleTimeoutMs, closeBoth);
    upstreamSocket.setTimeout(config.idleTimeoutMs, closeBoth);
    clientSocket.once('error', closeBoth);
    upstreamSocket.once('error', error => {
      if (!established) rejectTunnel(clientSocket, 502, 'Bad Gateway');
      closeBoth(error);
    });
    upstreamSocket.once('connect', () => {
      established = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: AM-Pilot-Slicer-Core\r\n\r\n');
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
      log({ event: 'slicer_egress_proxy_connected', authority: `${authority.host}:${authority.port}` });
    });
  });
  return server;
};

const start = async () => {
  const config = loadEgressProxyConfig();
  const server = createEgressProxyServer(config);
  const stop = signal => {
    process.stdout.write(`${JSON.stringify({ event: 'slicer_egress_proxy_stopping', signal })}\n`);
    server.close(error => {
      if (error) {
        process.stderr.write(`${JSON.stringify({ event: 'slicer_egress_proxy_stop_failed', message: error.message })}\n`);
        process.exitCode = 1;
      }
    });
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.listenPort, config.listenHost, () => {
      server.off('error', reject);
      process.stdout.write(`${JSON.stringify({
        event: 'slicer_egress_proxy_ready',
        listenHost: config.listenHost,
        listenPort: config.listenPort,
        allowedAuthority: `${config.allowedHost}:${config.allowedPort}`,
        maximumConnections: config.maximumConnections
      })}\n`);
      resolve();
    });
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await start();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      event: 'slicer_egress_proxy_start_failed',
      code: error?.code || 'slicer_egress_proxy_start_failed',
      message: error?.message || String(error)
    })}\n`);
    process.exitCode = 1;
  }
}
