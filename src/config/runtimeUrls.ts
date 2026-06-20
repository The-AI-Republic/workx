import { resolveAuthConfig } from './authConfig';

export type RuntimeUrlSource = 'env' | 'default';

export interface RuntimeUrlConfig {
  homePageBaseUrl: string | null;
  backendApiBaseUrl: string | null;
  llmApiUrl: string | null;
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
  const aiHubGatewayBaseUrl = firstNonEmpty(
    env.WORKX_AI_HUB_GATEWAY_BASE_URL,
    env.WORKX_HUB_GATEWAY_BASE_URL,
    env.VITE_AI_HUB_GATEWAY_BASE_URL,
    env.VITE_HUB_GATEWAY_BASE_URL,
    vite.VITE_AI_HUB_GATEWAY_BASE_URL,
    vite.VITE_HUB_GATEWAY_BASE_URL,
  ) ?? null;
  const aiHubLlmFromEnv = firstNonEmpty(
    env.WORKX_AI_HUB_LLM_API_URL,
    env.WORKX_HUB_LLM_API_URL,
    env.VITE_AI_HUB_LLM_API_URL,
    env.VITE_HUB_LLM_API_URL,
    vite.VITE_AI_HUB_LLM_API_URL,
    vite.VITE_HUB_LLM_API_URL,
  );
  const aiHubMcpFromEnv = firstNonEmpty(
    env.WORKX_AI_HUB_MCP_URL,
    env.WORKX_HUB_MCP_URL,
    env.VITE_AI_HUB_MCP_URL,
    env.VITE_HUB_MCP_URL,
    vite.VITE_AI_HUB_MCP_URL,
    vite.VITE_HUB_MCP_URL,
  );
  const aiHubCatalogUrl = firstNonEmpty(
    env.WORKX_AI_HUB_CATALOG_URL,
    env.WORKX_HUB_CATALOG_URL,
    env.VITE_AI_HUB_CATALOG_URL,
    env.VITE_HUB_CATALOG_URL,
    vite.VITE_AI_HUB_CATALOG_URL,
    vite.VITE_HUB_CATALOG_URL,
  ) ?? null;
  const aiHubLlmApiUrl = aiHubLlmFromEnv ?? (aiHubGatewayBaseUrl ? joinUrl(aiHubGatewayBaseUrl, '/v1') : null);
  const aiHubMcpUrl = aiHubMcpFromEnv ?? (aiHubGatewayBaseUrl ? joinUrl(aiHubGatewayBaseUrl, '/mcp') : null);
  const requestedRoutingMode = normalizeRoutingMode(firstNonEmpty(
    env.WORKX_LLM_ROUTING_MODE,
    env.VITE_LLM_ROUTING_MODE,
    vite.VITE_LLM_ROUTING_MODE,
  ));
  const llmRoutingMode = requestedRoutingMode ?? (aiHubLlmApiUrl ? 'ai-hub' : 'legacy');

  return {
    homePageBaseUrl: authConfig.authBaseUrl,
    backendApiBaseUrl,
    llmApiUrl: backendApiBaseUrl ? `${backendApiBaseUrl}/api/llm` : '/api/llm',
    aiHubGatewayBaseUrl,
    aiHubLlmApiUrl,
    aiHubMcpUrl,
    aiHubCatalogUrl,
    llmRoutingMode,
    deeplinkRedirectUrl: 'workx://auth/callback',
    source: {
      homePageBaseUrl: authConfig.source.authBaseUrl,
      backendApiBaseUrl: backendFromEnv ? 'env' : 'default',
      llmApiUrl: backendFromEnv ? 'env' : 'default',
      aiHubGatewayBaseUrl: aiHubGatewayBaseUrl ? 'env' : 'default',
      aiHubLlmApiUrl: aiHubLlmFromEnv || aiHubGatewayBaseUrl ? 'env' : 'default',
      aiHubMcpUrl: aiHubMcpFromEnv || aiHubGatewayBaseUrl ? 'env' : 'default',
      aiHubCatalogUrl: aiHubCatalogUrl ? 'env' : 'default',
      llmRoutingMode: requestedRoutingMode ? 'env' : 'default',
      deeplinkRedirectUrl: 'default',
    },
  };
}
