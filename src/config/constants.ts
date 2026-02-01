/**
 * Shared constants for backend API URLs
 * These are used by both the service worker and the sidepanel
 */

// Backend API base URL from environment, with fallback
export const BACKEND_API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_BACKEND_API_BASE_URL) || '';

// LLM API endpoint for backend routing
export const LLM_API_URL = `${BACKEND_API_BASE_URL}/api/llm`;
