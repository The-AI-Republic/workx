/**
 * Web Authentication Service
 *
 * Handles OAuth authentication for the Apple Pi web UI (server mode)
 * using a popup window + postMessage flow.
 *
 * Flow:
 * 1. Open popup to HOME_BASE_URL/login?redirect_url=HOME_BASE_URL/auth/web/callback
 * 2. User logs in via login page (Google OAuth, etc.)
 * 3. Backend redirects to /auth/web/callback?access_token=xxx&refresh_token=xxx
 * 4. Callback page sends tokens to opener via postMessage
 * 5. Web UI stores tokens in localStorage
 *
 * @module webfront/auth/WebAuthService
 */

const STORAGE_KEYS = {
  ACCESS: 'browserx_access_token',
  REFRESH: 'browserx_refresh_token',
} as const;

const WEB_CALLBACK_PATH = '/auth/web/callback';
const POPUP_CHECK_INTERVAL_MS = 500;

export interface UserSession {
  id?: number;
  user_id: string;
  email: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  is_active: boolean;
  is_verified: boolean;
  created_at?: string;
  updated_at?: string;
  last_login?: string;
  subscription?: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export interface AuthState {
  isAuthenticated: boolean;
  user: UserSession | null;
  loading: boolean;
  error: string | null;
}

interface TokenResponse {
  ok: boolean;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in?: number;
}

export class WebAuthService {
  private authBaseUrl: string;
  private popupWindow: Window | null = null;
  private popupCheckTimer: ReturnType<typeof setInterval> | null = null;
  private loginResolve: ((tokens: { accessToken: string; refreshToken: string }) => void) | null = null;
  private loginReject: ((error: Error) => void) | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private listeners: Set<() => void> = new Set();

  constructor(authBaseUrl: string) {
    this.authBaseUrl = authBaseUrl;
  }

  /**
   * Start the OAuth login flow via popup.
   *
   * IMPORTANT: This must be called from a direct user click handler
   * to avoid popup blockers.
   */
  async login(timeoutMs: number = 300000): Promise<UserSession> {
    const callbackUrl = `${this.authBaseUrl}${WEB_CALLBACK_PATH}`;
    const loginUrl = `${this.authBaseUrl}/login?redirect_url=${encodeURIComponent(callbackUrl)}`;

    // Open popup immediately (must be synchronous from click handler)
    this.popupWindow = window.open(
      loginUrl,
      'browserx-auth',
      'width=500,height=600,popup=yes',
    );

    if (!this.popupWindow) {
      throw new Error('Failed to open login popup — check your popup blocker settings');
    }

    const callbackPromise = new Promise<{ accessToken: string; refreshToken: string }>((resolve, reject) => {
      this.loginResolve = resolve;
      this.loginReject = reject;

      // Listen for postMessage from callback page
      this.messageHandler = (event: MessageEvent) => {
        // Validate origin
        if (event.origin !== this.authBaseUrl) return;
        if (!event.data || event.data.type !== 'auth-callback') return;

        const { access_token, refresh_token, error } = event.data;

        if (error || !access_token || !refresh_token) {
          this.rejectLogin(new Error(error || 'Missing tokens in callback'));
          return;
        }

        this.resolveLogin({ accessToken: access_token, refreshToken: refresh_token });
      };
      window.addEventListener('message', this.messageHandler);

      // Poll for popup closed (user closed window without completing login)
      this.popupCheckTimer = setInterval(() => {
        if (this.popupWindow && this.popupWindow.closed) {
          this.rejectLogin(new Error('Login popup was closed'));
        }
      }, POPUP_CHECK_INTERVAL_MS);

      // Timeout
      setTimeout(() => {
        this.rejectLogin(new Error('Login timed out'));
      }, timeoutMs);
    });

    const { accessToken, refreshToken } = await callbackPromise;

    this.storeTokens(accessToken, refreshToken);

    return this.getSessionWithToken(accessToken);
  }

  /**
   * Cancel an in-progress login flow.
   */
  cancelLogin(): void {
    this.rejectLogin(new Error('Login cancelled'));
  }

