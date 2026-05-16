/**
 * Write-surface guards (Track 20).
 *
 * The post-merge pin protects the read/reload path, but the agent config has
 * three independent write surfaces (`updateConfig`, the domain mutators, and
 * the LLM `setting_tool`) that mutate state AFTER the merge. Without guards a
 * locked value is silently overridable until the next reload. These helpers
 * are the second half of the end-to-end guarantee.
 *
 * @module core/config/policy/guards
 */

import type { PolicyNamespace } from './types';
import { PolicyLockedError } from './types';
import { getActivePolicySync } from './PolicyResolver';
import { deepClone, deleteByPath, flattenLeafPaths, isPathLockedBy } from './pathUtils';

function lockedKeysFor(ns: PolicyNamespace): string[] {
  const active = getActivePolicySync();
  if (!active) return [];
  const prefix = ns + '.';
  return active.lockedKeys
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

/**
 * True when `localPath` (namespace-relative, e.g. `approval.mode`,
 * `providers.openai.apiKey`) is locked — exact match or under a locked
 * ancestor.
 */
export function isKeyLocked(ns: PolicyNamespace, localPath: string): boolean {
  return isPathLockedBy(lockedKeysFor(ns), localPath);
}

/** Throw {@link PolicyLockedError} if `localPath` is locked for `ns`. */
export function assertWritable(ns: PolicyNamespace, localPath: string): void {
  if (isKeyLocked(ns, localPath)) {
    throw new PolicyLockedError(`${ns}.${localPath}`);
  }
}

/**
 * Remove only the exact locked leaf paths a partial write `patch` touches
 * (deep clone in, original untouched). Non-locked siblings are preserved, so
 * a bulk update still applies its allowed parts. Returns the cleaned patch
 * and the stripped paths so a caller can surface "ignored — managed by your
 * organization". The post-merge pin still re-asserts policy values regardless,
 * so this is defense-in-depth + a UX signal, not the sole guarantee.
 */
export function stripLockedWrites<T>(
  ns: PolicyNamespace,
  patch: T
): { patch: T; stripped: string[] } {
  const locked = lockedKeysFor(ns);
  if (locked.length === 0) return { patch, stripped: [] };

  const stripped = flattenLeafPaths(patch).filter((leaf) =>
    isPathLockedBy(locked, leaf)
  );
  if (stripped.length === 0) return { patch, stripped: [] };

  const out = deepClone(patch);
  for (const leaf of stripped) {
    deleteByPath(out as unknown as Record<string, unknown>, leaf);
  }
  return { patch: out, stripped };
}
