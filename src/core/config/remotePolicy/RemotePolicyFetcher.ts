/**
 * RemotePolicyFetcher — the shared fleet remote-policy fetcher (Track 20).
 *
 * Net-new (no existing remote-fetch primitive in the codebase). Conditional
 * GET with an SHA-256 `If-None-Match` checksum, hard timeout, and fail-open
 * semantics ported faithfully from claudy's remoteManagedSettings. Caching is
 * done via the existing `ConfigStorageProvider` (not a bespoke disk path) so
 * it works the same on server and desktop.
 *
 * Tracks 12/16 consume the *config keys* a resolved remote policy sets — they
 * do NOT call this API.
 *
 * @module core/config/remotePolicy/RemotePolicyFetcher
 */

import type { ResolvedPolicy } from '../policy/types';

export interface RemoteFetchResult {
  /** `updated`: new policy; `unchanged`: 304 (keep cache); `cleared`:
   *  204/404 (managed policy removed → drop cache); `error`: fail-open. */
  status: 'updated' | 'unchanged' | 'cleared' | 'error';
  policy?: ResolvedPolicy;
  /** Auth-class error — caller should not retry on a tight loop. */
  skipRetry?: boolean;
}

export interface FetchOptions {
  endpoint: string;
  authHeaders?: Record<string, string>;
  cachedChecksum?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Recursively sort object keys for a stable serialization. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

async function sha256Hex(text: string): Promise<string> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;
  if (subtle) {
    const buf = await subtle.digest(
      'SHA-256',
      new TextEncoder().encode(text)
    );
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  const nodeCrypto = await import('node:crypto');
  return nodeCrypto.createHash('sha256').update(text).digest('hex');
}

/** Stable `sha256:<hex>` checksum of a policy document. */
export async function computePolicyChecksum(p: unknown): Promise<string> {
  return `sha256:${await sha256Hex(JSON.stringify(sortKeysDeep(p)))}`;
}

function coercePolicy(raw: unknown): ResolvedPolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const values =
    obj.values && typeof obj.values === 'object' && !Array.isArray(obj.values)
      ? (obj.values as Record<string, unknown>)
      : {};
  const lockedKeys = Array.isArray(obj.lockedKeys)
    ? (obj.lockedKeys as unknown[]).filter(
        (k): k is string => typeof k === 'string'
      )
    : [];
  if (Object.keys(values).length === 0 && lockedKeys.length === 0) return null;
  return { values, lockedKeys, origin: 'remote' };
}

/**
 * Conditional GET. Never throws — every failure path returns
 * `{ status: 'error' }` (fail-open is the caller's job, using stale cache).
 */
export async function fetchRemotePolicy(
  opts: FetchOptions
): Promise<RemoteFetchResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl || !opts.endpoint) return { status: 'error' };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 10_000
  );
  try {
    const headers: Record<string, string> = { ...(opts.authHeaders ?? {}) };
    if (opts.cachedChecksum) {
      headers['If-None-Match'] = `"${opts.cachedChecksum}"`;
    }
    const res = await fetchImpl(opts.endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (res.status === 304) return { status: 'unchanged' };
    if (res.status === 204 || res.status === 404) return { status: 'cleared' };
    if (res.status === 401 || res.status === 403) {
      return { status: 'error', skipRetry: true };
    }
    if (!res.ok) return { status: 'error' };

    const body = (await res.json()) as unknown;
    const policy = coercePolicy(body);
    if (!policy) return { status: 'cleared' }; // valid-but-empty == removed
    return { status: 'updated', policy };
  } catch {
    return { status: 'error' }; // timeout / network / parse — fail open
  } finally {
    clearTimeout(timer);
  }
}

// ── Background poll ────────────────────────────────────────────────────────

let _pollTimer: ReturnType<typeof setInterval> | null = null;

/** Start a single background poll. Idempotent. */
export function startPolicyPoll(tick: () => void, intervalMs = 3_600_000): void {
  if (_pollTimer) return;
  _pollTimer = setInterval(tick, intervalMs);
  // Don't keep a process alive just for the poll (Node).
  (_pollTimer as unknown as { unref?: () => void }).unref?.();
}

export function stopPolicyPoll(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}
