import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyPrusaSlicer } from '../src/engine.js';

test('verifies PrusaSlicer through its supported help action', async t => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicer-engine-version-'));
  const executablePath = path.join(workDir, 'prusa-slicer-test-double');
  t.after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  await fs.writeFile(executablePath, `#!/bin/sh
if [ "$1" != "--help" ]; then
  printf '%s\\n' 'Unsupported version probe' >&2
  exit 2
fi
printf '%s\\n' 'PrusaSlicer-2.9.3+UNKNOWN based on Slic3r (without GUI support)'
`, { mode: 0o755 });

  const version = await verifyPrusaSlicer({
    prusaSlicerCommand: executablePath,
    workRoot: workDir,
    requestTimeoutMs: 30_000,
    maximumLogBytes: 64 * 1024
  });

  assert.equal(version, 'PrusaSlicer-2.9.3+UNKNOWN based on Slic3r (without GUI support)');
});
