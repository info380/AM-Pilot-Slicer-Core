import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CAPABILITY_REVISION_ID, ENGINE_KEY, WORKER_PROTOCOL_VERSION } from '../src/constants.js';
import { SUPPORT_PAINT_CAPABILITY } from '../src/support-paint.js';

test('generated release evidence matches the worker support-paint capability before image build', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'slicer-release-evidence-test-'));
  try {
    const output = path.join(directory, 'release-evidence.json');
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const digest = `sha256:${'a'.repeat(64)}`;
    const revision = 'b'.repeat(40);
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/write-release-evidence.js', import.meta.url)), digest, output
    ], {
      encoding: 'utf8',
      env: {
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'info380/AM-Pilot-Slicer-Core',
        GITHUB_REF_NAME: `v${manifest.version}`,
        GITHUB_SHA: revision,
        GITHUB_RUN_ID: '123'
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(evidence.capabilityRevisionId, CAPABILITY_REVISION_ID);
    assert.equal(evidence.capabilityRevisionId, SUPPORT_PAINT_CAPABILITY);
    assert.equal(evidence.engineKey, ENGINE_KEY);
    assert.equal(evidence.workerProtocolVersion, WORKER_PROTOCOL_VERSION);
    assert.equal(evidence.semanticVersion, `v${manifest.version}`);
    assert.equal(evidence.imageDigest, digest);
    assert.equal(evidence.source.revision, revision);
    assert.equal(evidence.qualification.status, 'candidate');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
