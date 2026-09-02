import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  PRUSA_SLICER_SOURCE_SHA256,
  PRUSA_SLICER_UPSTREAM_COMMIT,
  PRUSA_SLICER_VERSION
} from '../src/constants.js';

const dockerfile = fs.readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const release = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const license = fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');

assert.match(dockerfile, new RegExp(PRUSA_SLICER_UPSTREAM_COMMIT));
assert.match(dockerfile, new RegExp(PRUSA_SLICER_SOURCE_SHA256));
assert.match(dockerfile, new RegExp(`grep -F '${PRUSA_SLICER_VERSION.replaceAll('.', '\\.')}'`));
assert.match(dockerfile, /USER node/);
assert.match(dockerfile, /SLIC3R_GUI=OFF/);
assert.match(dockerfile, /SLIC3R_ENABLE_FORMAT_STEP=OFF/);
assert.match(release, /provenance: mode=max/);
assert.match(release, /sbom: true/);
assert.match(release, /cosign sign --yes/);
assert.match(release, /severity: CRITICAL,HIGH/);
assert.match(release, /gh release upload/);
assert.match(release, /release-evidence\/\*/);
assert.match(release, /prusa-slicer-binary\.SHA256/);
assert.match(release, /sbom\.spdx\.json/);
assert.match(release, /provenance\.slsa\.json/);
assert.match(release, /signature-verification\.json/);
assert.match(release, /EVIDENCE_SHA256SUMS/);
assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
assert.match(license, /Version 3, 19 November 2007/);
process.stdout.write('Release contract verified.\n');
