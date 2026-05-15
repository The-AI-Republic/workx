/**
 * Shared timing constants for the typed-task layer.
 *
 * Values match claudy's `utils/task/framework.ts:24-28` verbatim. Both the
 * engine (eviction timer) and the UI (poll loop, panel grace, badge filter)
 * read from this file so the timing contract is single-sourced.
 */

/** Poll interval for background-task panels reading TaskOutputStore deltas. */
export const POLL_INTERVAL_MS = 1_000;

/** Hide the background panel this long after terminal status. */
export const STOPPED_DISPLAY_MS = 3_000;

/** Eviction grace window after terminal — keeps output readable to late pollers. */
export const PANEL_GRACE_MS = 30_000;

/**
 * Quota-eviction skip window: chunks of a non-terminal task whose lastReadAt
 * is within this many ms are skipped to avoid creating a gap mid-poll.
 */
export const EVICTION_GRACE_MS = 5_000;

/** Per-task soft cap on stored output bytes before TaskOutputManager evicts. */
export const TASK_OUTPUT_PER_TASK_CAP_BYTES = 50 * 1024 * 1024;

/** Max bytes of `data` in a single TaskOutputChunk row before splitting. */
export const TASK_OUTPUT_CHUNK_MAX_BYTES = 64 * 1024;