  /**
   * Get stored access token. Returns null if expired and refresh fails.
   */
  async getAccessToken(): Promise<string | null> {
    const token = localStorage.getItem(STORAGE_KEYS.ACCESS);
    if (!token) return null;

    if (!this.isTokenValid(token)) {
      try {
        await this.refreshTokens();
        return localStorage.getItem(STORAGE_KEYS.ACCESS);
      } catch {
        return null;
      }
    }
    return token;
  }

  async getRefreshToken(): Promise<string | null> {
    return localStorage.getItem(STORAGE_KEYS.REFRESH);
  }

  async hasValidToken(): Promise<boolean> {
    const token = localStorage.getItem(STORAGE_KEYS.ACCESS);
    if (!token) return false;

    if (this.isTokenValid(token)) return true;

    // Try refresh
    try {
      await this.refreshTokens();
      return true;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return localStorage.getItem(STORAGE_KEYS.ACCESS) !== null;
  }

  async getSession(): Promise<UserSession> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      throw new Error('Not authenticated');
    }
    return this.getSessionWithToken(accessToken);
  }

  async refreshTokens(): Promise<UserSession> {
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${this.authBaseUrl}/auth/desktop/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      await this.logout();
      throw new Error('Session expired, please login again');
    }

    const data: TokenResponse = await response.json();
    this.storeTokens(data.access_token, data.refresh_token);

    return this.getSessionWithToken(data.access_token);
  }

  async logout(): Promise<void> {
    localStorage.removeItem(STORAGE_KEYS.ACCESS);
    localStorage.removeItem(STORAGE_KEYS.REFRESH);
    this.notifyAuthChange();
  }

  async getAuthorizationHeader(): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    return accessToken ? `Bearer ${accessToken}` : null;
  }

  onAuthChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  notifyAuthChange(): void {
    for (const callback of this.listeners) {
      try {
        callback();
      } catch (error) {
        console.error('[WebAuthService] Error in auth change listener:', error);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Private
  // ─────────────────────────────────────────────────────────────────

  private storeTokens(accessToken: string, refreshToken: string): void {
    localStorage.setItem(STORAGE_KEYS.ACCESS, accessToken);
    localStorage.setItem(STORAGE_KEYS.REFRESH, refreshToken);
    this.notifyAuthChange();
  }

  private isTokenValid(token: string): boolean {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(atob(parts[1]));
      return payload.exp ? payload.exp * 1000 > Date.now() : true;
    } catch {
      return false;
    }
  }

  private async getSessionWithToken(accessToken: string): Promise<UserSession> {
    try {
      const response = await fetch(`${this.authBaseUrl}/auth/desktop/session`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (response.ok) {
        const user = await response.json();
        if (user) return user as UserSession;
      }

      if (response.status === 401) {
        return await this.refreshTokens();
      }
    } catch (error) {
      console.warn('[WebAuthService] Session API unavailable, using JWT decode:', error);
    }

    return this.decodeSessionFromJWT(accessToken);
  }

  private decodeSessionFromJWT(token: string): UserSession {
    try {
      const parts = token.split('.');
      if (parts.length !== 3) throw new Error('Invalid JWT format');

      const payload = JSON.parse(atob(parts[1]));
      return {
        user_id: payload.sub,
        email: payload.email || '',
        is_active: true,
        is_verified: true,
      };
    } catch (error) {
      throw new Error(`Failed to decode session from token: ${error}`);
    }
  }

  private resolveLogin(tokens: { accessToken: string; refreshToken: string }): void {
    if (this.loginResolve) {
      this.loginResolve(tokens);
    }
    this.cleanupLogin();
  }

  private rejectLogin(error: Error): void {
    if (this.loginReject) {
      this.loginReject(error);
    }
    this.cleanupLogin();
  }

  private cleanupLogin(): void {
    this.loginResolve = null;
    this.loginReject = null;

    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    if (this.popupCheckTimer) {
      clearInterval(this.popupCheckTimer);
      this.popupCheckTimer = null;
    }

    if (this.popupWindow && !this.popupWindow.closed) {
      this.popupWindow.close();
    }
    this.popupWindow = null;
  }
}

let instance: WebAuthService | null = null;

export function getWebAuthService(authBaseUrl?: string): WebAuthService {
  if (!instance) {
    if (!authBaseUrl) {
      throw new Error('authBaseUrl is required on first call to getWebAuthService');
    }
    instance = new WebAuthService(authBaseUrl);
  }
  return instance;
}
