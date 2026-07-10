/**
 * Shared constants for backend + gateway API URLs
 * These are used by both the service worker and the sidepanel
 */

// Backend API base URL from environment, with fallback
export const BACKEND_API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_API_BASE_URL) || '';

// Legacy in-house LLM endpoint (ai-assistant) for backend/cookie routing.
// DEPRECATED: superseded by the AI Hub gateway (GATEWAY_LLM_API_URL). Retained as a
// fallback while the extension migrates account-credits LLM to the gateway.
export const LLM_API_URL = `${BACKEND_API_BASE_URL}/api/llm`;

// AI Hub gateway base URL (OpenAI-compatible LLM + MCP) from environment.
export const GATEWAY_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GATEWAY_BASE_URL) || '';

// Gateway OpenAI-compatible LLM endpoint root (/v1). Empty when unconfigured.
export const GATEWAY_LLM_API_URL = GATEWAY_BASE_URL
  ? `${GATEWAY_BASE_URL.replace(/\/+$/, '')}/v1`
  : '';

// Extension LLM routing mode. 'gateway' routes account-credits LLM through the AI
// Hub gateway (metered on the unified wallet); 'legacy' uses the deprecated
// ai-assistant /api/llm path. Defaults to 'gateway' when a gateway URL is set.
export const LLM_ROUTING_MODE: 'gateway' | 'legacy' =
  ((typeof import.meta !== 'undefined' && import.meta.env?.VITE_LLM_ROUTING_MODE) as
    | 'gateway'
    | 'legacy'
    | undefined) ?? (GATEWAY_LLM_API_URL ? 'gateway' : 'legacy');
