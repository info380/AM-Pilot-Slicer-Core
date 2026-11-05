import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('reviewed native diagnostic tools pass syntax checks without private inputs', () => {
  for (const name of ['benchmark-worker.mjs', 'qualify-prototype.mjs', 'floating-geometry.mjs', 'toolpath-comparison.mjs', 'materialize-runtime.mjs']) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(name, import.meta.url))], { stdio: 'pipe' });
  }
  for (const name of ['build-prototype.sh', 'fetch-runtime.sh', 'qualify-image.sh', 'build-media-runtime.sh']) execFileSync('bash', ['-n', fileURLToPath(new URL(name, import.meta.url))], { stdio: 'pipe' });
});

test('the native patch carries the exact cache header exercised by the lifetime tests', () => {
  const patch = fs.readFileSync(new URL('seam-visibility-reuse.patch', import.meta.url), 'utf8');
  const target = '+++ b/src/libslic3r/GCode/SeamVisibilityReuse.hpp\n';
  assert.equal(patch.split(target).length, 2, 'one explicit native cache header is required');
  const content = patch.split(target)[1].split('\n').filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n';
  assert.equal(content, fs.readFileSync(new URL('SeamVisibilityReuse.hpp', import.meta.url), 'utf8'));
});
