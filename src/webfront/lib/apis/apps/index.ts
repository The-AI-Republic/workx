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
  /** Auth requirement + connection state, embedded on the card by the Hub. */
  auth: AppAuthInfo | null;
}

export interface MarketplacePage {
  items: MarketplaceApp[];
  nextCursor: string | null;
}

/** A declared manual-credential field (api_key / basic apps). */
export interface ManualSetupField {
  key: string;
  label: string;
  /** "secret" renders a password input; "text" a plain one. */
  type: string;
  /** Optional validation regex (search semantics) the value must match. */
  validation: string | null;
  placeholder: string | null;
  optional: boolean;
}

/**
 * Per-app auth requirement, from the Hub's `GET /auth/status` (also embedded on
 * each marketplace card as `auth`). Drives the connect UI.
 */
export interface AppAuthInfo {
  /** "none" | "oauth2" | "api_key" | "basic". */
  type: string;
  /** "connected" | "needs_auth" | "expired" | "auth_error" | "ready". */
  status: string;
  connectionStatus: string | null;
  accountHint: string | null;
  /** Declared fields for the api_key/basic credential form (empty for oauth2). */
  manualFields: ManualSetupField[];
  /** Provider setup page (where to mint a token), when the Hub supplies one. */
  setupUrl: string | null;
}

/** True when the app needs the user to connect a credential before use. */
export function needsAuth(info: AppAuthInfo | null | undefined): boolean {
  if (!info) return false;
  if (info.type === 'none') return false;
  return info.status !== 'connected';
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

// Short-lived cache for the best-effort browser token. Without it, the
// cookie+WebAuthService probe (which can trigger a network refresh) would run
// on every request — including each debounced search keystroke.
const BROWSER_TOKEN_TTL_MS = 30_000;
let browserTokenCache: { value: string | null; at: number } | null = null;

/** Clear the cached browser token (e.g. on logout). Exposed for tests. */
export function clearCatalogTokenCache(): void {
  browserTokenCache = null;
}

/**
 * Best-effort session token from the browser surfaces — cookies (extension /
 * web), then the web auth service. Returns null on desktop, where the runtime
 * owns credentials; desktop callers pass an explicit token instead (see
 * `accessToken` on the exported functions). Cached for {@link BROWSER_TOKEN_TTL_MS}.
 */
async function getBrowserToken(): Promise<string | null> {
  const now = Date.now();
  if (browserTokenCache && now - browserTokenCache.at < BROWSER_TOKEN_TTL_MS) {
    return browserTokenCache.value;
  }
  let value: string | null = null;
  try {
    value = (await getAccessToken()) ?? null;
  } catch {
    // ignore — cookie surface unavailable
  }
  if (!value) {
    try {
      const { getWebAuthService } = await import('../../../auth/WebAuthService');
      const authService = getWebAuthService(HOME_PAGE_BASE_URL);
      if (await authService.hasValidToken()) {
        value = (await authService.getAccessToken()) ?? null;
      }
    } catch {
      // ignore — web auth surface unavailable
    }
  }
  browserTokenCache = { value, at: now };
  return value;
}

/** Resolve the token to use: an explicit override (desktop) wins, else browser. */
async function resolveToken(accessToken?: string | null): Promise<string | null> {
  if (accessToken) return accessToken;
  return getBrowserToken();
}

async function authHeaders(accessToken?: string | null): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = await resolveToken(accessToken);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * A usable string value, or null. Strings pass through; numbers/booleans are
 * stringified; objects/arrays/null/undefined become null so a non-string Hub
 * value never reaches the UI as "[object Object]".
 */
function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** First usable, non-empty string among the candidates. */
function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const str = asString(candidate);
    if (str && str.trim().length > 0) return str;
  }
  return '';
}

