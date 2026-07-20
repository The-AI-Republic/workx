import { resolveAuthConfig } from './authConfig';

export type RuntimeUrlSource = 'env' | 'default';

export interface RuntimeUrlConfig {
  homePageBaseUrl: string | null;
  backendApiBaseUrl: string | null;
  llmApiUrl: string | null;
  gatewayBaseUrl: string | null;
  gatewayLlmApiUrl: string | null;
  /** Optional OpenHub upstream-provider pin (for example, "deepseek"). */
  gatewayProviderSlug: string | null;
  gatewayMcpUrl: string | null;
  gatewayCatalogUrl: string | null;
  gatewayCatalogApiBaseUrl: string | null;
  /**
   * Public LLM model catalog endpoint (private WorkX builds). When set, the app
   * fetches it at startup and full-replaces the bundled default.json model list.
   * Opt-in: unset means the bundled default is used and no request is made.
   */
  modelCatalogUrl: string | null;
  gatewayMcpName: string;
  gatewayMcpAuthMode: 'none' | 'api-key' | 'session-jwt';
  gatewayMcpApiKey: string | null;
  gatewayMcpToolDiscoveryHeader: string | null;
  gatewayMcpToolDiscovery: string | null;
  /**
   * Default efficient model (bare model key, e.g. "deepseek-v4-flash") applied
   * when the user is logged in (gateway routing) and has not explicitly chosen
   * an efficient model. Unset in OSS builds — the efficient model then defaults
   * to the selected task model.
   */
  gatewayDefaultEfficientModel: string | null;
  llmRoutingMode: 'legacy' | 'gateway';
  deeplinkRedirectUrl: 'workx://auth/callback';
  source: {
    homePageBaseUrl: RuntimeUrlSource;
    backendApiBaseUrl: RuntimeUrlSource;
    llmApiUrl: RuntimeUrlSource;
    gatewayBaseUrl: RuntimeUrlSource;
    gatewayLlmApiUrl: RuntimeUrlSource;
    gatewayProviderSlug: RuntimeUrlSource;
    gatewayMcpUrl: RuntimeUrlSource;
    gatewayCatalogUrl: RuntimeUrlSource;
    gatewayCatalogApiBaseUrl: RuntimeUrlSource;
    modelCatalogUrl: RuntimeUrlSource;
    gatewayMcpName: RuntimeUrlSource;
    gatewayMcpAuthMode: RuntimeUrlSource;
    gatewayMcpApiKey: RuntimeUrlSource;
    gatewayMcpToolDiscoveryHeader: RuntimeUrlSource;
    gatewayMcpToolDiscovery: RuntimeUrlSource;
    llmRoutingMode: RuntimeUrlSource;
    deeplinkRedirectUrl: 'default';
  };
}

function viteEnv(): Record<string, string | undefined> {
  return typeof import.meta !== 'undefined'
    ? ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {})
    : {};
}

function processEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' ? process.env : {};
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0);
}

