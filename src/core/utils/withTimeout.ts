/**
 * withTimeout — race a promise against a timeout.
 *
 * Shared helper replacing the ad-hoc `setTimeout`/`Promise.race` patterns
 * scattered across services (design §3.10). The timer is always cleared so it
 * can't fire after the promise settles.
 *
 * - With a `fallback`, resolves to it on timeout.
 * - Without one, rejects with a `TimeoutError` on timeout.
 *
 * @module core/utils/withTimeout
 */

export class TimeoutError extends Error {
  constructor(public readonly timeoutMs: number, label?: string) {
    super(`TIMEOUT: ${label ?? 'operation'} did not complete within ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T>;
export function withTimeout<T, F>(promise: Promise<T>, ms: number, options: { fallback: F; label?: string }): Promise<T | F>;
export function withTimeout<T, F>(
  promise: Promise<T>,
  ms: number,
  labelOrOptions?: string | { fallback: F; label?: string }
): Promise<T | F> {
  const hasFallback = typeof labelOrOptions === 'object' && labelOrOptions !== null && 'fallback' in labelOrOptions;
  const label = typeof labelOrOptions === 'string' ? labelOrOptions : labelOrOptions?.label;

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T | F>((resolve, reject) => {
    timer = setTimeout(() => {
      if (hasFallback) {
        resolve((labelOrOptions as { fallback: F }).fallback);
      } else {
        reject(new TimeoutError(ms, label));
      }
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
