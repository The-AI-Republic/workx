/**
 * Dot-path get/set + deep clone — dependency-free.
 *
 * BrowserX has no lodash; the policy resolver needs deterministic deep
 * set-by-path so the post-merge pin can defeat the one-level merges in
 * `buildRuntimeConfig`. Arrays are **replaced**, never concatenated — an
 * org allowlist must be exactly the admin's list.
 *
 * @module core/config/policy/pathUtils
 */

/** Structured deep clone with a JSON fallback for old runtimes. */
export function deepClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const sc = (globalThis as { structuredClone?: <V>(v: V) => V }).structuredClone;
  if (typeof sc === 'function') {
    try {
      return sc(value);
    } catch {
      /* fall through to JSON */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Split a dot-path into segments. Empty string → []. */
export function splitPath(path: string): string[] {
  return path.length === 0 ? [] : path.split('.');
}

/**
 * Set `value` at `path` on `target`, creating intermediate plain objects as
 * needed. Replaces whatever is there (arrays included). Mutates and returns
 * `target`. A zero-segment path is a no-op.
 */
export function setByPath<T extends Record<string, unknown>>(
  target: T,
  path: string,
  value: unknown
): T {
  const parts = splitPath(path);
  if (parts.length === 0) return target;
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = node[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
  return target;
}

/**
 * Delete the leaf at `path`, pruning now-empty parent objects. Mutates and
 * returns `target`. Missing paths are a no-op.
 */
export function deleteByPath<T extends Record<string, unknown>>(
  target: T,
  path: string
): T {
  const parts = splitPath(path);
  if (parts.length === 0) return target;
  const chain: Array<Record<string, unknown>> = [target];
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = node[parts[i]];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      return target; // path doesn't exist
    }
    node = next as Record<string, unknown>;
    chain.push(node);
  }
  delete node[parts[parts.length - 1]];
  // Prune empty ancestors.
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]).length === 0) {
      delete chain[i - 1][parts[i - 1]];
    } else break;
  }
  return target;
}

/** Read the value at `path`, or `undefined` if any segment is missing. */
export function getByPath(source: unknown, path: string): unknown {
  const parts = splitPath(path);
  let node: unknown = source;
  for (const key of parts) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * True when `path` is locked by `lockedKeys` — either an exact match OR a
 * descendant of a locked ancestor (locking `a.b` locks `a.b.c`).
 */
export function isPathLockedBy(lockedKeys: readonly string[], path: string): boolean {
  for (const locked of lockedKeys) {
    if (path === locked || path.startsWith(locked + '.')) return true;
  }
  return false;
}

/**
 * Flatten an object into leaf dot-paths (arrays are leaves). Used to detect
 * which paths a partial write patch touches.
 */
export function flattenLeafPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix ? `${prefix}.${k}` : k;
    out.push(...flattenLeafPaths(v, next));
  }
  return out;
}
