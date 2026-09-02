export class WorkerError extends Error {
  constructor(message, { code = 'slicer_worker_failed', retryable = false, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WorkerError';
    this.code = code;
    this.retryable = retryable;
  }
}

export const asWorkerError = error => {
  if (error instanceof WorkerError) return error;
  return new WorkerError('The Slicer worker failed unexpectedly.', {
    code: 'slicer_worker_internal_error',
    cause: error
  });
};

export const boundedFailureMessage = error => {
  const message = error instanceof WorkerError
    ? error.message
    : 'The Slicer worker failed unexpectedly.';
  return String(message).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1_000);
};
