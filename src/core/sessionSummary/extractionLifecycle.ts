/**
 * Per-session "is an extraction running right now?" flag map, plus the
 * compaction interlock that waits for in-flight extractions to finish.
 *
 * Module-level state is keyed by sessionId so multiple parallel WorkX
 * sessions don't stomp on each other.
 *
 * The flag is only ever cleared inside the spawning code's `finally {}`
 * block, so a thrown extractor cannot leave the flag stuck. A 60s staleness
 * escape inside `waitForSessionSummaryExtraction` provides a second safety
 * net for the case where the flag never clears (process crash mid-extraction
 * on a previous run, etc.).
 */

import {
  EXTRACTION_POLL_INTERVAL_MS,
  EXTRACTION_STALE_THRESHOLD_MS,
  EXTRACTION_WAIT_TIMEOUT_MS,
} from './sessionSummaryUtils';

const extractionStartedAt = new Map<string, number>();

export function isExtractionInFlight(sessionId: string): boolean {
  return extractionStartedAt.has(sessionId);
}

export function markExtractionStarted(sessionId: string): void {
  extractionStartedAt.set(sessionId, Date.now());
}

export function markExtractionCompleted(sessionId: string): void {
  extractionStartedAt.delete(sessionId);
}

export function getExtractionAgeMs(sessionId: string): number | undefined {
  const started = extractionStartedAt.get(sessionId);
  return started === undefined ? undefined : Date.now() - started;
}

/**
 * Test-only: clear all per-session state. Real code should never need this.
 */
export function _resetExtractionLifecycleForTests(): void {
  extractionStartedAt.clear();
}

/**
 * Block until any in-flight extraction for this session completes.
 *
 * Two escape hatches keep this from ever deadlocking the caller:
 *  - Hard 15s deadline: returns even if the flag is still set.
 *  - 60s staleness escape: force-clears the flag and returns. Used when the
 *    extractor crashed without clearing (next caller pays the recovery cost).
 *
 * Mirrors claudy's waitForSessionMemoryExtraction()
 * (services/SessionMemory/sessionMemoryUtils.ts:89-105) verbatim except for
 * the per-session keying.
 *
 * @returns `'cleared'` if the flag cleared mid-wait, `'timeout'` if we hit
 *   the 15s deadline, `'stale'` if we hit the 60s staleness escape, or
 *   `'no-op'` if the flag was already clear when called.
 */
export async function waitForSessionSummaryExtraction(
  sessionId: string,
): Promise<'no-op' | 'cleared' | 'timeout' | 'stale'> {
  if (!isExtractionInFlight(sessionId)) {
    return 'no-op';
  }

  const deadline = Date.now() + EXTRACTION_WAIT_TIMEOUT_MS;
  while (isExtractionInFlight(sessionId)) {
    const ageMs = getExtractionAgeMs(sessionId) ?? 0;
    if (ageMs >= EXTRACTION_STALE_THRESHOLD_MS) {
      markExtractionCompleted(sessionId);
      return 'stale';
    }
    if (Date.now() >= deadline) {
      return 'timeout';
    }
    await new Promise((r) => setTimeout(r, EXTRACTION_POLL_INTERVAL_MS));
  }
  return 'cleared';
}
