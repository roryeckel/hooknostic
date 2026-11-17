/** How long a single session post may take before the shim gives up on it. */
export const POST_TIMEOUT_MS = 10_000;

/**
 * Bound a promise without leaving a dangling rejection behind: racing alone
 * would leave the loser unhandled if it rejects after the race resolves, which
 * in OpenCode's host is an unhandled rejection. An abort `signal` settles it
 * at once, as a timeout does, and clears the timer.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number = POST_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T | undefined> {
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expiry = new Promise<undefined>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(undefined), ms);
    if (signal === undefined) return;
    onAbort = () => resolvePromise(undefined);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  });
}
