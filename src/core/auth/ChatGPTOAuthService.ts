/**
 * ChatGPT OAuth Service
 *
 * Platform-agnostic PKCE OAuth logic for authenticating with OpenAI's
 * ChatGPT subscription via the Codex OAuth flow.
 *
 * Uses Authorization Code + PKCE (RFC 7636) with OpenAI's public client ID.
 * The access token is used as a drop-in replacement for API keys.
 *
 * @module core/auth/ChatGPTOAuthService
 */

/** OAuth token set obtained from OpenAI's auth server */
export interface ChatGPTTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Unix timestamp in ms when the access token expires */
  expiresAt: number;
}

/** Platform-specific storage adapter interface */
export interface ChatGPTOAuthStorage {
  getTokens(): Promise<ChatGPTTokens | null>;
  setTokens(tokens: ChatGPTTokens): Promise<void>;
  clearTokens(): Promise<void>;
}

// OpenAI OAuth constants
// Public client ID from OpenAI's Codex OAuth configuration (https://auth.openai.com)
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/callback';
const SCOPES = 'openid profile email';

/** Buffer time before expiry to trigger refresh (5 minutes in ms) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * ChatGPT OAuth Service
 *
 * Handles PKCE challenge generation, authorization URL building,
 * token exchange, and automatic token refresh with mutex protection.
 */
export class ChatGPTOAuthService {
  private storage: ChatGPTOAuthStorage;
  private refreshPromise: Promise<string> | null = null;

  constructor(storage: ChatGPTOAuthStorage) {
    this.storage = storage;
  }

  /**
   * Generate PKCE challenge pair for a new login flow.
   * Code verifier: 32 random bytes, base64url-encoded.
   * Code challenge: SHA-256 hash of verifier, base64url-encoded.
   */
  async generatePKCEChallenge(): Promise<{ codeVerifier: string; codeChallenge: string }> {
    const randomBytes = crypto.getRandomValues(new Uint8Array(32));
    const codeVerifier = base64UrlEncode(randomBytes);

    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const codeChallenge = base64UrlEncode(new Uint8Array(hashBuffer));

    return { codeVerifier, codeChallenge };
  }

  /**
   * Build the full authorization URL with PKCE and state params.
   */
  buildAuthorizationUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCodeForTokens(code: string, codeVerifier: string): Promise<ChatGPTTokens> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    const tokens: ChatGPTTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await this.storage.setTokens(tokens);
    return tokens;
  }

  /**
   * Refresh the access token using the refresh token.
   * Returns the new access token.
   */
  async refreshAccessToken(): Promise<string> {
    const tokens = await this.storage.getTokens();
    if (!tokens?.refreshToken) {
      throw new Error('No refresh token available');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: tokens.refreshToken,
    });

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      // Clear tokens on refresh failure (token likely revoked)
      await this.storage.clearTokens();
      throw new Error(`Token refresh failed (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    const newTokens: ChatGPTTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token || tokens.idToken,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    await this.storage.setTokens(newTokens);
    return newTokens.accessToken;
  }

  /**
   * Get a valid access token, auto-refreshing if near expiry.
   * Uses a promise-based mutex to prevent concurrent refreshes.
   */
  async getValidAccessToken(): Promise<string> {
    const tokens = await this.storage.getTokens();
    if (!tokens) {
      throw new Error('Not authenticated');
    }

    // If token is still valid (not within refresh buffer), return it
    if (tokens.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
      return tokens.accessToken;
    }

    // Token is expiring soon — refresh with mutex
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshAccessToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  /**
   * Check if authenticated (tokens exist and refresh token is usable).
   */
  async isAuthenticated(): Promise<boolean> {
    const tokens = await this.storage.getTokens();
    return tokens !== null && !!tokens.refreshToken;
  }

  /**
   * Clear all stored tokens (disconnect).
   */
  async logout(): Promise<void> {
    this.refreshPromise = null;
    await this.storage.clearTokens();
  }
}

/**
 * Base64url encode a Uint8Array (no padding, URL-safe).
 */
function base64UrlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
