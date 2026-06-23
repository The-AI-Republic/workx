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
 * model is selected. Must match the runtime composite key exactly.
 */
export const FREE_USER_DEFAULT_COMPOUND_KEY = 'deepseek:deepseek-v4-flash';

/**
 * Raw model keys (lowercased) that free users are allowed to select. Currently
 * the single DeepSeek V4 Flash model, served through the backend gateway for
 * free-tier users. An explicit allow-list is used instead of a substring match.
 */
const FREE_USER_MODEL_KEYS = new Set<string>([
  'deepseek-v4-flash',
]);

/**
 * True when `modelKey` (a raw model key) is selectable by a free user.
 *
 * User-added custom endpoints are BYOK — they run on the user's own API key and
 * billing, so they are never gated behind the free-tier allow-list. Pass
 * `isCustom = true` for models that belong to a custom (user-defined) provider.
 */
export function isModelAvailableForFreeUser(modelKey: string, isCustom = false): boolean {
  if (isCustom) {
    return true;
  }
  return FREE_USER_MODEL_KEYS.has(modelKey.toLowerCase());
}
