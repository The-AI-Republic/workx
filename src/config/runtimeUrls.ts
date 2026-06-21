import { resolveAuthConfig } from './authConfig';

export type RuntimeUrlSource = 'env' | 'default';

export interface RuntimeUrlConfig {
  homePageBaseUrl: string | null;
  backendApiBaseUrl: string | null;
  llmApiUrl: string | null;
  gatewayBaseUrl: string | null;
  gatewayLlmApiUrl: string | null;
  gatewayMcpUrl: string | null;
  gatewayCatalogUrl: string | null;
  gatewayMcpName: string;
  gatewayMcpAuthMode: 'none' | 'api-key' | 'session-jwt';
  gatewayMcpApiKey: string | null;
  gatewayMcpToolDiscovery: string | null;
  aiHubGatewayBaseUrl: string | null;
  aiHubLlmApiUrl: string | null;
  aiHubMcpUrl: string | null;
  aiHubCatalogUrl: string | null;
  llmRoutingMode: 'legacy' | 'ai-hub';
  deeplinkRedirectUrl: 'workx://auth/callback';
  source: {
    homePageBaseUrl: RuntimeUrlSource;
    backendApiBaseUrl: RuntimeUrlSource;
    llmApiUrl: RuntimeUrlSource;
    gatewayBaseUrl: RuntimeUrlSource;
    gatewayLlmApiUrl: RuntimeUrlSource;
    gatewayMcpUrl: RuntimeUrlSource;
    gatewayCatalogUrl: RuntimeUrlSource;
    gatewayMcpName: RuntimeUrlSource;
    gatewayMcpAuthMode: RuntimeUrlSource;
    gatewayMcpApiKey: RuntimeUrlSource;
    gatewayMcpToolDiscovery: RuntimeUrlSource;
    aiHubGatewayBaseUrl: RuntimeUrlSource;
    aiHubLlmApiUrl: RuntimeUrlSource;
    aiHubMcpUrl: RuntimeUrlSource;
    aiHubCatalogUrl: RuntimeUrlSource;
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
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString().replace(/\/$/, '');
}

function normalizeRoutingMode(value: string | undefined): 'legacy' | 'ai-hub' | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'ai-hub' || normalized === 'hub' || normalized === 'gateway') return 'ai-hub';
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
    env.WORKX_AI_HUB_GATEWAY_BASE_URL,
    env.WORKX_HUB_GATEWAY_BASE_URL,
    env.VITE_GATEWAY_BASE_URL,
    env.VITE_GATEWAY_API_BASE_URL,
    env.VITE_AI_HUB_GATEWAY_BASE_URL,
    env.VITE_HUB_GATEWAY_BASE_URL,
    vite.VITE_GATEWAY_BASE_URL,
    vite.VITE_GATEWAY_API_BASE_URL,
    vite.VITE_AI_HUB_GATEWAY_BASE_URL,
    vite.VITE_HUB_GATEWAY_BASE_URL,
  ) ?? null;
  const gatewayLlmFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_LLM_API_URL,
    env.WORKX_AI_HUB_LLM_API_URL,
    env.WORKX_HUB_LLM_API_URL,
    env.VITE_GATEWAY_LLM_API_URL,
    env.VITE_AI_HUB_LLM_API_URL,
    env.VITE_HUB_LLM_API_URL,
    vite.VITE_GATEWAY_LLM_API_URL,
    vite.VITE_AI_HUB_LLM_API_URL,
    vite.VITE_HUB_LLM_API_URL,
  );
  const gatewayMcpFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_URL,
    env.WORKX_AI_HUB_MCP_URL,
    env.WORKX_HUB_MCP_URL,
    env.VITE_GATEWAY_MCP_URL,
    env.VITE_AI_HUB_MCP_URL,
    env.VITE_HUB_MCP_URL,
    vite.VITE_GATEWAY_MCP_URL,
    vite.VITE_AI_HUB_MCP_URL,
    vite.VITE_HUB_MCP_URL,
  );
  const gatewayCatalogUrl = firstNonEmpty(
    env.WORKX_GATEWAY_CATALOG_URL,
    env.WORKX_AI_HUB_CATALOG_URL,
    env.WORKX_HUB_CATALOG_URL,
    env.VITE_GATEWAY_CATALOG_URL,
    env.VITE_AI_HUB_CATALOG_URL,
    env.VITE_HUB_CATALOG_URL,
    vite.VITE_GATEWAY_CATALOG_URL,
    vite.VITE_AI_HUB_CATALOG_URL,
    vite.VITE_HUB_CATALOG_URL,
  ) ?? null;
  const gatewayLlmApiUrl = gatewayLlmFromEnv ?? (gatewayBaseUrl ? joinUrl(gatewayBaseUrl, '/v1') : null);
  const gatewayMcpUrl = gatewayMcpFromEnv ?? (gatewayBaseUrl ? joinUrl(gatewayBaseUrl, '/mcp') : null);
  const gatewayMcpNameFromEnv = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_NAME,
    env.WORKX_AI_HUB_MCP_NAME,
    env.VITE_GATEWAY_MCP_NAME,
    env.VITE_AI_HUB_MCP_NAME,
    vite.VITE_GATEWAY_MCP_NAME,
    vite.VITE_AI_HUB_MCP_NAME,
  );
  const gatewayMcpApiKey = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_API_KEY,
    env.WORKX_AI_HUB_MCP_API_KEY,
  ) ?? null;
  const requestedMcpAuthMode = normalizeMcpAuthMode(firstNonEmpty(
    env.WORKX_GATEWAY_MCP_AUTH_MODE,
    env.WORKX_AI_HUB_MCP_AUTH_MODE,
    env.VITE_GATEWAY_MCP_AUTH_MODE,
    env.VITE_AI_HUB_MCP_AUTH_MODE,
    vite.VITE_GATEWAY_MCP_AUTH_MODE,
    vite.VITE_AI_HUB_MCP_AUTH_MODE,
  ));
  const gatewayMcpAuthMode = requestedMcpAuthMode ?? (gatewayMcpApiKey ? 'api-key' : 'none');
  const gatewayMcpToolDiscovery = firstNonEmpty(
    env.WORKX_GATEWAY_MCP_TOOL_DISCOVERY,
    env.WORKX_AI_HUB_MCP_TOOL_DISCOVERY,
    env.VITE_GATEWAY_MCP_TOOL_DISCOVERY,
    env.VITE_AI_HUB_MCP_TOOL_DISCOVERY,
    vite.VITE_GATEWAY_MCP_TOOL_DISCOVERY,
    vite.VITE_AI_HUB_MCP_TOOL_DISCOVERY,
  ) ?? null;
  const requestedRoutingMode = normalizeRoutingMode(firstNonEmpty(
    env.WORKX_LLM_ROUTING_MODE,
    env.VITE_LLM_ROUTING_MODE,
    vite.VITE_LLM_ROUTING_MODE,
  ));
  const llmRoutingMode = requestedRoutingMode ?? (gatewayLlmApiUrl ? 'ai-hub' : 'legacy');

  return {
    homePageBaseUrl: authConfig.authBaseUrl,
    backendApiBaseUrl,
    llmApiUrl: backendApiBaseUrl ? `${backendApiBaseUrl}/api/llm` : '/api/llm',
    gatewayBaseUrl,
    gatewayLlmApiUrl,
    gatewayMcpUrl,
    gatewayCatalogUrl,
    gatewayMcpName: gatewayMcpNameFromEnv ?? 'gateway',
    gatewayMcpAuthMode,
    gatewayMcpApiKey,
    gatewayMcpToolDiscovery,
    aiHubGatewayBaseUrl: gatewayBaseUrl,
    aiHubLlmApiUrl: gatewayLlmApiUrl,
    aiHubMcpUrl: gatewayMcpUrl,
    aiHubCatalogUrl: gatewayCatalogUrl,
    llmRoutingMode,
    deeplinkRedirectUrl: 'workx://auth/callback',
    source: {
      homePageBaseUrl: authConfig.source.authBaseUrl,
      backendApiBaseUrl: backendFromEnv ? 'env' : 'default',
      llmApiUrl: backendFromEnv ? 'env' : 'default',
      gatewayBaseUrl: gatewayBaseUrl ? 'env' : 'default',
      gatewayLlmApiUrl: gatewayLlmFromEnv || gatewayBaseUrl ? 'env' : 'default',
      gatewayMcpUrl: gatewayMcpFromEnv || gatewayBaseUrl ? 'env' : 'default',
      gatewayCatalogUrl: gatewayCatalogUrl ? 'env' : 'default',
      gatewayMcpName: gatewayMcpNameFromEnv ? 'env' : 'default',
      gatewayMcpAuthMode: requestedMcpAuthMode ? 'env' : 'default',
      gatewayMcpApiKey: gatewayMcpApiKey ? 'env' : 'default',
      gatewayMcpToolDiscovery: gatewayMcpToolDiscovery ? 'env' : 'default',
      aiHubGatewayBaseUrl: gatewayBaseUrl ? 'env' : 'default',
      aiHubLlmApiUrl: gatewayLlmFromEnv || gatewayBaseUrl ? 'env' : 'default',
      aiHubMcpUrl: gatewayMcpFromEnv || gatewayBaseUrl ? 'env' : 'default',
      aiHubCatalogUrl: gatewayCatalogUrl ? 'env' : 'default',
      llmRoutingMode: requestedRoutingMode ? 'env' : 'default',
      deeplinkRedirectUrl: 'default',
    },
  };
}
