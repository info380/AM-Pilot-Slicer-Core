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
const sourceBundle = fs.readFileSync(new URL('./build-source-bundle.sh', import.meta.url), 'utf8');
const license = fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');

assert.match(dockerfile, new RegExp(PRUSA_SLICER_UPSTREAM_COMMIT));
assert.match(dockerfile, new RegExp(PRUSA_SLICER_SOURCE_SHA256));
assert.match(dockerfile, new RegExp(`grep -F '${PRUSA_SLICER_VERSION.replaceAll('.', '\\.')}'`));
assert.match(dockerfile, /USER node/);
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
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
assert.match(license, /Version 3, 19 November 2007/);
process.stdout.write('Release contract verified.\n');
