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
  authMode: 'api_key' | 'chatgpt_oauth' | 'none';
}

/**
 * Auth manager interface for LLM routing decisions
 */
export interface IAuthManager {
  /**
   * Get the OpenAI-compatible gateway base URL when gateway routing is enabled.
   * The URL is expected to be the API root (for example, https://hub.example.com/v1).
   */
  getGatewayLlmBaseUrl?(): string | null;

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
 * OSS credential state for API-key gateway routing and ChatGPT provider OAuth.
 * Product-account sessions are implemented by private distributions.
 */
export class AuthManager implements IAuthManager {
  private _gatewayLlmBaseUrl: string | null;
  private _chatGPTOAuthActive: boolean;
  private _chatGPTTokenGetter: (() => Promise<string | null>) | null;

  constructor(options?: { gatewayLlmBaseUrl?: string | null }) {
    this._gatewayLlmBaseUrl = options?.gatewayLlmBaseUrl ?? null;
    this._chatGPTOAuthActive = false;
    this._chatGPTTokenGetter = null;
  }

  /**
   * Get gateway LLM URL for gateway routing.
   */
  getGatewayLlmBaseUrl(): string | null {
    return this._gatewayLlmBaseUrl;
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