function normalizeManualField(raw: Record<string, unknown>): ManualSetupField {
  return {
    key: asString(raw.key) ?? '',
    label: firstString(raw.label, raw.key) || 'Value',
    type: asString(raw.type) ?? 'text',
    validation: asString(raw.validation),
    placeholder: asString(raw.placeholder),
    optional: Boolean(raw.optional),
  };
}

/** Parse the Hub's auth status block (from a card's `auth` or `GET /auth/status`). */
function normalizeAuth(raw: unknown): AppAuthInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const type = asString(obj.type);
  if (!type) return null;
  const manual = (obj.manualSetup ?? {}) as Record<string, unknown>;
  const fields = Array.isArray(manual.fields)
    ? (manual.fields as unknown[])
        .map((f) => normalizeManualField(f as Record<string, unknown>))
        .filter((f) => f.key)
    : [];
  return {
    type,
    status: firstString(obj.status, obj.connectionStatus) || 'needs_auth',
    connectionStatus: asString(obj.connectionStatus),
    accountHint: asString(obj.accountHint),
    manualFields: fields,
    setupUrl: asString(manual.setupUrl),
  };
}

function normalizeApp(raw: Record<string, unknown>): MarketplaceApp {
  return {
    appId: firstString(raw.appId, raw.id),
    slug: asString(raw.slug) ?? '',
    name: firstString(raw.name, raw.slug, raw.appId) || 'Untitled app',
    description: asString(raw.description),
    iconUrl: asString(raw.iconUrl),
    categories: Array.isArray(raw.categories) ? (raw.categories as unknown[]).map(String) : [],
    tags: Array.isArray(raw.tags) ? (raw.tags as unknown[]).map(String) : [],
    installStatus: firstString(raw.installStatus, raw.status) || 'uninstalled',
    enabled: Boolean(raw.enabled),
    isActivated: Boolean(raw.isActivated),
    suggestedAction: asString(raw.suggestedAction),
    version: asString(raw.version),
    monetizationTier: asString(raw.monetizationTier),
    trustTier: asString(raw.trustTier),
    auth: normalizeAuth(raw.auth),
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
  /** Explicit token (desktop). When omitted, a browser token is used if present. */
  accessToken?: string | null;
} = {}): Promise<MarketplacePage> {
  const params = new URLSearchParams();
  if (options.query?.trim()) params.set('q', options.query.trim());
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.limit) params.set('limit', String(options.limit));
  const qs = params.toString();
  const url = catalogUrl(`/marketplace${qs ? `?${qs}` : ''}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: await authHeaders(options.accessToken),
    credentials: 'include',
    signal: options.signal,
  });

  if (!response.ok) {
    throw new AppsApiError(`Failed to load marketplace: ${response.status} ${response.statusText}`, response.status);
  }

  const data = (await response.json()) as { items?: unknown[]; nextCursor?: string | null };
  // Drop rows with no usable id — an empty appId would collide as a Svelte
  // #each key and produce a malformed `/apps//install` mutation path.
  const items = Array.isArray(data.items)
    ? data.items.map((item) => normalizeApp(item as Record<string, unknown>)).filter((app) => app.appId)
    : [];
  return { items, nextCursor: data.nextCursor ?? null };
}

/**
 * Mutate an app (install / uninstall / activate / deactivate). Requires auth.
 * Pass `accessToken` on desktop, where the runtime owns credentials.
 */
async function appAction(
  appId: string,
  action: string,
  method: 'POST' | 'DELETE',
  accessToken?: string | null,
): Promise<MarketplaceApp | null> {
  if (!appId) {
    throw new AppsApiError('Cannot manage an app without an id.', 400);
  }
  const token = await resolveToken(accessToken);
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
  // Mutation responses vary by action. Return the parsed card when the Hub
  // echoes one, otherwise null so the caller can refetch.
  try {
    const data = (await response.json()) as Record<string, unknown>;
    return data && (data.appId || data.id) ? normalizeApp(data) : null;
  } catch {
    return null;
  }
}

