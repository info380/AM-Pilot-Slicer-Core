import { spawn } from 'node:child_process';

import { WorkerError } from './errors.js';

const appendBounded = (current, chunk, maximumBytes) => {
  const next = current + chunk.toString('utf8');
  return Buffer.byteLength(next, 'utf8') <= maximumBytes
    ? next
    : next.slice(-maximumBytes);
};

export const runProcess = async ({
  command,
  args,
  cwd,
  timeoutMs,
  maximumLogBytes,
  signal,
  onOutput = null
}) => await new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new WorkerError('Slicing was cancelled.', { code: 'slicer_worker_cancelled' }));
    return;
  }
  // The published PrusaSlicer binary resolves its checksum-locked dependency
  // closure through the image's loader path. Preserve only that loader setting
  // instead of forwarding process.env, which would expose the worker control
  // token and other service secrets to the slicer subprocess.
  const dynamicLibraryPath = String(process.env.LD_LIBRARY_PATH || '').trim();
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: cwd,
      TMPDIR: cwd,
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      TZ: 'UTC',
      ...(dynamicLibraryPath ? { LD_LIBRARY_PATH: dynamicLibraryPath } : {})
    }
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(new WorkerError('PrusaSlicer exceeded the qualified job timeout.', {
      code: 'slicer_engine_timeout'
    }));
  }, timeoutMs);
  timer.unref?.();

  const abort = () => {
    child.kill('SIGKILL');
    finish(new WorkerError('Slicing was cancelled.', { code: 'slicer_worker_cancelled' }));
  };
  signal?.addEventListener('abort', abort, { once: true });

  function finish(error = null) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (error) reject(error);
    else resolve({ stdout, stderr });
  }

  child.stdout.on('data', chunk => {
    stdout = appendBounded(stdout, chunk, maximumLogBytes);
    onOutput?.('stdout', chunk.toString('utf8'));
  });
  child.stderr.on('data', chunk => {
    stderr = appendBounded(stderr, chunk, maximumLogBytes);
    onOutput?.('stderr', chunk.toString('utf8'));
  });
  child.on('error', error => finish(new WorkerError('PrusaSlicer could not be started.', {
    code: 'slicer_engine_start_failed',
    cause: error
  })));
  child.on('close', (code, processSignal) => {
    if (settled) return;
    if (code === 0) {
      finish();
      return;
    }
    finish(new WorkerError(
      `PrusaSlicer failed while generating the requested output (exit ${code ?? 'unknown'}${processSignal ? `, ${processSignal}` : ''}).`,
      {
        code: 'slicer_engine_failed',
        cause: new Error((stderr || stdout).replace(/[\r\n\t]+/g, ' ').trim().slice(-600))
      }
    ));
  });
});
