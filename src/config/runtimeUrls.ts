export type RuntimeUrlSource = 'env' | 'default';

export interface RuntimeUrlConfig {
  gatewayBaseUrl: string | null;
  gatewayLlmApiUrl: string | null;
  gatewayMcpUrl: string | null;
  gatewayCatalogUrl: string | null;
  gatewayCatalogApiBaseUrl: string | null;
  gatewayMcpName: string;
  gatewayMcpAuthMode: 'none' | 'api-key';
  gatewayMcpApiKey: string | null;
  gatewayMcpToolDiscoveryHeader: string | null;
  gatewayMcpToolDiscovery: string | null;
  /**
   * Default efficient model (bare model key, e.g. "deepseek-v4-flash") applied
   * for API-key gateway routing when the user has not explicitly chosen an
   * efficient model. Unset in OSS builds, where the efficient model defaults to
   * the selected task model.
   */
  gatewayDefaultEfficientModel: string | null;
  llmRoutingMode: 'legacy' | 'gateway';
  source: {
    gatewayBaseUrl: RuntimeUrlSource;
    gatewayLlmApiUrl: RuntimeUrlSource;
    gatewayMcpUrl: RuntimeUrlSource;
    gatewayCatalogUrl: RuntimeUrlSource;
    gatewayCatalogApiBaseUrl: RuntimeUrlSource;
    gatewayMcpName: RuntimeUrlSource;
    gatewayMcpAuthMode: RuntimeUrlSource;
    gatewayMcpApiKey: RuntimeUrlSource;
    gatewayMcpToolDiscoveryHeader: RuntimeUrlSource;
    gatewayMcpToolDiscovery: RuntimeUrlSource;
    llmRoutingMode: RuntimeUrlSource;
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

function normalizeMcpAuthMode(value: string | undefined): 'none' | 'api-key' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'off') return 'none';
  if (normalized === 'api-key' || normalized === 'apikey' || normalized === 'bearer') return 'api-key';
  return null;
}

export function resolveRuntimeUrls(): RuntimeUrlConfig {
  const env = processEnv();
  const vite = viteEnv();

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
  // Apps is Hub's user-facing control plane. The catalog page and API share the
  // Hub origin; Gateway remains the LLM/MCP execution plane.
  const gatewayCatalogApiFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_CATALOG_API_URL,
    env.VITE_GATEWAY_CATALOG_API_URL,
    vite.VITE_GATEWAY_CATALOG_API_URL,
  );
  const gatewayCatalogApiBaseUrl =
    gatewayCatalogApiFromEnv ??
    (gatewayCatalogUrl
      ? joinUrl(originOf(gatewayCatalogUrl) ?? gatewayCatalogUrl, 'api/v1/apps')
      : null);
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
    gatewayBaseUrl,
    gatewayLlmApiUrl,
    gatewayMcpUrl,
    gatewayCatalogUrl,
    gatewayCatalogApiBaseUrl,
    gatewayMcpName: gatewayMcpNameFromEnv ?? 'gateway',
    gatewayMcpAuthMode,
    gatewayMcpApiKey,
    gatewayMcpToolDiscoveryHeader,
    gatewayMcpToolDiscovery,
    gatewayDefaultEfficientModel,
    llmRoutingMode,
    source: {
      gatewayBaseUrl: gatewayBaseUrl ? 'env' : 'default',
      gatewayLlmApiUrl: gatewayLlmFromEnv || gatewayBaseUrl ? 'env' : 'default',
      gatewayMcpUrl: gatewayMcpFromEnv || gatewayBaseUrl ? 'env' : 'default',
      gatewayCatalogUrl: gatewayCatalogUrl ? 'env' : 'default',
      gatewayCatalogApiBaseUrl: gatewayCatalogApiFromEnv ? 'env' : 'default',
      gatewayMcpName: gatewayMcpNameFromEnv ? 'env' : 'default',
      gatewayMcpAuthMode: requestedMcpAuthMode ? 'env' : 'default',
      gatewayMcpApiKey: gatewayMcpApiKey ? 'env' : 'default',
      gatewayMcpToolDiscoveryHeader: gatewayMcpToolDiscoveryHeaderFromEnv ? 'env' : 'default',
      gatewayMcpToolDiscovery: gatewayMcpToolDiscovery ? 'env' : 'default',
      llmRoutingMode: requestedRoutingMode ? 'env' : 'default',
    },
  };
}
