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
 * Throw {@link PolicyLockedError} if a write at `localPath` would touch ANY
 * locked key: `localPath` itself is locked, lies under a locked ancestor, OR
 * is an ancestor of a locked key (a coarse create/delete that would clobber a
 * locked descendant). Unlike {@link assertWritable}, this also rejects the
 * ancestor case — use it for whole-subtree create/delete/activate ops where
 * there are no unlocked siblings within the same call to preserve. For
 * partial-merge writes prefer {@link stripLockedWrites} so unlocked siblings
 * still apply.
 */
export function assertWritableSubtree(
  ns: PolicyNamespace,
  localPath: string
): void {
  for (const k of lockedKeysFor(ns)) {
    if (
      localPath === k ||
      localPath.startsWith(k + '.') ||
      k.startsWith(localPath + '.')
    ) {
      throw new PolicyLockedError(`${ns}.${localPath}`);
    }
  }
}

/**
 * Remove only the exact locked leaf paths a partial write `patch` touches
 * (deep clone in, original untouched). Non-locked siblings are preserved, so
 * a bulk update still applies its allowed parts. Returns the cleaned patch
 * and the stripped paths so a caller can surface "ignored — managed by your
 * organization". The post-merge pin still re-asserts policy values regardless,
 * so this is defense-in-depth + a UX signal, not the sole guarantee.
 *
 * `basePath` namespaces a patch whose leaves are relative to a subtree (e.g.
 * `updateProvider`'s patch is relative to `providers.<id>`). It is prepended
 * before the lock check and to the returned `stripped` paths, but NOT used
 * for the in-patch `deleteByPath` (the patch object itself stays relative).
 */
export function stripLockedWrites<T>(
  ns: PolicyNamespace,
  patch: T,
  basePath = ''
): { patch: T; stripped: string[] } {
  const locked = lockedKeysFor(ns);
  if (locked.length === 0) return { patch, stripped: [] };

  const prefix = basePath ? basePath + '.' : '';
  const relStripped = flattenLeafPaths(patch).filter((leaf) =>
    isPathLockedBy(locked, prefix + leaf)
  );
  if (relStripped.length === 0) return { patch, stripped: [] };

  const out = deepClone(patch);
  for (const leaf of relStripped) {
    deleteByPath(out as unknown as Record<string, unknown>, leaf);
  }
  return { patch: out, stripped: relStripped.map((l) => prefix + l) };
}
