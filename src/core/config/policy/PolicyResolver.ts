/**
 * PolicyResolver — the shared, platform-agnostic resolver (Track 20).
 *
 * Module singleton (mirrors the `core/*` singleton pattern). Platform
 * bootstraps register ordered {@link PolicySource}s; the resolver picks the
 * first non-empty one ("first source wins"), caches it in-memory, and exposes
 * a synchronous accessor so the sync `buildRuntimeConfig` / `loadServerConfig`
 * pin sites can read it without going async.
 *
 * No I/O here — sources do the I/O. This file only orders, selects, caches,
 * and notifies.
 *
 * @module core/config/policy/PolicyResolver
 */

import type {
  PolicyNamespace,
  PolicyOrigin,
  PolicySource,
  PolicySummary,
  ResolvedPolicy,
} from './types';
import { isPathLockedBy } from './pathUtils';

let _sources: PolicySource[] = [];
let _active: ResolvedPolicy | null = null;
let _unsubscribes: Array<() => void> = [];
const _listeners = new Set<(p: ResolvedPolicy | null) => void>();

function isNonEmpty(p: ResolvedPolicy | null | undefined): p is ResolvedPolicy {
  return (
    !!p &&
    (Object.keys(p.values).length > 0 || p.lockedKeys.length > 0)
  );
}

function notify(): void {
  for (const cb of _listeners) {
    try {
      cb(_active);
    } catch (err) {
      console.error('[PolicyResolver] listener error:', err);
    }
  }
}

/**
 * Register ordered policy sources (highest priority first). Wires each
 * source's optional `subscribe()` so a platform-native change re-resolves and
 * notifies. Replaces any previously registered sources.
 */
export function registerPolicySources(sources: PolicySource[]): void {
  for (const u of _unsubscribes) {
    try {
      u();
    } catch {
      /* ignore */
    }
  }
  _unsubscribes = [];
  _sources = sources.slice();
  for (const s of _sources) {
    if (typeof s.subscribe === 'function') {
      try {
        _unsubscribes.push(
          s.subscribe(() => {
            void resolveActivePolicy();
          })
        );
      } catch (err) {
        console.warn('[PolicyResolver] source.subscribe failed:', err);
      }
    }
  }
}

/**
 * Resolve the active policy: first source whose `load()` yields a non-empty
 * policy wins entirely (sources are NOT merged with each other). Caches the
 * result and notifies listeners if it changed. Fail-soft: a source that
 * throws is skipped (never hard-deny on a policy source error).
 */
export async function resolveActivePolicy(): Promise<ResolvedPolicy | null> {
  let next: ResolvedPolicy | null = null;
  for (const source of _sources) {
    let loaded: ResolvedPolicy | null = null;
    try {
      loaded = await source.load();
    } catch (err) {
      console.warn(
        `[PolicyResolver] source "${source.origin}" load failed (skipping):`,
        err
      );
      continue;
    }
    if (isNonEmpty(loaded)) {
      next = loaded;
      break;
    }
  }

  const changed = JSON.stringify(next) !== JSON.stringify(_active);
  _active = next;
  if (changed) notify();
  return _active;
}

/** Last resolved policy (synchronous — for the pin sites). */
export function getActivePolicySync(): ResolvedPolicy | null {
  return _active;
}

/** Subscribe to resolved-policy changes. Returns an unsubscribe function. */
export function onPolicyChanged(
  cb: (p: ResolvedPolicy | null) => void
): () => void {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/** Active policy origin, or `null` when no managed policy is in effect. */
export function getPolicyOrigin(): PolicyOrigin {
  return _active?.origin ?? null;
}

/**
 * Locked dot-paths for a namespace, with the `agent.`/`server.` prefix
 * stripped (so callers compare against their own config paths).
 */
export function getLockedKeys(ns: PolicyNamespace): string[] {
  if (!_active) return [];
  const prefix = ns + '.';
  return _active.lockedKeys
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

/** True when `localPath` (already namespace-relative) is locked for `ns`. */
export function isLockedFor(ns: PolicyNamespace, localPath: string): boolean {
  return isPathLockedBy(getLockedKeys(ns), localPath);
}

/** Redaction-safe summary for diagnostics. Never returns values. */
export function getActivePolicySummary(): PolicySummary {
  return {
    origin: _active?.origin ?? null,
    lockedKeys: _active ? _active.lockedKeys.slice() : [],
    valueCount: _active ? Object.keys(_active.values).length : 0,
  };
}

/** Test-only: clear all resolver state. */
export function __resetPolicyResolverForTests(): void {
  for (const u of _unsubscribes) {
    try {
      u();
    } catch {
      /* ignore */
    }
  }
  _sources = [];
  _active = null;
  _unsubscribes = [];
  _listeners.clear();
}
