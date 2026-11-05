import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadPlan, materializeRuntime, verifyBuildIdentity } from './materialize-runtime.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = plan => ({
  artifact: { id: plan.artifactId, name: plan.artifactName, expired: false, digest: 'sha256:' + plan.artifactZipSha256, workflow_run: { head_repository_id: plan.repositoryId, repository_id: plan.repositoryId, id: plan.buildRunId, head_sha: plan.nativeSourceRevision } },
  run: { id: plan.buildRunId, head_sha: plan.nativeSourceRevision, repository: { id: plan.repositoryId, full_name: plan.repository }, path: plan.workflowPath, event: 'workflow_dispatch', status: 'completed', conclusion: 'success' }
});

test('native artifact identity requires the successful pinned repository, workflow, source and bytes', async () => {
  const plan = await loadPlan(), good = identity(plan);
  assert.doesNotThrow(() => verifyBuildIdentity(plan, good.artifact, good.run));
  for (const change of [x => x.artifact.expired = true, x => x.artifact.digest = 'sha256:' + '0'.repeat(64), x => x.artifact.workflow_run.head_repository_id++, x => x.run.conclusion = 'failure', x => x.run.path = '.github/workflows/other.yml', x => x.run.head_sha = '0'.repeat(40)]) {
    const value = structuredClone(good); change(value);
    assert.throws(() => verifyBuildIdentity(plan, value.artifact, value.run));
  }
});

async function fixture(t, { failed = false, tamperLibrary = false, unsafe = false, symlink = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'native-package-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const plan = await loadPlan();
  const binary = Buffer.from('synthetic native bytes'), library = Buffer.from('synthetic dependency bytes');
  plan.binarySha256 = hash(binary); plan.libraries = { 'libsynthetic.so.1': hash(library) };
  const files = {
    'bin/candidate': binary.toString('base64'),
    'lib/libsynthetic.so.1': (tamperLibrary ? Buffer.from('substituted dependency') : library).toString('base64'),
    'build-status.json': Buffer.from(JSON.stringify({ status: failed ? 'failed' : 'complete', exitCode: failed ? 1 : 0, sourceRevision: plan.nativeSourceRevision, runId: plan.buildRunId, binaries: { 'bin/candidate': plan.binarySha256 } })).toString('base64'),
    'build-evidence.json': Buffer.from(JSON.stringify({ sourceRevision: plan.nativeSourceRevision, runId: plan.buildRunId, repository: plan.repository, files: { 'bin/candidate': plan.binarySha256, 'seam-visibility-reuse.patch': plan.patchSha256 } })).toString('base64'),
    'seam-visibility-reuse.patch': (await fs.readFile(new URL('seam-visibility-reuse.patch', import.meta.url))).toString('base64'),
    'prototype-plan.json': (await fs.readFile(new URL('prototype-plan.json', import.meta.url))).toString('base64'),
    'resources/not-shipped.txt': Buffer.from('not part of the runtime context').toString('base64')
  };
  if (unsafe) files['../escape'] = Buffer.from('escape').toString('base64');
  const tarPath = path.join(root, 'native.tar.gz');
  execFileSync('python3', ['-c', `import sys,json,tarfile,io,base64
with tarfile.open(sys.argv[1],'w:gz') as tar:
 for name,value in json.loads(sys.argv[2]).items():
  data=base64.b64decode(value);info=tarfile.TarInfo('./'+name);info.size=len(data);tar.addfile(info,io.BytesIO(data))
 if sys.argv[3]=='true':
  info=tarfile.TarInfo('./lib/link.so');info.type=tarfile.SYMTYPE;info.linkname='/etc/passwd';tar.addfile(info)
`, tarPath, JSON.stringify(files), String(symlink)]);
  plan.artifactTarSha256 = hash(await fs.readFile(tarPath));
  return { root, plan, tarPath, outputRoot: path.join(root, 'runtime') };
}

test('packaging ships only pinned native files and preserves executable permissions', async t => {
  const input = await fixture(t); await materializeRuntime(input);
  assert.equal(hash(await fs.readFile(path.join(input.outputRoot, 'bin/bambu-studio'))), input.plan.binarySha256);
  assert.equal((await fs.stat(path.join(input.outputRoot, 'AppRun'))).mode & 0o777, 0o755);
  await assert.rejects(fs.stat(path.join(input.outputRoot, 'resources')));
  assert.match(await fs.readFile(path.join(input.outputRoot, 'native-runtime.SHA256SUMS'), 'utf8'), /native-lib\/libsynthetic.so.1/);
});

test('a failed native build or changed dependency cannot materialize an image context', async t => {
  for (const options of [{ failed: true }, { tamperLibrary: true }]) {
    const input = await fixture(t, options); await assert.rejects(materializeRuntime(input));
    await assert.rejects(fs.stat(input.outputRoot));
  }
});

test('archive traversal and links are rejected even in unshipped entries', async t => {
  for (const options of [{ unsafe: true }, { symlink: true }]) {
    const input = await fixture(t, options); await assert.rejects(materializeRuntime(input));
    await assert.rejects(fs.stat(input.outputRoot));
  }
});

test('unverified bytes and existing runtime contexts fail closed', async t => {
  const input = await fixture(t), original = input.plan.artifactTarSha256;
  input.plan.artifactTarSha256 = '0'.repeat(64); await assert.rejects(materializeRuntime(input), /checksum/);
  input.plan.artifactTarSha256 = original; await fs.mkdir(input.outputRoot);
  await fs.writeFile(path.join(input.outputRoot, 'preserve'), 'existing');
  await assert.rejects(materializeRuntime(input), /EEXIST/);
  assert.equal(await fs.readFile(path.join(input.outputRoot, 'preserve'), 'utf8'), 'existing');
});
