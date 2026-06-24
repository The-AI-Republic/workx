/**
 * Apps marketplace API.
 *
 * Talks to the AI Republic Hub catalog API (`GET /api/v1/apps/...`). The
 * marketplace listing is public (the Hub uses an optional-user dependency), so
 * the browse view works signed-out and renders the public catalog. A bearer
 * token, when available, enriches each card with the user's per-app install /
 * activation state and is required for the install / activate mutations.
 */

import { GATEWAY_CATALOG_API_BASE_URL, HOME_PAGE_BASE_URL } from '../../constants';
import { getAccessToken } from '../../utils/cookie';

/** Per-app card returned by `GET /marketplace` (Hub `app_card`). */
export interface MarketplaceApp {
  appId: string;
  slug: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  categories: string[];
  tags: string[];
  /** "installed" | "uninstalled" — personalized when authenticated. */
  installStatus: string;
  enabled: boolean;
  isActivated: boolean;
  /** Hub-suggested next action for this app+user (e.g. "install", "connect"). */
  suggestedAction: string | null;
  version: string | null;
  monetizationTier: string | null;
  trustTier: string | null;
}

export interface MarketplacePage {
  items: MarketplaceApp[];
  nextCursor: string | null;
}

export class AppsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AppsApiError';
  }
}

/** True when a catalog API base is configured (Hub gateway wired up). */
export function isAppsCatalogConfigured(): boolean {
  return GATEWAY_CATALOG_API_BASE_URL.trim().length > 0;
}

function catalogUrl(path: string): string {
  const base = GATEWAY_CATALOG_API_BASE_URL.replace(/\/$/, '');
  if (!base) {
    throw new AppsApiError('Apps catalog API is not configured (set VITE_GATEWAY_CATALOG_API_URL).');
  }
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Best-effort session token for catalog requests. Tries browser cookies
 * (extension / web), then the web auth service. Returns null when no token is
 * obtainable (e.g. desktop, where the runtime owns credentials) — callers fall
 * back to the public catalog for reads and prompt sign-in for mutations.
 */
async function getCatalogToken(): Promise<string | null> {
  try {
    const cookieToken = await getAccessToken();
    if (cookieToken) return cookieToken;
  } catch {
    // ignore — cookie surface unavailable
  }
  try {
    const { getWebAuthService } = await import('../../../auth/WebAuthService');
    const authService = getWebAuthService(HOME_PAGE_BASE_URL);
    if (await authService.hasValidToken()) {
      return await authService.getAccessToken();
    }
  } catch {
    // ignore — web auth surface unavailable
  }
  return null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await getCatalogToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function normalizeApp(raw: Record<string, unknown>): MarketplaceApp {
  return {
    appId: String(raw.appId ?? raw.id ?? ''),
    slug: String(raw.slug ?? ''),
    name: String(raw.name ?? raw.slug ?? raw.appId ?? 'Untitled app'),
    description: (raw.description as string | null) ?? null,
    iconUrl: (raw.iconUrl as string | null) ?? null,
    categories: Array.isArray(raw.categories) ? (raw.categories as string[]) : [],
    tags: Array.isArray(raw.tags) ? (raw.tags as string[]) : [],
    installStatus: String(raw.installStatus ?? raw.status ?? 'uninstalled'),
    enabled: Boolean(raw.enabled),
    isActivated: Boolean(raw.isActivated),
    suggestedAction: (raw.suggestedAction as string | null) ?? null,
    version: (raw.version as string | null) ?? null,
    monetizationTier: (raw.monetizationTier as string | null) ?? null,
    trustTier: (raw.trustTier as string | null) ?? null,
  };
}

/**
 * Fetch a page of the public marketplace. Optionally filtered by `query` and
 * paginated via `cursor`.
 */
export async function fetchMarketplace(options: {
  query?: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<MarketplacePage> {
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set('q', options.query.trim());
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const url = catalogUrl(`/marketplace${qs ? `?${qs}` : ''}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: await authHeaders(),
    credentials: 'include',
    signal: options.signal,
  });

  if (!response.ok) {
    throw new AppsApiError(`Failed to load marketplace: ${response.status} ${response.statusText}`, response.status);
  }

  const data = (await response.json()) as { items?: unknown[]; nextCursor?: string | null };
  const items = Array.isArray(data.items)
    ? data.items.map((item) => normalizeApp(item as Record<string, unknown>))
    : [];
  return { items, nextCursor: data.nextCursor ?? null };
}

/** Mutate an app (install / uninstall / activate / deactivate). Requires auth. */
async function appAction(appId: string, action: string, method: 'POST' | 'DELETE'): Promise<MarketplaceApp | null> {
  const token = await getCatalogToken();
  if (!token) {
    throw new AppsApiError('Sign in to manage apps.', 401);
  }
  const response = await fetch(catalogUrl(`/${encodeURIComponent(appId)}/${action}`), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new AppsApiError(`Failed to ${action} app: ${response.status} ${response.statusText}`, response.status);
  }
  // Mutation responses vary by action; the caller typically refetches. Return
  // the parsed card when the Hub echoes one, otherwise null.
  try {
    const data = (await response.json()) as Record<string, unknown>;
    return data && (data.appId || data.id) ? normalizeApp(data) : null;
  } catch {
    return null;
  }
}

export function installApp(appId: string): Promise<MarketplaceApp | null> {
  return appAction(appId, 'install', 'POST');
}

export function uninstallApp(appId: string): Promise<MarketplaceApp | null> {
  return appAction(appId, 'uninstall', 'DELETE');
}

export function activateApp(appId: string): Promise<MarketplaceApp | null> {
  return appAction(appId, 'activate', 'POST');
}

export function deactivateApp(appId: string): Promise<MarketplaceApp | null> {
  return appAction(appId, 'deactivate', 'POST');
}