export function installApp(appId: string, accessToken?: string | null): Promise<MarketplaceApp | null> {
  return appAction(appId, 'install', 'POST', accessToken);
}

export function uninstallApp(appId: string, accessToken?: string | null): Promise<MarketplaceApp | null> {
  return appAction(appId, 'uninstall', 'DELETE', accessToken);
}

export function activateApp(appId: string, accessToken?: string | null): Promise<MarketplaceApp | null> {
  return appAction(appId, 'activate', 'POST', accessToken);
}

export function deactivateApp(appId: string, accessToken?: string | null): Promise<MarketplaceApp | null> {
  return appAction(appId, 'deactivate', 'POST', accessToken);
}

/**
 * Pull a human-readable message from a failed Hub response. Hub control-plane
 * APIs use `{error:{message}}`; some validation paths use `{detail}`. Falls back
 * to the status line.
 */
async function hubErrorDetail(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: unknown; error?: { message?: unknown } };
    return (
      asString(body?.error?.message) ??
      asString(body?.detail) ??
      `${fallback}: ${response.status} ${response.statusText}`
    );
  } catch {
    return `${fallback}: ${response.status} ${response.statusText}`;
  }
}

/** Fetch the app's current auth requirement + connection state. */
export async function getAuthStatus(
  appId: string,
  accessToken?: string | null,
): Promise<AppAuthInfo | null> {
  if (!appId) throw new AppsApiError('Cannot read auth status without an id.', 400);
  const response = await fetch(catalogUrl(`/${encodeURIComponent(appId)}/auth/status`), {
    method: 'GET',
    headers: await authHeaders(accessToken),
    credentials: 'include',
  });
  if (!response.ok) {
    throw new AppsApiError(`Failed to read auth status: ${response.status} ${response.statusText}`, response.status);
  }
  return normalizeAuth(await response.json());
}

export interface OAuthStart {
  authorizationUrl: string;
  state: string;
  expiresIn: number | null;
}

/** Begin an OAuth connect: returns the provider authorize URL to open. */
export async function startOAuth(
  appId: string,
  options: { returnUrl?: string; accessToken?: string | null } = {},
): Promise<OAuthStart> {
  const token = await resolveToken(options.accessToken);
  if (!token) throw new AppsApiError('Sign in to connect apps.', 401);
  const response = await fetch(catalogUrl(`/${encodeURIComponent(appId)}/auth/oauth/start`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'include',
    body: JSON.stringify({ returnUrl: options.returnUrl ?? null }),
  });
  if (!response.ok) {
    throw new AppsApiError(await hubErrorDetail(response, 'Failed to start OAuth'), response.status);
  }
  const data = (await response.json()) as Record<string, unknown>;
  const url = asString(data.authorizationUrl);
  if (!url) throw new AppsApiError('The Hub returned no authorization URL.', 502);
  return {
    authorizationUrl: url,
    state: asString(data.state) ?? '',
    expiresIn: typeof data.expiresIn === 'number' ? data.expiresIn : null,
  };
}

/** Submit a manual credential (api_key / basic apps). */
export async function submitApiKey(
  appId: string,
  fields: Record<string, string>,
  options: { accountHint?: string; accessToken?: string | null } = {},
): Promise<AppAuthInfo | null> {
  const token = await resolveToken(options.accessToken);
  if (!token) throw new AppsApiError('Sign in to connect apps.', 401);
  const response = await fetch(catalogUrl(`/${encodeURIComponent(appId)}/auth/api-key`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    credentials: 'include',
    body: JSON.stringify({ fields, accountHint: options.accountHint ?? null }),
  });
  if (!response.ok) {
    throw new AppsApiError(await hubErrorDetail(response, 'Failed to save credential'), response.status);
  }
  // The Hub echoes the new connection; re-read status for the canonical shape.
  return getAuthStatus(appId, options.accessToken);
}
