/**
 * Remote LLM model catalog (private WorkX builds).
 *
 * When `modelCatalogUrl` is configured (VITE_/WORKX_MODEL_CATALOG_URL), the app
 * fetches a provider-keyed catalog from the backend at startup and uses it to
 * full-replace the bundled `default.json` model list. The endpoint is public
 * (no auth) and returns the same JSON shape as
 * `src/core/models/providers/default.json`.
 *
 * Fallback: if the URL is unset, the request fails/times out, or the payload is
 * malformed, the cache stays null and `getDefaultProviders()` keeps serving the
 * bundled default. This module never throws to its callers.
 */

import type { IProviderConfig } from './types';
import { resolveRuntimeUrls } from './runtimeUrls';

/** Provider-keyed catalog, identical in shape to default.json. */
export type RemoteProviders = Record<string, IProviderConfig>;

const DEFAULT_TIMEOUT_MS = 5000;

// Cached override, set once a successful fetch validates. Read synchronously by
// getDefaultProviders() so both buildRuntimeConfig() and reload() pick it up.
let cachedRemoteProviders: RemoteProviders | null = null;
// Guards against concurrent/duplicate fetches (multiple getInstance() callers).
let inFlight: Promise<RemoteProviders | null> | null = null;

/**
 * The validated remote catalog, or null when none has been loaded. Returns a
 * deep copy so callers cannot mutate the cache.
 */
export function getRemoteProviders(): RemoteProviders | null {
  return cachedRemoteProviders
    ? (JSON.parse(JSON.stringify(cachedRemoteProviders)) as RemoteProviders)
    : null;
}

/** Test/reset hook. */
export function clearRemoteCatalog(): void {
  cachedRemoteProviders = null;
  inFlight = null;
}

/**
 * Validate that a parsed payload is a provider-keyed catalog with at least one
 * provider carrying a non-empty `models` array of entries with a `modelKey`.
 * Rejecting here means we keep the bundled default rather than wipe the list.
 */
function isValidCatalog(payload: unknown): payload is RemoteProviders {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  const providers = Object.values(payload as Record<string, unknown>);
  if (providers.length === 0) {
    return false;
  }
  let sawModel = false;
  for (const provider of providers) {
    if (!provider || typeof provider !== 'object') {
      return false;
    }
    const models = (provider as { models?: unknown }).models;
    if (models === undefined) {
      continue;
    }
    if (!Array.isArray(models)) {
      return false;
    }
    for (const model of models) {
      if (!model || typeof model !== 'object' || typeof (model as { modelKey?: unknown }).modelKey !== 'string') {
        return false;
      }
      sawModel = true;
    }
  }
  return sawModel;
}

/**
 * Fetch and cache the remote catalog. No-op (returns null) when no catalog URL
 * is configured. Swallows all network/parse/validation errors and leaves the
 * cache untouched so startup always proceeds on the bundled default.
 */
export async function fetchRemoteCatalog(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<RemoteProviders | null> {
  if (cachedRemoteProviders) {
    return cachedRemoteProviders;
  }
  if (inFlight) {
    return inFlight;
  }

  const url = resolveRuntimeUrls().modelCatalogUrl;
  if (!url) {
    return null;
  }

  inFlight = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) {
        console.warn(`[remoteCatalog] catalog fetch failed (${res.status}); using bundled default.json`);
        return null;
      }
      const payload = await res.json();
      if (!isValidCatalog(payload)) {
        console.warn('[remoteCatalog] catalog payload invalid; using bundled default.json');
        return null;
      }
      cachedRemoteProviders = payload;
      console.log(`[remoteCatalog] loaded ${Object.keys(payload).length} providers from ${url}`);
      return cachedRemoteProviders;
    } catch (error) {
      console.warn('[remoteCatalog] catalog fetch errored; using bundled default.json:', error);
      return null;
    } finally {
      clearTimeout(timer);
      inFlight = null;
    }
  })();

  return inFlight;
}
