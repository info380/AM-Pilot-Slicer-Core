import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SlicerWorkerApiClient } from '../src/api-client.js';
import { loadWorkerConfig } from '../src/config.js';

const token = 'worker-control-token'.padEnd(48, 'x');

const clientConfig = () => loadWorkerConfig({
  AM_PILOT_API_BASE_URL: 'http://127.0.0.1:4321',
  SLICER_WORKER_CONTROL_TOKEN: token,
  SLICER_WORKER_ID: 'worker-test-01',
  SLICER_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
  PRUSA_SLICER_CMD: process.execPath
}, { allowInsecureLoopback: true });

test('claims only with the pinned engine identity headers', async () => {
  const fetchImpl = async (url, options) => {
    assert.equal(url.pathname, '/api/internal/slicer-worker/v1/runs/claim');
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.headers['X-AM-Pilot-Slicer-Worker-ID'], 'worker-test-01');
    assert.equal(options.headers['X-AM-Pilot-Slicer-Engine-Key'], 'fdm.am_pilot_prusa_core');
    assert.equal(options.headers['X-AM-Pilot-Slicer-Image-Digest'], `sha256:${'a'.repeat(64)}`);
    return new Response(null, { status: 204 });
  };
  const client = new SlicerWorkerApiClient(clientConfig(), { fetchImpl });
  assert.equal(await client.claim(), null);
});

test('streams a model only when API evidence matches the run snapshot', async t => {
  const payload = Buffer.from('solid fixture\nendsolid fixture\n');
  const checksumSha256 = createHash('sha256').update(payload).digest('hex');
  const fetchImpl = async () => new Response(payload, { headers: {
    'content-type': 'application/sla',
    'content-length': String(payload.length),
    'x-content-sha256': checksumSha256
  } });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-api-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const targetPath = path.join(temp, 'fixture.stl');
  const client = new SlicerWorkerApiClient(clientConfig(), { fetchImpl });
  await client.downloadModel({
    runId: 'run-01',
    leaseToken: 'lease-token',
    model: { modelId: 'model-01', sizeBytes: payload.length, checksumSha256 },
    targetPath
  });
  assert.deepEqual(await fs.readFile(targetPath), payload);
});

test('streams exactly the G-code, manifest, and production-toolpath completion fields', async t => {
  let received = null;
  const fetchImpl = async (_url, options) => {
    const chunks = [];
    for await (const chunk of options.body) chunks.push(Buffer.from(chunk));
    received = Buffer.concat(chunks).toString('utf8');
    assert.equal(Number(options.headers['Content-Length']), Buffer.byteLength(received));
    return Response.json({ ok: true });
  };
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-complete-test-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const gcodePath = path.join(temp, 'output.gcode');
  const manifestPath = path.join(temp, 'manifest.json');
  const toolpathPreviewPath = path.join(temp, 'output.toolpath.amptp');
  await fs.writeFile(gcodePath, 'G28\n');
  await fs.writeFile(manifestPath, '{"version":1}\n');
  await fs.writeFile(toolpathPreviewPath, 'AMPTP001');
  const client = new SlicerWorkerApiClient(clientConfig(), { fetchImpl });
  assert.deepEqual(await client.complete({
    run: { id: 'run-01', plateName: 'Plate 1' },
    leaseToken: 'lease-token',
    gcodePath,
    manifestPath,
    toolpathPreviewPath
  }), { ok: true });
  assert.match(received, /name="gcode"; filename="Plate 1\.gcode"/);
  assert.match(received, /name="manifest"; filename="manifest\.json"/);
  assert.match(received, /name="toolpathPreview"; filename="toolpath\.amptp"/);
  assert.match(received, /Content-Type: application\/vnd\.am-pilot\.production-toolpath/);
  assert.doesNotMatch(received, /tenantId/);
});
