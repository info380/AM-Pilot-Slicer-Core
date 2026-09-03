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
assert.match(dockerfile, /node:22\.23\.2-bookworm-slim@sha256:4d676821dff059fd00d277ee4261ef34ea712317fed0737c03941481b5760c96/);
assert.match(dockerfile, /ARG DEBIAN_BUILD_SNAPSHOT=20250811T000000Z/);
assert.match(dockerfile, /ARG DEBIAN_RUNTIME_SNAPSHOT=20260903T000000Z/);
assert.match(dockerfile, /libgnutls30=3\.7\.9-2\+deb12u7/);
assert.match(dockerfile, /libpng16-16=1\.6\.39-2\+deb12u5/);
assert.match(dockerfile, /rm -rf \/usr\/local\/lib\/node_modules \/opt\/yarn-v1\.22\.22/);
assert.match(dockerfile, /test ! -e \/usr\/local\/lib\/node_modules\/npm/);
assert.match(dockerfile, /USER node\nRUN node --input-type=module --eval/);
assert.match(dockerfile, /verifyPrusaSlicer/);
assert.match(dockerfile, /https:\/\/ftp\.gnu\.org\/gnu\/gmp/);
assert.match(dockerfile, new RegExp(GMP_SOURCE_SHA256));
assert.match(sourceBundle, new RegExp(`gmp_version='${GMP_VERSION.replaceAll('.', '\\.')}'`));
assert.match(sourceBundle, new RegExp(GMP_SOURCE_SHA256));
assert.match(sourceBundle, /\.\/\*\.tar\.bz2/);
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
assert.match(qualificationCorpus, /file:\/\/\/worker\/src\/engine\.js/);
assert.match(qualificationCorpus, /AM_PILOT_QUALIFICATION_START/);
assert.match(qualificationCorpus, /AM_PILOT_QUALIFICATION_END/);
assert.match(qualificationCorpus, /deterministicRepeat: true/);
assert.match(qualificationCorpus, /chmod\(evidencePath, 0o644\)/);
assert.match(qualificationCorpus, /corpus-report\.json[\s\S]+mode: 0o644/);
assert.match(egressProxy, /slicer_egress_proxy_rejected/);
assert.match(egressProxy, /authority\.host !== config\.allowedHost/);
assert.match(egressProxy, /authority\.port !== config\.allowedPort/);
assert.equal(packageManifest.dependencies.undici, '8.10.1');
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
assert.match(license, /Version 3, 19 November 2007/);
process.stdout.write('Release contract verified.\n');
