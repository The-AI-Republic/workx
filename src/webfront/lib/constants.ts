import { resolveRuntimeUrls } from '@/config/runtimeUrls';
import { resolveAuthConfig } from '@/config/authConfig';

const runtimeUrls = resolveRuntimeUrls();
const authConfig = resolveAuthConfig();

export const HOME_PAGE_BASE_URL = runtimeUrls.homePageBaseUrl ?? '';
export const BACKEND_API_BASE_URL = runtimeUrls.backendApiBaseUrl ?? '';
export const AUTH_ROUTE_PATHS = authConfig.routes;

/** Default OIDC endpoints when not overridden via VITE_AUTH_*_PATH. */
export const AUTH_OIDC_AUTHORIZE_PATH = AUTH_ROUTE_PATHS.authorize ?? '/auth/authorize';
export const AUTH_OIDC_TOKEN_PATH = AUTH_ROUTE_PATHS.token ?? '/auth/token';
/** Public desktop OIDC client id (PKCE). */
export const AUTH_OIDC_CLIENT_ID = authConfig.oidcClientId ?? 'workx-desktop';
/**
 * Kill-switch for desktop OIDC+PKCE login (default OFF). Enable per-environment
 * once the hosted `workx-desktop` OIDC client is registered; otherwise the
 * legacy desktop-token flow is used so login never hard-breaks pre-registration.
 */
export const AUTH_OIDC_ENABLED = authConfig.oidcEnabled;
/**
 * OIDC scopes requested at authorize time. Defaults to the identity scopes;
 * override via `WORKX_/VITE_AUTH_OIDC_SCOPES` (e.g. add `chat apps models`) so
 * the issued token carries the `svc:hub` audience required by the Hub gateway.
 */
export const AUTH_OIDC_SCOPES = authConfig.oidcScopes ?? 'openid profile email';
/** Custom-scheme deep-link the desktop registers for the OIDC redirect. */
export const DESKTOP_OIDC_REDIRECT_URI = 'workx://auth/callback';

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
