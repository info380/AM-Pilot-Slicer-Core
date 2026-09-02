import { loadWorkerConfig } from './config.js';
import { asWorkerError } from './errors.js';
import { runWorker } from './worker.js';

const shutdown = new AbortController();
const stop = signal => shutdown.abort(new Error(`Worker received ${signal}.`));
process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));

try {
  const config = loadWorkerConfig();
  await runWorker({ config, signal: shutdown.signal });
} catch (rawError) {
  const error = asWorkerError(rawError);
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'fatal',
    event: 'slicer_worker_start_failed',
    failureCode: error.code,
    message: error.message
  })}\n`);
  process.exitCode = 1;
}
