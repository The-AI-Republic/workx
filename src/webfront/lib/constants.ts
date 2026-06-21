import { resolveRuntimeUrls } from '@/config/runtimeUrls';
import { resolveAuthConfig } from '@/config/authConfig';

const runtimeUrls = resolveRuntimeUrls();
const authConfig = resolveAuthConfig();

export const HOME_PAGE_BASE_URL = runtimeUrls.homePageBaseUrl ?? '';
export const BACKEND_API_BASE_URL = runtimeUrls.backendApiBaseUrl ?? '';
export const AUTH_ROUTE_PATHS = authConfig.routes;

export const BACKEND_GENERAL_API = `${BACKEND_API_BASE_URL}/api/v1`;
export const LLM_API_URL = runtimeUrls.llmApiUrl ?? `${BACKEND_API_BASE_URL}/api/llm`;
export const GATEWAY_BASE_URL = runtimeUrls.gatewayBaseUrl ?? '';
export const GATEWAY_LLM_API_URL = runtimeUrls.gatewayLlmApiUrl ?? '';
export const GATEWAY_MCP_URL = runtimeUrls.gatewayMcpUrl ?? '';
export const GATEWAY_CATALOG_URL = runtimeUrls.gatewayCatalogUrl ?? '';
export const LLM_ROUTING_MODE = runtimeUrls.llmRoutingMode;

export function buildHostedAuthUrl(path: string | null): string | null {
  if (!HOME_PAGE_BASE_URL || !path) return null;
  return new URL(path, HOME_PAGE_BASE_URL).toString();
}
