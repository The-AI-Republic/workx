import { AppsServiceError, appsErrorForStatus } from './AppsServiceError';
import {
  normalizeAppAuth,
  normalizeMarketplaceApp,
  normalizeMarketplacePage,
} from './normalization';
import type {
  AppAuthInfo,
  AppIconData,
  AppsCredentialValidationResult,
  MarketplaceApp,
  MarketplacePage,
  OAuthStart,
  OpenHubCredential,
} from './types';
import type { OpenHubCredentialProvider } from './OpenHubCredentialProvider';

const JSON_LIMIT = 2 * 1024 * 1024;
const ICON_LIMIT = 256 * 1024;
const REQUIRED_SCOPES = ['chat', 'models', 'apps'] as const;
const APP_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export interface OpenHubAppsClientObserver {
  onReachable?(): void | Promise<void>;
  onUnavailable?(): void | Promise<void>;
  onRejected?(status: 401 | 403, credential: OpenHubCredential): void | Promise<void>;
}

export interface OpenHubAppsClientOptions {
  catalogApiBaseUrl: string;
  credentials: OpenHubCredentialProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  oauthReturnUrl?: string | null;
}

interface IconCacheEntry {
  value: AppIconData | null;
  expiresAt: number;
  size: number;
}

function ensureBaseUrl(raw: string): URL {
  const url = new URL(raw.endsWith('/') ? raw : `${raw}/`);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AppsServiceError('APPS_NOT_CONFIGURED', 'Apps requires an HTTPS OpenHub URL.');
  }
  if (url.username || url.password)
    throw new AppsServiceError('APPS_NOT_CONFIGURED', 'Apps URL credentials are not allowed.');
  return url;
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new AppsServiceError('APPS_INVALID_RESPONSE', 'OpenHub response was too large.', true);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new AppsServiceError(
          'APPS_INVALID_RESPONSE',
          'OpenHub response was too large.',
          true
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function boundedJson(response: Response): Promise<unknown> {
  const bytes = await boundedBytes(response, JSON_LIMIT);
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppsServiceError(
      'APPS_INVALID_RESPONSE',
      'OpenHub returned an invalid response.',
      true,
      response.status
    );
  }
}

function validateAppId(appId: string): string {
  if (!APP_ID.test(appId))
    throw new AppsServiceError('APPS_INVALID_ARGUMENT', 'Invalid app identifier.');
  return encodeURIComponent(appId);
}

function safeAuthorizationUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192)
    throw new AppsServiceError(
      'APPS_INVALID_RESPONSE',
      'OpenHub returned no valid authorization URL.',
      true
    );
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('unsafe URL');
    return url.toString();
  } catch {
    throw new AppsServiceError(
      'APPS_INVALID_RESPONSE',
      'OpenHub returned no valid authorization URL.',
      true
    );
  }
}

