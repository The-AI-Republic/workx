/**
 * Shared constants for backend API URLs
 * These are used by both the service worker and the sidepanel
 */

// Backend API base URL from environment, with fallback
export const BACKEND_API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_API_BASE_URL) || '';

// Legacy in-house LLM endpoint (ai-assistant) for backend/cookie routing.
// DEPRECATED: superseded by the AI Hub gateway. The gateway URL + routing mode are
// resolved via resolveRuntimeUrls() (single source of truth, used by both extension
// chat routing and desktop memory routing) rather than a parallel copy here.
export const LLM_API_URL = `${BACKEND_API_BASE_URL}/api/llm`;
