/** Dependency-free handler errors, shared by policy and worker entrypoints. */

/** Throw this from a handler to skip all retry logic and go straight to 'dead'. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/**
 * Throw this from a handler when the job cannot run yet for a reason outside
 * the job itself (no provider key, a spend budget used up, shutdown). The
 * worker returns the job to `delayed` for `retryInMs` WITHOUT counting an
 * attempt, so the work waits instead of failing or completing empty.
 */
export class JobDeferredError extends Error {
  constructor(readonly reason: string, message: string, readonly retryInMs: number) {
    super(message);
    this.name = 'JobDeferredError';
  }
}
