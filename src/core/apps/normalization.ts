import type { AppAuthInfo, ManualSetupField, MarketplaceApp, MarketplacePage } from './types';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value)?.trim();
    if (text) return text;
  }
  return '';
}

function safeExternalUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw || raw.length > 8192) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

function manualField(value: unknown): ManualSetupField | null {
  const raw = record(value);
  if (!raw) return null;
  const key = firstString(raw.key);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) return null;
  return {
    key,
    label: firstString(raw.label, key) || 'Value',
    type: raw.type === 'secret' ? 'secret' : 'text',
    validation: stringValue(raw.validation),
    placeholder: stringValue(raw.placeholder),
    optional: raw.optional === true,
  };
}

export function normalizeAppAuth(value: unknown): AppAuthInfo | null {
  const raw = record(value);
  if (!raw) return null;
  const rawType = firstString(raw.type);
  const type: AppAuthInfo['type'] = ['none', 'oauth2', 'api_key', 'basic'].includes(rawType)
    ? (rawType as AppAuthInfo['type'])
    : 'unknown';
  const rawStatus = firstString(raw.status, raw.connectionStatus);
  const status: AppAuthInfo['status'] = [
    'connected',
    'needs_auth',
    'expired',
    'auth_error',
    'ready',
  ].includes(rawStatus)
    ? (rawStatus as AppAuthInfo['status'])
    : 'unknown';
  const manual = record(raw.manualSetup);
  const fields = Array.isArray(manual?.fields)
    ? manual.fields
        .map(manualField)
        .filter((field): field is ManualSetupField => Boolean(field))
        .slice(0, 32)
    : [];
  return {
    type,
    status,
    connectionStatus: stringValue(raw.connectionStatus),
    accountHint: stringValue(raw.accountHint)?.slice(0, 256) ?? null,
    manualFields: fields,
    setupUrl: safeExternalUrl(manual?.setupUrl),
  };
}

export function normalizeMarketplaceApp(
  value: unknown
): { app: MarketplaceApp; iconUrl: string | null } | null {
  const raw = record(value);
  if (!raw) return null;
  const appId = firstString(raw.appId, raw.id);
  if (!appId) return null;
  const iconUrl = safeExternalUrl(raw.iconUrl);
  return {
    app: {
      appId,
      slug: stringValue(raw.slug) ?? '',
      name: firstString(raw.name, raw.slug, raw.appId, raw.id) || 'Untitled app',
      description: stringValue(raw.description),
      hasIcon: Boolean(iconUrl),
      categories: Array.isArray(raw.categories)
        ? raw.categories
            .map(stringValue)
            .filter((x): x is string => Boolean(x))
            .slice(0, 32)
        : [],
      tags: Array.isArray(raw.tags)
        ? raw.tags
            .map(stringValue)
            .filter((x): x is string => Boolean(x))
            .slice(0, 64)
        : [],
      installStatus: firstString(raw.installStatus, raw.status) || 'uninstalled',
      enabled: raw.enabled === true,
      isActivated: raw.isActivated === true,
      suggestedAction: stringValue(raw.suggestedAction),
      version: stringValue(raw.version),
      monetizationTier: stringValue(raw.monetizationTier),
      trustTier: stringValue(raw.trustTier),
      auth: normalizeAppAuth(raw.auth),
    },
    iconUrl,
  };
}

export function normalizeMarketplacePage(value: unknown): {
  page: MarketplacePage;
  icons: Map<string, string>;
} {
  const raw = record(value);
  const icons = new Map<string, string>();
  const items: MarketplaceApp[] = [];
  if (Array.isArray(raw?.items)) {
    for (const item of raw.items) {
      const normalized = normalizeMarketplaceApp(item);
      if (!normalized) continue;
      items.push(normalized.app);
      if (normalized.iconUrl) icons.set(normalized.app.appId, normalized.iconUrl);
    }
  }
  return { page: { items, nextCursor: stringValue(raw?.nextCursor) }, icons };
}
