import { resolveRuntimeUrls } from '@/config/runtimeUrls';
import { resolveAuthConfig } from '@/config/authConfig';

const runtimeUrls = resolveRuntimeUrls();
const authConfig = resolveAuthConfig();

export const HOME_PAGE_BASE_URL = runtimeUrls.homePageBaseUrl ?? '';
export const BACKEND_API_BASE_URL = runtimeUrls.backendApiBaseUrl ?? '';
export const AUTH_ROUTE_PATHS = authConfig.routes;

export const BACKEND_GENERAL_API = `${BACKEND_API_BASE_URL}/api/v1`;
export const LLM_API_URL = runtimeUrls.llmApiUrl ?? `${BACKEND_API_BASE_URL}/api/llm`;
export const AI_HUB_GATEWAY_BASE_URL = runtimeUrls.aiHubGatewayBaseUrl ?? '';
export const AI_HUB_LLM_API_URL = runtimeUrls.aiHubLlmApiUrl ?? '';
export const AI_HUB_MCP_URL = runtimeUrls.aiHubMcpUrl ?? '';
export const AI_HUB_CATALOG_URL = runtimeUrls.aiHubCatalogUrl ?? '';
export const LLM_ROUTING_MODE = runtimeUrls.llmRoutingMode;

export function buildHostedAuthUrl(path: string | null): string | null {
  if (!HOME_PAGE_BASE_URL || !path) return null;
  return new URL(path, HOME_PAGE_BASE_URL).toString();
}
