import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
export function verifyNativeIdentity(plan, run, job) {
  assert.equal(plan.schema, 'am-pilot-prusa-native-statistics-component');
  assert.equal(plan.version, 1);
  assert.equal(plan.repository, 'info380/AM-Pilot-Slicer-Core');
  assert.match(plan.sourceRevision, /^[a-f0-9]{40}$/);
  assert.match(plan.image, /^ghcr\.io\/info380\/am-pilot-slicer-core@sha256:[a-f0-9]{64}$/);
  for (const key of ['binarySha256','patchSha256','jobLogSha256','sourceArchiveSha256','standaloneScanSha256']) assert.match(plan[key], /^[a-f0-9]{64}$/);
  assert.deepEqual(plan.reusedPaths, ['/opt/prusa']);
  assert.equal(plan.standaloneRuntimeIncluded, false);
  assert.equal(run.id, plan.buildRunId);
  assert.equal(run.head_sha, plan.sourceRevision);
  assert.equal(run.repository.id, plan.repositoryId);
  assert.equal(run.repository.full_name, plan.repository);
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed');
  assert.equal(job.id, plan.jobId);
  assert.equal(job.run_id, plan.buildRunId);
  assert.equal(job.head_sha, plan.sourceRevision);
  assert.equal(job.status, 'completed');
  for (const name of ['Build and publish immutable image','Sign immutable image digest',
    'Verify published PrusaSlicer runtime through the worker process boundary',
    'Qualify the native statistics exporter against stock G-code']) {
    assert.equal(job.steps.find(step=>step.name===name)?.conclusion, 'success', name);
  }
  const scan = job.steps.find(step=>step.name==='Scan immutable image digest');
  assert.equal(scan?.conclusion, plan.standaloneRuntimeScan);
  assert.ok(['success','failure'].includes(plan.standaloneRuntimeScan));
  assert.deepEqual(job.steps.filter(step=>step.conclusion==='failure').map(step=>step.name),
    plan.standaloneRuntimeScan==='failure' ? ['Scan immutable image digest'] : []);
  assert.equal(run.conclusion, plan.standaloneRuntimeScan);
  assert.equal(job.conclusion, plan.standaloneRuntimeScan);
}

export function verifyNativeEvidence(plan, log, source, scan, provenance) {
  for (const [bytes,key] of [[log,'jobLogSha256'],[source,'sourceArchiveSha256'],[scan,'standaloneScanSha256']]) {
    assert.ok(bytes.length>0 && bytes.length<=32*1024**2);
    assert.equal(hash(bytes), plan[key], key+' changed');
  }
  const text=log.toString('utf8');
  assert.match(text, /ok \d+ - native statistics exporter preserves stock Prusa G-code bytes/);
  assert.match(text, /# fail 0/);assert.match(text, /# skipped 0/);
  assert.ok(text.includes(plan.image.split('@')[1]));
  const args=provenance.buildDefinition.externalParameters.request.args;
  assert.equal(args['label:org.opencontainers.image.revision'],plan.sourceRevision);
  assert.equal(args['label:org.opencontainers.image.source'],'https://github.com/'+plan.repository);
  const internal=provenance.buildDefinition.internalParameters;
  assert.equal(internal.github_workflow_sha,plan.sourceRevision);
  assert.equal(internal.github_run_id,String(plan.buildRunId));
  assert.equal(internal.targetPlatform,'linux/amd64');
}

export function verifyNativeSignatureClaims(plan, signatures) {
  assert.ok(Array.isArray(signatures) && signatures.length>0);
  for (const signature of signatures) {
    assert.equal(signature.critical.image['docker-manifest-digest'],plan.image.split('@')[1]);
    assert.equal(signature.optional.Issuer,'https://token.actions.githubusercontent.com');
    assert.equal(signature.optional.githubWorkflowRepository,plan.repository);
    assert.equal(signature.optional.githubWorkflowSha,plan.sourceRevision);
    assert.equal(signature.optional.githubWorkflowTrigger,'workflow_dispatch');
  }
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [output]=process.argv.slice(2);assert.ok(output,'An empty evidence destination is required');
  const planBytes=await fs.readFile(new URL('./runtime-plan.json',import.meta.url)),plan=JSON.parse(planBytes);
  const api=(endpoint,extra=[])=>execFileSync('gh',['api',endpoint,...extra],{maxBuffer:32*1024**2});
  const root=`repos/${plan.repository}`;
  const run=api(`${root}/actions/runs/${plan.buildRunId}`),job=api(`${root}/actions/jobs/${plan.jobId}`);
  verifyNativeIdentity(plan,JSON.parse(run),JSON.parse(job));
  const log=api(`${root}/actions/jobs/${plan.jobId}/logs`,['--allow-escape-sequences']);
  const source=api(`${root}/tarball/${plan.sourceRevision}`);
  const scan=api(`${root}/code-scanning/analyses/${plan.standaloneScanId}`,['-H','Accept: application/sarif+json']);
  const provenance=execFileSync('docker',['buildx','imagetools','inspect',plan.image,'--format','{{json .Provenance.SLSA}}'],{maxBuffer:16*1024**2});
  verifyNativeEvidence(plan,log,source,scan,JSON.parse(provenance));
  const signature=execFileSync('cosign',['verify','--certificate-identity',
    `https://github.com/${plan.repository}/.github/workflows/release.yml@refs/heads/codex/native-feature-evidence`,
    '--certificate-oidc-issuer','https://token.actions.githubusercontent.com',plan.image],{maxBuffer:4*1024**2});
  verifyNativeSignatureClaims(plan,JSON.parse(signature));
  assert.equal(hash(await fs.readFile(new URL('./native-statistics.patch',import.meta.url))),plan.patchSha256);
  await fs.mkdir(output);
  for (const [name,bytes] of Object.entries({'runtime-plan.json':planBytes,'run.json':run,'job.json':job,
    'job.log':log,'source.tar.gz':source,'standalone-scan.sarif':scan,'provenance.json':provenance,'signature.json':signature})) {
    await fs.writeFile(path.join(output,'prusa-native-'+name),bytes,{flag:'wx',mode:0o644});
  }
}
