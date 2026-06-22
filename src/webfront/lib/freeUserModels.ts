/**
 * Single source of truth for the free-tier (userType === 0) model gating used
 * by the model pickers (ModelSelection, ModelSelector, ModelSettings).
 *
 * These identifiers mirror entries in `src/core/models/providers/default.json`
 * and MUST be kept in sync whenever the free-tier model is refreshed. They live
 * here (rather than hand-copied into each Svelte component) so a refresh updates
 * one place instead of five.
 *
 * Two distinct key shapes are involved:
 *  - raw model key      — `model.modelKey` (e.g. "kimi-k2.6")
 *  - composite key      — "providerId:modelKey" (e.g. "fireworks:accounts/fireworks/models/kimi-k2p6")
 * The availability check receives raw model keys; the default-selection lookup
 * compares composite keys.
 */

/**
 * Composite key ("providerId:modelKey") used as the free-user default when no
 * model is selected. Must match the runtime composite key exactly — note the
 * `accounts/` segment that is part of the Fireworks raw model key.
 */
export const FREE_USER_DEFAULT_COMPOUND_KEY = 'fireworks:accounts/fireworks/models/kimi-k2p6';

/**
 * Raw model keys (lowercased) that free users are allowed to select. This is
 * the same Kimi K2.6 model offered across Fireworks, Moonshot, and Together —
 * the providers diverge on spelling (`kimi-k2p6` vs `kimi-k2.6`), so an explicit
 * allow-list is used instead of a substring match.
 */
const FREE_USER_MODEL_KEYS = new Set<string>([
  'accounts/fireworks/models/kimi-k2p6',
  'kimi-k2.6',
  'moonshotai/kimi-k2.6',
]);

/** True when `modelKey` (a raw model key) is selectable by a free user. */
export function isModelAvailableForFreeUser(modelKey: string): boolean {
  return FREE_USER_MODEL_KEYS.has(modelKey.toLowerCase());
}
