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
   * Get the AI Hub OpenAI-compatible base URL when first-party gateway routing is enabled.
   * The URL is expected to be the API root (for example, https://hub.example.com/v1).
   */
  getGatewayLlmBaseUrl?(): string | null;

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
  private _gatewayLlmBaseUrl: string | null;
  private _chatGPTOAuthActive: boolean;
  private _chatGPTTokenGetter: (() => Promise<string | null>) | null;

  /**
   * Create an AuthManager
   * @param shouldUseBackend - Whether to route through backend (derived from !useOwnApiKey)
   * @param backendBaseUrl - Backend URL to use when routing through backend
   * @param tokenGetter - Optional async function to retrieve the access token (required for desktop)
   */
  constructor(
    shouldUseBackend: boolean,
    backendBaseUrl: string | null,
    tokenGetter?: () => Promise<string | null>,
    options?: { gatewayLlmBaseUrl?: string | null },
  ) {
    this._shouldUseBackend = shouldUseBackend;
    // Only set backend URL if using backend routing
    this._backendBaseUrl = shouldUseBackend ? backendBaseUrl : null;
    this._tokenGetter = tokenGetter ?? null;
    this._gatewayLlmBaseUrl = shouldUseBackend ? options?.gatewayLlmBaseUrl ?? null : null;
    this._chatGPTOAuthActive = false;
    this._chatGPTTokenGetter = null;
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
   * Get AI Hub gateway LLM URL for first-party routing.
   */
  getGatewayLlmBaseUrl(): string | null {
    return this._gatewayLlmBaseUrl;
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

  /**
   * Configure ChatGPT OAuth on this auth manager.
   * @param tokenGetter - Async function that returns a valid ChatGPT OAuth access token
   */
  setChatGPTOAuth(tokenGetter: () => Promise<string | null>): void {
    this._chatGPTOAuthActive = true;
    this._chatGPTTokenGetter = tokenGetter;
  }

  /**
   * Clear ChatGPT OAuth configuration.
   */
  clearChatGPTOAuth(): void {
    this._chatGPTOAuthActive = false;
    this._chatGPTTokenGetter = null;
  }

  isChatGPTOAuthActive(): boolean {
    return this._chatGPTOAuthActive;
  }

  async getChatGPTAccessToken(): Promise<string | null> {
    if (this._chatGPTTokenGetter) {
      return this._chatGPTTokenGetter();
    }
    return null;
  }
}
