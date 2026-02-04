/**
 * Authentication types for browserx-chrome extension
 */

/**
 * Agent ready state with authentication mode information
 */
export interface AgentReadyState {
  ready: boolean;
  message?: string;
  provider?: string;
  model?: string;
  /** Current authentication mode */
  authMode: 'login' | 'api_key' | 'none';
}

/**
 * Auth manager interface for LLM routing decisions
 */
export interface IAuthManager {
  /**
   * Check if requests should be routed through backend
   * This is determined by useOwnApiKey setting (false = use backend)
   * @returns true if requests should route through backend
   */
  shouldUseBackend(): boolean;

  /**
   * Get backend LLM API URL
   * @returns Backend URL or null if not using backend routing
   */
  getBackendBaseUrl(): string | null;
}

/**
 * Auth manager implementation for LLM routing decisions
 *
 * Routing is determined by useOwnApiKey setting:
 * - useOwnApiKey=false → route through backend (shouldUseBackend=true)
 * - useOwnApiKey=true → use direct API with user's own key (shouldUseBackend=false)
 */
export class AuthManager implements IAuthManager {
  private _shouldUseBackend: boolean;
  private _backendBaseUrl: string | null;

  /**
   * Create an AuthManager
   * @param shouldUseBackend - Whether to route through backend (derived from !useOwnApiKey)
   * @param backendBaseUrl - Backend URL to use when routing through backend
   */
  constructor(shouldUseBackend: boolean, backendBaseUrl: string | null) {
    this._shouldUseBackend = shouldUseBackend;
    // Only set backend URL if using backend routing
    this._backendBaseUrl = shouldUseBackend ? backendBaseUrl : null;
  }

  /**
   * Check if requests should be routed through backend
   */
  shouldUseBackend(): boolean {
    return this._shouldUseBackend;
  }

  /**
   * Get backend LLM API URL
   */
  getBackendBaseUrl(): string | null {
    return this._backendBaseUrl;
  }
}

