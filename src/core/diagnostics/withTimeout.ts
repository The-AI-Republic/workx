/**
 * Bounded-time promise helper for diagnostic checks.
 *
 * A check must be fast and side-effect-free; this guarantees one slow/hung
 * check cannot stall the whole report. No shared util existed at write time
 * (grep), so this lives with the diagnostics module.
 *
 * @module core/diagnostics/withTimeout
 */

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`diagnostic check "${label}" timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
