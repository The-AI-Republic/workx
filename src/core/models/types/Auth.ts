/**
 * Authentication types for pi
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
  authMode: 'login' | 'api_key' | 'chatgpt_oauth' | 'none';
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

  /**
   * Get the current access token for backend authentication.
   * Desktop apps must provide this since they don't have browser cookies.
   * Chrome extension can return null (cookies are sent via credentials: 'include').
   * @returns Access token or null
   */
  getAccessToken(): Promise<string | null>;

  /**
   * Check if ChatGPT OAuth is the active authentication method
   * @returns true if ChatGPT OAuth is active
   */
  isChatGPTOAuthActive?(): boolean;

  /**
   * Get a valid ChatGPT OAuth access token, auto-refreshing if near expiry
   * @returns Access token or null if not authenticated
   */
  getChatGPTAccessToken?(): Promise<string | null>;
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
  private _tokenGetter: (() => Promise<string | null>) | null;

  /**
   * Create an AuthManager
   * @param shouldUseBackend - Whether to route through backend (derived from !useOwnApiKey)
   * @param backendBaseUrl - Backend URL to use when routing through backend
   * @param tokenGetter - Optional async function to retrieve the access token (required for desktop)
   */
  constructor(shouldUseBackend: boolean, backendBaseUrl: string | null, tokenGetter?: () => Promise<string | null>) {
    this._shouldUseBackend = shouldUseBackend;
    // Only set backend URL if using backend routing
    this._backendBaseUrl = shouldUseBackend ? backendBaseUrl : null;
    this._tokenGetter = tokenGetter ?? null;
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

  /**
   * Get the current access token.
   * Returns token from tokenGetter if provided, null otherwise (Chrome extension uses cookies).
   */
  async getAccessToken(): Promise<string | null> {
    if (this._tokenGetter) {
      return this._tokenGetter();
    }
    return null;
  }
}

