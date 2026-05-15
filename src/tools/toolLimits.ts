/**
 * Constants and helpers for the tool result persistence system (track 09).
 *
 * Tools declare `maxResultSizeChars` on their ToolResultProfile. The threshold
 * function clamps that declared value, and `Number.POSITIVE_INFINITY` opts a
 * tool out of persistence entirely (retrieval-side tools like `cache_storage_tool`
 * or the server's `read_persisted_result` use this to avoid circular re-persist).
 */

/** Upper clamp on a tool's declared maxResultSizeChars. */
export const DEFAULT_MAX_RESULT_SIZE_CHARS = 50_000;

/** Tier-2 aggregate budget across all tool results in a single turn. */
export const MAX_TOOL_RESULTS_PER_MESSAGE_CHARS = 200_000;

/** Preview length included inline in the <persisted-output> message. */
export const PREVIEW_SIZE_BYTES = 2_000;

/**
 * Compute the actual persistence threshold for a tool.
 *
 *   - `Infinity`  → opt-out (return Infinity unchanged)
 *   - undefined   → use the global default
 *   - finite N    → min(N, default)
 *
 * Mirrors Claudy's `getPersistenceThreshold` (without the GrowthBook override,
 * which BrowserX doesn't have).
 */
export function getPersistenceThreshold(
  _toolName: string,
  declaredMax: number | undefined,
): number {
  if (declaredMax === undefined) return DEFAULT_MAX_RESULT_SIZE_CHARS;
  if (!Number.isFinite(declaredMax)) return declaredMax;
  return Math.min(declaredMax, DEFAULT_MAX_RESULT_SIZE_CHARS);
}
