import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
export const loadPlan = async () => JSON.parse(await fs.readFile(path.join(here, 'runtime-plan.json'), 'utf8'));

export function verifyBuildIdentity(plan, artifact, run) {
  assert.equal(artifact.id, plan.artifactId);
  assert.equal(artifact.name, plan.artifactName);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.digest, 'sha256:' + plan.artifactZipSha256);
  for (const key of ['head_repository_id', 'repository_id']) assert.equal(artifact.workflow_run[key], plan.repositoryId);
  assert.equal(artifact.workflow_run.id, plan.buildRunId);
  assert.equal(artifact.workflow_run.head_sha, plan.nativeSourceRevision);
  assert.equal(run.id, plan.buildRunId);
  assert.equal(run.head_sha, plan.nativeSourceRevision);
  assert.equal(run.repository.id, plan.repositoryId);
  assert.equal(run.repository.full_name, plan.repository);
  assert.equal(run.path, plan.workflowPath);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
}

// Extract only named regular files. Never use archive-controlled destination
// paths, symlinks, ownership, modes or executable actions while packaging.
const extract = String.raw`
import sys,json,tarfile,pathlib,shutil
archive,destination,mapping=sys.argv[1],pathlib.Path(sys.argv[2]),json.loads(sys.argv[3])
with tarfile.open(archive,'r:gz') as tar:
    selected={}; total=0
    for member in tar:
        name=member.name.removeprefix('./'); parts=pathlib.PurePosixPath(name)
        assert not parts.is_absolute() and '..' not in parts.parts, 'Unsafe native archive path'
        assert not (member.issym() or member.islnk() or member.isdev()), 'Native archive links/devices are forbidden'
        total+=member.size
        assert total<=2*1024**3, 'Native archive expanded size exceeded'
        if name in mapping:
            assert name not in selected and member.isfile(), 'Duplicate or non-regular native member'
            assert member.size<=200*1024**2, 'Native member size exceeded'
            target=destination/mapping[name];target.parent.mkdir(parents=True,exist_ok=True)
            with tar.extractfile(member) as source,target.open('xb') as output:
                shutil.copyfileobj(source,output)
            selected[name]=True
    assert set(selected)==set(mapping), 'Missing native build member'
`;

export async function materializeRuntime({ tarPath, outputRoot, plan }) {
  plan ??= await loadPlan();
  const archive = await fs.readFile(tarPath);
  assert.equal(hash(archive), plan.artifactTarSha256, 'Native tar checksum mismatch');
  for (const [file, checksum] of Object.entries({
    'seam-visibility-reuse.patch': plan.patchSha256, 'build-prototype.sh': plan.builderSha256,
    'prototype-plan.json': plan.buildPlanSha256, 'SeamVisibilityReuse.hpp': plan.headerSha256
  })) assert.equal(hash(await fs.readFile(path.join(here, file))), checksum, 'Native build source changed: ' + file);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-runtime-package-'));
  const mapping = { 'bin/candidate': 'bin/bambu-studio', 'build-status.json': 'native-build-status.json', 'build-evidence.json': 'native-build-evidence.json', 'seam-visibility-reuse.patch': 'seam-visibility-reuse.patch', 'prototype-plan.json': 'native-build-plan.json' };
  for (const name of Object.keys(plan.libraries)) {
    assert.match(name, /^[A-Za-z0-9_.-]+$/);
    mapping['lib/' + name] = 'native-lib/' + name;
  }
  try {
    execFileSync('python3', ['-c', extract, tarPath, temporary, JSON.stringify(mapping)], { stdio: 'pipe', timeout: 120000 });
    const status = JSON.parse(await fs.readFile(path.join(temporary, 'native-build-status.json'), 'utf8'));
    const evidence = JSON.parse(await fs.readFile(path.join(temporary, 'native-build-evidence.json'), 'utf8'));
    assert.equal(status.status, 'complete'); assert.equal(status.exitCode, 0);
    for (const record of [status, evidence]) {
      assert.equal(record.sourceRevision, plan.nativeSourceRevision); assert.equal(String(record.runId), String(plan.buildRunId));
    }
    assert.equal(evidence.repository, plan.repository);
    assert.equal(status.binaries['bin/candidate'], plan.binarySha256);
    assert.equal(evidence.files['bin/candidate'], plan.binarySha256);
    assert.equal(evidence.files['seam-visibility-reuse.patch'], plan.patchSha256);
    const expected = { 'bin/bambu-studio': plan.binarySha256, 'seam-visibility-reuse.patch': plan.patchSha256, 'native-build-plan.json': plan.buildPlanSha256 };
    for (const [name, checksum] of Object.entries(plan.libraries)) expected['native-lib/' + name] = checksum;
    for (const [name, checksum] of Object.entries(expected)) assert.equal(hash(await fs.readFile(path.join(temporary, name))), checksum, 'Native runtime file changed: ' + name);
    await fs.copyFile(path.join(here, 'AppRun'), path.join(temporary, 'AppRun'));
    await fs.writeFile(path.join(temporary, 'native-runtime-plan.json'), JSON.stringify(plan, null, 2) + '\n');
    for (const file of ['AppRun', 'bin/bambu-studio']) await fs.chmod(path.join(temporary, file), 0o755);
    const names = [...Object.values(mapping), 'AppRun', 'native-runtime-plan.json'].sort();
    const sums = await Promise.all(names.map(async file => hash(await fs.readFile(path.join(temporary, file))) + '  ' + file));
    await fs.writeFile(path.join(temporary, 'native-runtime.SHA256SUMS'), sums.join('\n') + '\n');
    await fs.mkdir(outputRoot); // Existing contexts are never replaced.
    for (const name of await fs.readdir(temporary)) await fs.rename(path.join(temporary, name), path.join(outputRoot, name));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, input, output, runFile] = process.argv.slice(2), plan = await loadPlan();
  if (mode === 'verify-identity') verifyBuildIdentity(plan, JSON.parse(await fs.readFile(input)), JSON.parse(await fs.readFile(output)));
  else if (mode === 'from-tar') await materializeRuntime({ tarPath: input, outputRoot: output, plan });
  else if (mode === 'from-zip') {
    assert(runFile, 'Verified build identity directory is required');
    verifyBuildIdentity(plan, JSON.parse(await fs.readFile(path.join(runFile, 'artifact.json'))), JSON.parse(await fs.readFile(path.join(runFile, 'run.json'))));
    const bytes = await fs.readFile(input); assert.equal(hash(bytes), plan.artifactZipSha256, 'Native ZIP checksum mismatch');
    const files = unzipSync(bytes, { filter: entry => entry.name === 'native-prototype.tar.gz' });
    assert.deepEqual(Object.keys(files), ['native-prototype.tar.gz']);
    const tarPath = path.join(runFile, 'verified-native.tar.gz'); await fs.writeFile(tarPath, files['native-prototype.tar.gz'], { flag: 'wx' });
    await materializeRuntime({ tarPath, outputRoot: output, plan });
  } else throw Error('Use verify-identity <artifact.json> <run.json>, from-tar <verified.tar.gz> <new-context>, or from-zip <archive.zip> <new-context> <identity-directory>');
}
