import { resolveRuntimeUrls } from '@/config/runtimeUrls';

const runtimeUrls = resolveRuntimeUrls();

export const GATEWAY_BASE_URL = runtimeUrls.gatewayBaseUrl ?? '';
export const GATEWAY_LLM_API_URL = runtimeUrls.gatewayLlmApiUrl ?? '';
export const GATEWAY_MCP_URL = runtimeUrls.gatewayMcpUrl ?? '';
export const GATEWAY_CATALOG_URL = runtimeUrls.gatewayCatalogUrl ?? '';
/** Hub Apps catalog JSON API root, e.g. `https://hub.example.com/api/v1/apps`. */
export const GATEWAY_CATALOG_API_BASE_URL = runtimeUrls.gatewayCatalogApiBaseUrl ?? '';
export const LLM_ROUTING_MODE = runtimeUrls.llmRoutingMode;
