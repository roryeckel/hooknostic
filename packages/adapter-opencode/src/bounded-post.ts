/** How long a single session post may take before the shim gives up on it. */
export const POST_TIMEOUT_MS = 10_000;

/**
 * Bound a promise without leaving a dangling rejection behind: racing alone
 * would leave the loser unhandled if it rejects after the race resolves, which
 * in OpenCode's host is an unhandled rejection.
 */
export function withTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(undefined), POST_TIMEOUT_MS);
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
