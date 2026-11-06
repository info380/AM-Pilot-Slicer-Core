import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  GMP_SOURCE_SHA256,
  GMP_VERSION,
  PRUSA_SLICER_SOURCE_SHA256,
  PRUSA_SLICER_UPSTREAM_COMMIT,
  PRUSA_SLICER_VERSION
} from '../src/constants.js';

const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const release = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const qualification = fs.readFileSync(new URL('../.github/workflows/qualification.yml', import.meta.url), 'utf8');
const qualificationCorpus = fs.readFileSync(new URL('../qualification/run-corpus.mjs', import.meta.url), 'utf8');
const qualificationFailureCorpus = fs.readFileSync(
  new URL('../qualification/run-failure-corpus.mjs', import.meta.url),
  'utf8'
);
const egressProxy = fs.readFileSync(new URL('../src/egress-proxy.js', import.meta.url), 'utf8');
const sourceBundle = fs.readFileSync(new URL('./build-source-bundle.sh', import.meta.url), 'utf8');
const license = fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
const packageManifest = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

assert.match(dockerfile, new RegExp(PRUSA_SLICER_UPSTREAM_COMMIT));
assert.match(dockerfile, new RegExp(PRUSA_SLICER_SOURCE_SHA256));
assert.match(dockerfile, new RegExp(`grep -F '${PRUSA_SLICER_VERSION.replaceAll('.', '\\.')}'`));
assert.match(dockerfile, /USER node/);
assert.match(dockerfile, new RegExp(`org\\.opencontainers\\.image\\.version="${packageManifest.version.replaceAll('.', '\\.')}"`));
assert.match(dockerfile, /SLIC3R_GUI=OFF/);
assert.match(dockerfile, /SLIC3R_ENABLE_FORMAT_STEP=OFF/);
assert.match(dockerfile, /find \/src\/deps\/build-no-occt\/destdir\/usr\/local\/lib/);
assert.match(dockerfile, /LD_LIBRARY_PATH=\/opt\/prusa\/lib ldd/);
assert.match(dockerfile, /grep -F 'not found'/);
assert.match(dockerfile, /LD_LIBRARY_PATH=\/opt\/prusa\/lib \\/);
assert.match(dockerfile, /RUN ldd \/opt\/prusa\/bin\/prusa-slicer/);
assert.match(dockerfile, /node:22\.23\.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da/);
assert.match(dockerfile, /ARG DEBIAN_BUILD_SNAPSHOT=20250811T000000Z/);
assert.match(dockerfile, /ARG DEBIAN_RUNTIME_SNAPSHOT=20261105T000000Z/);
assert.doesNotMatch(dockerfile, /--allow-downgrades/);
assert.match(dockerfile, /libpcre2-8-0=10\.42-1\+deb12u2/);
assert.match(dockerfile, /libgnutls30=3\.7\.9-2\+deb12u7/);
assert.match(dockerfile, /libpng16-16=1\.6\.39-2\+deb12u6/);
assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules \/opt\/yarn-v1\.22\.22/);
assert.match(dockerfile, /test ! -e \/usr\/local\/lib\/node_modules\/npm/);
assert.match(dockerfile, /USER node\nRUN node --input-type=module --eval/);
assert.match(dockerfile, /verifyPrusaSlicer/);
assert.match(dockerfile, /https:\/\/ftp\.gnu\.org\/gnu\/gmp/);
assert.match(dockerfile, new RegExp(GMP_SOURCE_SHA256));
assert.match(sourceBundle, new RegExp(`gmp_version='${GMP_VERSION.replaceAll('.', '\\.')}'`));
assert.match(sourceBundle, new RegExp(GMP_SOURCE_SHA256));
assert.match(sourceBundle, /\.\/\*\.tar\.bz2/);
assert.match(release, /if: github\.event_name == 'workflow_dispatch'[\s\S]+native\/prusa\/qualify-statistics\.sh/);
assert.match(release, /provenance: mode=max/);
assert.match(release, /sbom: true/);
assert.match(release, /cosign sign --yes/);
assert.match(release, /severity: CRITICAL,HIGH/);
assert.match(release, /gh release upload/);
assert.match(release, /gh release create[^\n]+--draft/);
assert.match(release, /gh release edit[^\n]+--draft=false/);
assert.doesNotMatch(release, /gh release upload[^\n]+--clobber/);
assert.match(release, /release-evidence\/\*/);
assert.match(release, /prusa-slicer-binary\.SHA256/);
assert.match(release, /sbom\.spdx\.json/);
assert.match(release, /provenance\.slsa\.json/);
assert.match(release, /signature-verification\.json/);
assert.match(release, /EVIDENCE_SHA256SUMS/);
assert.match(qualification, /--network none/);
assert.match(qualification, /--read-only/);
assert.match(qualification, /--memory 512m/);
assert.match(qualification, /--memory-swap 512m/);
assert.match(qualification, /--cpus 0\.5/);
assert.match(qualification, /--pids-limit 256/);
assert.match(qualification, /--security-opt no-new-privileges/);
assert.match(qualification, /--cap-drop ALL/);
assert.match(qualification, /ghcr\.io\/info380\/am-pilot-slicer-core@\$\{IMAGE_DIGEST\}/);
assert.match(qualification, /cosign verify/);
assert.match(qualification, /am-pilot-slicer-core-reproduction-report/);
assert.match(qualification, /publishedBinaryChecksumSha256/);
assert.match(qualification, /rebuiltBinaryChecksumSha256/);
assert.match(qualification, /\.immutable == true/);
assert.match(qualification, /assert\.equal\(evidence\.capabilityRevisionId, CAPABILITY_REVISION_ID\)/);
assert.match(qualification, /run-failure-corpus\.mjs/);
assert.match(qualification, /am-pilot-slicer-core-failure-corpus-report/);
assert.match(qualification, /failure-qualification-output/);
assert.equal(
  qualification.match(/\(cd "\$\{output_dir\}" && sha256sum \.\/\* > SHA256SUMS\)/g)?.length,
  3
);
assert.match(qualification, /PRUSA_SLICER_INTEGRATION_CMD=\/opt\/prusa\/bin\/prusa-slicer/);
assert.match(qualification, /support-paint-qualification/);
assert.match(qualification, /# skipped 0/);
assert.match(qualificationCorpus, /file:\/\/\/worker\/src\/engine\.js/);
assert.match(qualificationCorpus, /file:\/\/\/worker\/src\/toolpath\.js/);
assert.match(qualificationCorpus, /AM_PILOT_QUALIFICATION_START/);
assert.match(qualificationCorpus, /AM_PILOT_QUALIFICATION_END/);
assert.match(qualificationCorpus, /deterministicRepeat: true/);
assert.match(qualificationCorpus, /toolpathChecksumSha256/);
assert.match(qualificationCorpus, /chmod\(evidencePath, 0o644\)/);
assert.match(qualificationCorpus, /corpus-report\.json[\s\S]+mode: 0o644/);
assert.match(qualificationFailureCorpus, /file:\/\/\/worker\/src\/api-client\.js/);
assert.match(qualificationFailureCorpus, /file:\/\/\/worker\/src\/plate\.js/);
assert.match(qualificationFailureCorpus, /file:\/\/\/worker\/src\/process\.js/);
assert.match(qualificationFailureCorpus, /file:\/\/\/worker\/src\/worker\.js/);
assert.match(qualificationFailureCorpus, /slicer_engine_failed/);
assert.match(qualificationFailureCorpus, /slicer_source_3mf_invalid/);
assert.match(qualificationFailureCorpus, /slicer_source_model_integrity_mismatch/);
assert.match(qualificationFailureCorpus, /slicer_worker_cancelled/);
assert.match(qualificationFailureCorpus, /slicer_worker_lease_lost/);
assert.match(qualificationFailureCorpus, /slicer_engine_timeout/);
assert.match(qualificationFailureCorpus, /slicer_source_model_download_failed/);
assert.match(qualificationFailureCorpus, /slicer_gcode_size_invalid/);
assert.match(qualificationFailureCorpus, /slicer_result_manifest_size_invalid/);
assert.match(qualificationFailureCorpus, /slicer_toolpath_size_invalid/);
assert.match(qualificationFailureCorpus, /failure-corpus-report\.json/);
assert.match(qualificationFailureCorpus, /chmod\(reportPath, 0o644\)/);
assert.match(egressProxy, /slicer_egress_proxy_rejected/);
assert.match(egressProxy, /authority\.host !== config\.allowedHost/);
assert.match(egressProxy, /authority\.port !== config\.allowedPort/);
assert.equal(packageManifest.dependencies.undici, '8.12.3');
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
assert.match(license, /Version 3, 19 November 2007/);
process.stdout.write('Release contract verified.\n');

const sharedRuntime = fs.readFileSync(new URL('../Dockerfile.bambu', import.meta.url), 'utf8');
assert.match(sharedRuntime, /node:22\.23\.4-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da/);
assert.match(sharedRuntime, /ARG VERIFIED_RUNTIME_IMAGE=ghcr\.io\/info380\/am-pilot-slicer-core-bambu@sha256:3545ba6ac6accb118628c3e83e82d25400e525d80dda9e1de35fe8e353840385/);
assert.match(sharedRuntime, /FROM \$\{VERIFIED_RUNTIME_IMAGE\} AS runtime/);
assert.match(sharedRuntime, /RUN rm -rf \.\/src \.\/schemas \.\/node_modules/);
assert.doesNotMatch(sharedRuntime, /apt-get|curl --/);
assert.match(sharedRuntime, /dpkg --purge apt libapt-pkg6\.0t64/);
assert.doesNotMatch(sharedRuntime, /--force-depends|--allow-remove-essential/);
const sharedEvidence = fs.readFileSync(new URL('./write-bambu-release-evidence.js', import.meta.url), 'utf8');
assert.match(sharedEvidence, /ubuntuSnapshot='20261104T000000Z'/);
assert.match(sharedRuntime, /libpcre2-8-0\)" = '10\.42-4ubuntu2\.2'/);
assert.match(sharedRuntime, /libsoup-3\.0-0\)" = '3\.4\.4-5ubuntu0\.10'/);
assert.match(sharedRuntime, /libsoup-3\.0-common\)" = '3\.4\.4-5ubuntu0\.10'/);
assert.match(sharedEvidence, /pcre2PackageVersion='10\.42-4ubuntu2\.2'/);
assert.match(sharedEvidence, /libsoup3PackageVersion='3\.4\.4-5ubuntu0\.10'/);
assert.match(sharedEvidence, /nodeVersion='22\.23\.4'/);

assert.match(sharedRuntime, /zlib1g\)" = '1:1\.3\.dfsg-3\.1ubuntu2\.3'/);

const bambuRelease=fs.readFileSync(new URL('../.github/workflows/release-bambu.yml',import.meta.url),'utf8');
assert.match(bambuRelease,/skip-setup-trivy: true/);
assert.match(bambuRelease,/trivy_0\.70\.0_Linux-64bit\.tar\.gz/);
assert.match(bambuRelease,/8b4376d5d6befe5c24d503f10ff136d9e0c49f9127a4279fd110b727929a5aa9/);
assert.match(bambuRelease,/sha256sum --check --strict/);
assert.match(bambuRelease,/severity: CRITICAL,HIGH/);
assert.match(bambuRelease,/exit-code: '1'/);
assert.match(bambuRelease,/flavor: latest=false/);
assert(bambuRelease.indexOf('Publish qualified rolling alias') > bambuRelease.indexOf('Publish permanent corresponding source and release evidence'));

assert.match(sharedRuntime, /libbrotli1\)" = '1\.1\.0-2ubuntu0\.1'/);
assert.match(sharedEvidence, /runtimeBaseImage='ghcr\.io\/info380\/am-pilot-slicer-core-bambu@sha256:3545ba6ac6accb118628c3e83e82d25400e525d80dda9e1de35fe8e353840385'/);