function joinUrl(baseUrl: string, path: string): string {
  const relativePath = path.replace(/^\/+/, '');
  return new URL(relativePath, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString().replace(/\/$/, '');
}

/** Origin (scheme + host[:port]) of a URL, or null when it can't be parsed. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function normalizeRoutingMode(value: string | undefined): 'legacy' | 'gateway' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'gateway') return 'gateway';
  if (normalized === 'legacy' || normalized === 'backend') return 'legacy';
  return null;
}

function normalizeMcpAuthMode(value: string | undefined): 'none' | 'api-key' | 'session-jwt' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'off') return 'none';
  if (normalized === 'api-key' || normalized === 'apikey' || normalized === 'bearer') return 'api-key';
  if (normalized === 'session-jwt' || normalized === 'jwt' || normalized === 'session') return 'session-jwt';
  return null;
}

export function resolveRuntimeUrls(): RuntimeUrlConfig {
  const env = processEnv();
  const vite = viteEnv();
  const authConfig = resolveAuthConfig();

  const backendFromEnv = firstNonEmpty(
    env.WORKX_BACKEND_API_BASE_URL,
    env.VITE_BACKEND_API_BASE_URL,
    vite.VITE_BACKEND_API_BASE_URL,
  );

  const backendApiBaseUrl = backendFromEnv ?? null;
  const gatewayBaseUrl = firstNonEmpty(
    env.WORKX_GATEWAY_BASE_URL,
    env.WORKX_GATEWAY_API_BASE_URL,
    env.VITE_GATEWAY_BASE_URL,
    env.VITE_GATEWAY_API_BASE_URL,
    vite.VITE_GATEWAY_BASE_URL,
    vite.VITE_GATEWAY_API_BASE_URL,
  ) ?? null;
  const gatewayLlmFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_LLM_API_URL,
    env.VITE_GATEWAY_LLM_API_URL,
    vite.VITE_GATEWAY_LLM_API_URL,
  );
  const gatewayProviderSlug = firstNonEmpty(
    env.WORKX_GATEWAY_PROVIDER_SLUG,
    env.VITE_GATEWAY_PROVIDER_SLUG,
    vite.VITE_GATEWAY_PROVIDER_SLUG,
  )?.trim() ?? null;
  const gatewayMcpFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_URL,
    env.VITE_GATEWAY_MCP_URL,
    vite.VITE_GATEWAY_MCP_URL,
  );
  const gatewayCatalogUrl = firstNonEmpty(
    env.WORKX_GATEWAY_CATALOG_URL,
    env.VITE_GATEWAY_CATALOG_URL,
    vite.VITE_GATEWAY_CATALOG_URL,
  ) ?? null;
  const gatewayLlmApiUrl = gatewayLlmFromEnv ?? (gatewayBaseUrl ? joinUrl(gatewayBaseUrl, 'v1') : null);
  const gatewayMcpUrl = gatewayMcpFromEnv ?? (gatewayBaseUrl ? joinUrl(gatewayBaseUrl, 'mcp') : null);
  // Native Apps catalog API root (Hub `GET /api/v1/apps/...`). Prefer an explicit
  // override, else reuse the catalog UI URL's origin (the catalog page and its
  // JSON API are served by the same Hub host), else derive from the gateway base.
  const gatewayCatalogApiFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_CATALOG_API_URL,
    env.VITE_GATEWAY_CATALOG_API_URL,
    vite.VITE_GATEWAY_CATALOG_API_URL,
  );
  const gatewayCatalogApiBaseUrl =
    gatewayCatalogApiFromEnv ??
    (gatewayCatalogUrl ? joinUrl(originOf(gatewayCatalogUrl) ?? gatewayCatalogUrl, 'api/v1/apps') : null) ??
    (gatewayBaseUrl ? joinUrl(gatewayBaseUrl, 'api/v1/apps') : null);
  // Opt-in public model catalog. Only fetched when explicitly configured, so
  // public/OSS builds keep using the bundled default.json.
  const modelCatalogUrl = firstNonEmpty(
    env.WORKX_MODEL_CATALOG_URL,
    env.VITE_MODEL_CATALOG_URL,
    vite.VITE_MODEL_CATALOG_URL,
  ) ?? null;
  const gatewayMcpNameFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_NAME,
    env.VITE_GATEWAY_MCP_NAME,
    vite.VITE_GATEWAY_MCP_NAME,
  );
  const gatewayMcpApiKey = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_API_KEY,
  ) ?? null;
  const requestedMcpAuthMode = normalizeMcpAuthMode(firstNonEmpty(
    env.WORKX_GATEWAY_MCP_AUTH_MODE,
    env.VITE_GATEWAY_MCP_AUTH_MODE,
    vite.VITE_GATEWAY_MCP_AUTH_MODE,
  ));
  const gatewayMcpAuthMode = requestedMcpAuthMode ?? (gatewayMcpApiKey ? 'api-key' : 'none');
  const gatewayMcpToolDiscoveryHeaderFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_TOOL_DISCOVERY_HEADER,
    env.VITE_GATEWAY_MCP_TOOL_DISCOVERY_HEADER,
    vite.VITE_GATEWAY_MCP_TOOL_DISCOVERY_HEADER,
  );
  const gatewayMcpToolDiscovery = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_TOOL_DISCOVERY,
    env.VITE_GATEWAY_MCP_TOOL_DISCOVERY,
    vite.VITE_GATEWAY_MCP_TOOL_DISCOVERY,
  ) ?? null;
  const gatewayMcpToolDiscoveryHeader = gatewayMcpToolDiscovery
    ? gatewayMcpToolDiscoveryHeaderFromEnv ?? 'X-Tool-Discovery'
    : null;
  const gatewayDefaultEfficientModel = firstNonEmpty(
    env.WORKX_GATEWAY_DEFAULT_EFFICIENT_MODEL,
    env.VITE_GATEWAY_DEFAULT_EFFICIENT_MODEL,
    vite.VITE_GATEWAY_DEFAULT_EFFICIENT_MODEL,
  ) ?? null;
  const requestedRoutingMode = normalizeRoutingMode(firstNonEmpty(
    env.WORKX_LLM_ROUTING_MODE,
    env.VITE_LLM_ROUTING_MODE,
    vite.VITE_LLM_ROUTING_MODE,
  ));
  const llmRoutingMode = requestedRoutingMode ?? (gatewayLlmApiUrl ? 'gateway' : 'legacy');

  return {
    homePageBaseUrl: authConfig.authBaseUrl,
    backendApiBaseUrl,
    llmApiUrl: backendApiBaseUrl ? `${backendApiBaseUrl}/api/llm` : '/api/llm',
    gatewayBaseUrl,
    gatewayLlmApiUrl,
    gatewayProviderSlug,
    gatewayMcpUrl,
    gatewayCatalogUrl,
    gatewayCatalogApiBaseUrl,
    modelCatalogUrl,
    gatewayMcpName: gatewayMcpNameFromEnv ?? 'gateway',
    gatewayMcpAuthMode,
    gatewayMcpApiKey,
    gatewayMcpToolDiscoveryHeader,
    gatewayMcpToolDiscovery,
    gatewayDefaultEfficientModel,
    llmRoutingMode,
    deeplinkRedirectUrl: 'workx://auth/callback',
    source: {
      homePageBaseUrl: authConfig.source.authBaseUrl,
      backendApiBaseUrl: backendFromEnv ? 'env' : 'default',
      llmApiUrl: backendFromEnv ? 'env' : 'default',
      gatewayBaseUrl: gatewayBaseUrl ? 'env' : 'default',
      gatewayLlmApiUrl: gatewayLlmFromEnv || gatewayBaseUrl ? 'env' : 'default',
      gatewayProviderSlug: gatewayProviderSlug ? 'env' : 'default',
      gatewayMcpUrl: gatewayMcpFromEnv || gatewayBaseUrl ? 'env' : 'default',
      gatewayCatalogUrl: gatewayCatalogUrl ? 'env' : 'default',
      gatewayCatalogApiBaseUrl: gatewayCatalogApiFromEnv ? 'env' : 'default',
      modelCatalogUrl: modelCatalogUrl ? 'env' : 'default',
      gatewayMcpName: gatewayMcpNameFromEnv ? 'env' : 'default',
      gatewayMcpAuthMode: requestedMcpAuthMode ? 'env' : 'default',
      gatewayMcpApiKey: gatewayMcpApiKey ? 'env' : 'default',
      gatewayMcpToolDiscoveryHeader: gatewayMcpToolDiscoveryHeaderFromEnv ? 'env' : 'default',
      gatewayMcpToolDiscovery: gatewayMcpToolDiscovery ? 'env' : 'default',
      llmRoutingMode: requestedRoutingMode ? 'env' : 'default',
      deeplinkRedirectUrl: 'default',
    },
  };
}