function magicMatches(mime: string, bytes: Uint8Array): boolean {
  if (mime === 'image/png')
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    );
  if (mime === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/webp')
    return (
      bytes.length >= 12 &&
      new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' &&
      new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
    );
  return false;
}

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class OpenHubAppsClient {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof globalThis.fetch;
  private observer: OpenHubAppsClientObserver = {};
  private readonly iconUrls = new Map<string, string>();
  private readonly iconCache = new Map<string, IconCacheEntry>();
  private iconCacheBytes = 0;

  constructor(private readonly options: OpenHubAppsClientOptions) {
    this.baseUrl = ensureBaseUrl(options.catalogApiBaseUrl);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  setObserver(observer: OpenHubAppsClientObserver): void {
    this.observer = observer;
  }

  async validateCredential(
    credential: Pick<OpenHubCredential, 'method' | 'token'>
  ): Promise<AppsCredentialValidationResult> {
    // Validation is performed while the access controller owns its state-update
    // queue. Let the controller translate validation failures itself instead of
    // re-entering that queue through the normal request observer.
    const response = await this.sendRaw('credentials/me', { method: 'GET' }, credential, false);
    if (response.status === 404 || response.status === 405) {
      throw new AppsServiceError(
        'APPS_BACKEND_INCOMPATIBLE',
        'This OpenHub deployment does not support WorkX Apps credentials.',
        false,
        response.status
      );
    }
    if (!response.ok) throw appsErrorForStatus(response.status);
    const raw = (await boundedJson(response)) as Record<string, unknown> | null;
    const capabilities = Array.isArray(raw?.capabilities)
      ? raw.capabilities.filter((v): v is string => typeof v === 'string')
      : [];
    if (raw?.contractVersion !== 1 || !capabilities.includes('single-gateway-credential-v1')) {
      throw new AppsServiceError(
        'APPS_BACKEND_INCOMPATIBLE',
        'This OpenHub deployment does not support unified gateway authentication.',
        false,
        response.status
      );
    }
    const credentialType =
      raw?.credentialType === 'api-key' || raw?.credentialType === 'session-jwt'
        ? raw.credentialType
        : null;
    if (!credentialType || credentialType !== credential.method)
      throw new AppsServiceError(
        'APPS_INVALID_CREDENTIAL',
        'The credential type is not valid for this WorkX build.'
      );
    const scopes = Array.isArray(raw?.scopes)
      ? raw.scopes.filter((v): v is string => typeof v === 'string')
      : [];
    const missingScopes = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new AppsServiceError(
        'APPS_FORBIDDEN',
        `This OpenHub credential is missing required permission: ${missingScopes.join(', ')}.`,
        false,
        403
      );
    }
    const allowedAppIds =
      raw?.allowedAppIds === null
        ? null
        : Array.isArray(raw?.allowedAppIds)
          ? raw.allowedAppIds.filter((v): v is string => typeof v === 'string').slice(0, 1000)
          : null;
    return { valid: true, credentialType, grantedScopes: scopes, allowedAppIds };
  }

  async marketplace(
    options: { query?: string; cursor?: string; limit?: number } = {}
  ): Promise<MarketplacePage> {
    const params = new URLSearchParams();
    const query = options.query?.trim();
    if (query) params.set('q', query);
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const raw = await this.requestJson(`marketplace${params.size ? `?${params}` : ''}`, {
      method: 'GET',
    });
    const normalized = normalizeMarketplacePage(raw);
    for (const [appId, url] of normalized.icons) this.iconUrls.set(appId, url);
    return normalized.page;
  }

  install(appId: string): Promise<MarketplaceApp | null> {
    return this.appAction(appId, 'install', 'POST');
  }
  uninstall(appId: string): Promise<MarketplaceApp | null> {
    return this.appAction(appId, 'uninstall', 'DELETE');
  }
  activate(appId: string): Promise<MarketplaceApp | null> {
    return this.appAction(appId, 'activate', 'POST');
  }
  deactivate(appId: string): Promise<MarketplaceApp | null> {
    return this.appAction(appId, 'deactivate', 'POST');
  }

  async getAuthStatus(appId: string): Promise<AppAuthInfo | null> {
    return normalizeAppAuth(
      await this.requestJson(`${validateAppId(appId)}/auth/status`, { method: 'GET' })
    );
  }

  async startOAuth(appId: string): Promise<OAuthStart> {
    const raw = (await this.requestJson(`${validateAppId(appId)}/auth/oauth/start`, {
      method: 'POST',
      body: JSON.stringify({ returnUrl: this.options.oauthReturnUrl ?? null }),
    })) as Record<string, unknown> | null;
    return {
      authorizationUrl: safeAuthorizationUrl(raw?.authorizationUrl),
      expiresIn:
        typeof raw?.expiresIn === 'number' && Number.isFinite(raw.expiresIn) ? raw.expiresIn : null,
    };
  }

  async submitCredentials(
    appId: string,
    fields: Record<string, string>,
    accountHint?: string
  ): Promise<AppAuthInfo | null> {
    const saved = await this.requestJson(`${validateAppId(appId)}/auth/api-key`, {
      method: 'POST',
      body: JSON.stringify({ fields, accountHint: accountHint ?? null }),
    });
    try {
      return await this.getAuthStatus(appId);
    } catch {
      // The credential POST is authoritative. A transient status re-read must
      // not tell the user that saving failed after OpenHub already committed it.
      const normalized = normalizeAppAuth(saved);
      if (normalized && normalized.type !== 'unknown') return normalized;
      return {
        type: 'api_key',
        status: 'connected',
        connectionStatus: 'connected',
        accountHint: accountHint?.slice(0, 256) ?? null,
        manualFields: [],
        setupUrl: null,
      };
    }
  }

  async getIcon(appId: string): Promise<AppIconData | null> {
    validateAppId(appId);
    const cached = this.iconCache.get(appId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const url = this.iconUrls.get(appId);
    if (!url) return null;
    try {
      const response = await this.fetchWithTimeout(url, { method: 'GET', redirect: 'error' });
      if (!response.ok) throw new Error('icon request failed');
      const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime))
        throw new Error('unsupported icon');
      const bytes = await boundedBytes(response, ICON_LIMIT);
      if (!magicMatches(mime, bytes)) throw new Error('invalid icon');
      const value = { mimeType: mime as AppIconData['mimeType'], base64: toBase64(bytes) };
      this.cacheIcon(appId, value, bytes.byteLength, 60 * 60_000);
      return value;
    } catch {
      this.cacheIcon(appId, null, 0, 60_000);
      return null;
    }
  }

  private async appAction(
    appId: string,
    action: string,
    method: 'POST' | 'DELETE'
  ): Promise<MarketplaceApp | null> {
    const raw = await this.requestJson(`${validateAppId(appId)}/${action}`, { method });
    const normalized = normalizeMarketplaceApp(raw);
    if (normalized?.iconUrl) this.iconUrls.set(normalized.app.appId, normalized.iconUrl);
    return normalized?.app ?? null;
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    let credential = await this.options.credentials.getCredential();
    if (!credential) {
      const policy = this.options.credentials.policy.authMethod;
      throw new AppsServiceError(
        policy === 'api-key' ? 'APPS_API_KEY_REQUIRED' : 'APPS_LOGIN_REQUIRED',
        policy === 'api-key' ? 'Add an OpenHub API key in Settings.' : 'Sign in to use Apps.'
      );
    }
    let response = await this.sendRaw(path, init, credential);
    if (response.status === 401) {
      const refreshed = await this.options.credentials.handleUnauthorized(credential);
      if (
        refreshed &&
        (refreshed.generation !== credential.generation || refreshed.token !== credential.token)
      ) {
        credential = refreshed;
        response = await this.sendRaw(path, init, credential);
      }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        await this.observer.onRejected?.(response.status, credential);
      else if (response.status >= 500 || response.status === 429)
        await this.observer.onUnavailable?.();
      throw appsErrorForStatus(response.status);
    }
    await this.observer.onReachable?.();
    return boundedJson(response);
  }

  private async sendRaw(
    path: string,
    init: RequestInit,
    credential: Pick<OpenHubCredential, 'token'>,
    observeAvailability = true
  ): Promise<Response> {
    const headers = new Headers(init.headers ?? {});
    headers.set('Accept', 'application/json');
    headers.set('Authorization', `Bearer ${credential.token}`);
    if (init.body !== undefined && !headers.has('Content-Type'))
      headers.set('Content-Type', 'application/json');
    try {
      return await this.fetchWithTimeout(new URL(path, this.baseUrl), {
        ...init,
        headers,
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof AppsServiceError) throw error;
      if (observeAvailability) await this.observer.onUnavailable?.();
      throw new AppsServiceError('APPS_UNAVAILABLE', 'OpenHub is unavailable.', true);
    }
  }

  private async fetchWithTimeout(input: RequestInfo | URL, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      return await this.fetchImpl(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  private cacheIcon(appId: string, value: AppIconData | null, size: number, ttl: number): void {
    const old = this.iconCache.get(appId);
    if (old) this.iconCacheBytes -= old.size;
    this.iconCache.delete(appId);
    this.iconCache.set(appId, { value, size, expiresAt: Date.now() + ttl });
    this.iconCacheBytes += size;
    while (this.iconCache.size > 128 || this.iconCacheBytes > 16 * 1024 * 1024) {
      const first = this.iconCache.entries().next().value as [string, IconCacheEntry] | undefined;
      if (!first) break;
      this.iconCache.delete(first[0]);
      this.iconCacheBytes -= first[1].size;
    }
  }
}
