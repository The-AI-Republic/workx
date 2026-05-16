/**
 * applyPolicy — the post-merge pin (Track 20).
 *
 * Called AFTER all normal merging in both config systems
 * (`buildRuntimeConfig` for the agent config, `loadServerConfig` for the
 * server config). It overlays every admin-provided value at its dot-path
 * using a deep set, so the one-level merges in `buildRuntimeConfig` cannot
 * defeat a nested managed value (e.g. `tools.sandboxPolicy.network_access`).
 *
 * This is the single guarantee the whole track rests on. Pure and
 * synchronous so the sync hydrators stay sync.
 *
 * @module core/config/policy/applyPolicy
 */

import type { PolicyNamespace, ResolvedPolicy } from './types';
import { deepClone, setByPath } from './pathUtils';

/**
 * Overlay `policy` onto `target` for namespace `ns` and stamp the runtime
 * policy marker (agent namespace only). Mutates and returns `target`.
 *
 * - Filters `policy.values` / `policy.lockedKeys` to the `${ns}.` prefix.
 * - Deep-sets each value at its namespace-relative path (arrays replace).
 * - For the `agent` namespace, sets `target.policy = { lockedKeys, origin }`
 *   so consumers/UI can render locked fields non-editable. Cleared when no
 *   policy is active.
 */
export function applyPolicy<T>(
  target: T,
  policy: ResolvedPolicy | null,
  ns: PolicyNamespace
): T {
  const rec = target as unknown as Record<string, unknown>;
  if (!policy) {
    if (ns === 'agent') {
      delete rec.policy;
    }
    return target;
  }

  const prefix = ns + '.';

  for (const [key, value] of Object.entries(policy.values)) {
    if (!key.startsWith(prefix)) continue;
    const local = key.slice(prefix.length);
    if (local.length === 0) continue;
    setByPath(rec, local, deepClone(value));
  }

  if (ns === 'agent') {
    const lockedKeys = policy.lockedKeys
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length));
    rec.policy = {
      lockedKeys,
      origin: policy.origin,
    };
  }

  return target;
}
