import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CAPABILITY_REVISION_ID, ENGINE_KEY, WORKER_PROTOCOL_VERSION } from '../src/constants.js';
import { SUPPORT_PAINT_CAPABILITY } from '../src/support-paint.js';
import { BAMBU_CAPABILITY_REVISION, BAMBU_ENGINE_KEY } from '../src/bambu-engine.js';

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
    assert.match(evidence.source.prusaNativeStatisticsPatchChecksumSha256,/^[a-f0-9]{64}$/);
    assert.equal(evidence.qualification.status, 'candidate');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Bambu release evidence binds the modified native binary, source and permanent build assets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bambu-release-evidence-test-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(directory, 'release-evidence'));
    const output = path.join(directory, 'release-evidence/release-evidence.json');
    const env = { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'info380/AM-Pilot-Slicer-Core', GITHUB_REF_NAME: 'bambu-v0.3.7', GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '123' };
    for (const [file, args] of [['write-release-evidence.js', ['sha256:' + 'a'.repeat(64), output]], ['write-bambu-release-evidence.js', []]]) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/' + file, import.meta.url)), ...args], { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const evidence = JSON.parse(await readFile(output, 'utf8'));
    const plan = JSON.parse(await readFile(new URL('../native/bambu/runtime-plan.json', import.meta.url), 'utf8'));
    assert.equal(evidence.engineKey, BAMBU_ENGINE_KEY);
    assert.equal(evidence.capabilityRevisionId, BAMBU_CAPABILITY_REVISION);
    assert.equal(evidence.source.nativeBuild.binaryChecksumSha256, plan.binarySha256);
    assert.equal(evidence.source.nativeBuild.patchChecksumSha256, plan.patchSha256);
    assert.deepEqual(evidence.source.runtimeRemovedPackages, ['apt', 'libapt-pkg6.0t64']);
    assert.deepEqual(evidence.source.nativeBuild.libraries, plan.libraries);
    assert(evidence.artifacts.nativeBuildArchive.endsWith('/Bambu-native-build-' + plan.nativeSourceRevision + '.tar.gz'));
    assert(evidence.artifacts.nativeBuilderSource.endsWith('/AM-Pilot-Native-Build-' + plan.nativeSourceRevision + '.tar.gz'));
    assert(evidence.artifacts.ffmpegSource.endsWith('/FFmpeg-n7.0.2.tar.gz'));
    assert.equal(evidence.qualification.status, 'candidate');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
