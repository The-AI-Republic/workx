/**
 * Desktop Authentication Service
 *
 * Handles OAuth authentication for the Apple Pi desktop app using deep links.
 *
 * Flow:
 * 1. Open browser to HOME_BASE_URL/login?redirect_url=airepublic-pi://auth/callback
 * 2. User logs in via login page (Google OAuth, etc.)
 * 3. Backend redirects to airepublic-pi://auth/callback?access_token=xxx&refresh_token=xxx
 * 4. OS routes deep link to Apple Pi app
 * 5. Apple Pi app extracts tokens and stores them in OS keychain
 *
 * @module desktop/auth/DesktopAuthService
 */

import { open } from '@tauri-apps/plugin-shell';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { KeytarCredentialStore } from '../storage/KeytarCredentialStore';

/**
 * Service name for storing auth tokens
 */
const AUTH_SERVICE = 'auth';

/**
 * Account names for different token types
 */
const TOKEN_ACCOUNTS = {
  ACCESS: 'access_token',
  REFRESH: 'refresh_token',
} as const;

/**
 * Auth callback URL scheme
 */
const AUTH_CALLBACK_SCHEME = 'airepublic-pi://auth/callback';

/**
 * User session data returned from auth endpoints
 */
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

/**
 * Auth state for the application
 */
export interface AuthState {
  isAuthenticated: boolean;
  user: UserSession | null;
  loading: boolean;
  error: string | null;
}

/**
 * Token response from auth endpoints
 */
interface TokenResponse {
  ok: boolean;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in?: number;
}

/**
 * DesktopAuthService handles OAuth authentication for desktop apps
 */
export class DesktopAuthService {
  private credentialStore: KeytarCredentialStore;
  private authBaseUrl: string;
  private unlistenCallback: UnlistenFn | null = null;
  private authCallbackPromiseResolve: ((tokens: { accessToken: string; refreshToken: string }) => void) | null = null;
  private authCallbackPromiseReject: ((error: Error) => void) | null = null;
  private listeners: Set<() => void> = new Set();

  constructor(authBaseUrl: string) {
    this.credentialStore = new KeytarCredentialStore();
    this.authBaseUrl = authBaseUrl;
  }

  /**
   * Initialize the auth service and set up deep link listener.
   * Idempotent: safe to call multiple times — only one listener is ever registered.
   */
  async initialize(): Promise<void> {
    if (this.unlistenCallback) return;
    // Listen for auth callback deep links
    this.unlistenCallback = await listen<string>('auth-callback', (event) => {
      this.handleAuthCallback(event.payload);
    });
  }

  /**
   * Cancel an in-progress login flow.
   * Rejects the pending login promise so the caller's await unblocks immediately
   * and the deep link callback cannot silently authenticate the user afterwards.
   */
  cancelLogin(): void {
    if (this.authCallbackPromiseReject) {
      this.authCallbackPromiseReject(new Error('Login cancelled'));
      this.authCallbackPromiseResolve = null;
      this.authCallbackPromiseReject = null;
    }
  }

  /**
   * Clean up listeners
   */
  async dispose(): Promise<void> {
    if (this.unlistenCallback) {
      this.unlistenCallback();
      this.unlistenCallback = null;
    }
  }

  /**
   * Start the OAuth login flow
   *
   * Opens the browser to the login page with a deep link callback URL.
   * Returns a promise that resolves when the user completes login and
   * the app receives the callback.
   *
   * @param timeoutMs - Timeout in milliseconds (default: 5 minutes)
   * @returns Promise that resolves to the user session
   */
  async login(timeoutMs: number = 300000): Promise<UserSession> {
    // Build the login URL with deep link callback (same /login page as extension)
    const loginUrl = `${this.authBaseUrl}/login?redirect_url=${encodeURIComponent(AUTH_CALLBACK_SCHEME)}`;

    // Create a promise that will be resolved by the callback handler
    const callbackPromise = new Promise<{ accessToken: string; refreshToken: string }>((resolve, reject) => {
      this.authCallbackPromiseResolve = resolve;
      this.authCallbackPromiseReject = reject;

      // Set up timeout
      setTimeout(() => {
        if (this.authCallbackPromiseReject) {
          this.authCallbackPromiseReject(new Error('Login timed out'));
          this.authCallbackPromiseResolve = null;
          this.authCallbackPromiseReject = null;
        }
      }, timeoutMs);
    });

    // Open browser to login page
    await open(loginUrl);

    // Wait for the callback
    const { accessToken, refreshToken } = await callbackPromise;

    // Store tokens in OS keychain and fetch session in parallel
    await this.storeTokens(accessToken, refreshToken);

    // Get user session using the token we already have (avoids keychain round-trip)
    return this.getSessionWithToken(accessToken);
  }

  /**
   * Register a callback to be notified when auth state changes
   */
  onAuthChange(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Notify all listeners of auth state change
   * Public to allow other components (like App.svelte) to trigger updates on successful load
   */
  notifyAuthChange(): void {
    this.listeners.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('[DesktopAuthService] Error in auth change listener:', error);
      }
    });
  }

  /**
   * Handle the OAuth callback deep link
   *
   * @param url - The full callback URL with tokens
   */
  private async handleAuthCallback(url: string): Promise<void> {
    try {
      console.log('[DesktopAuthService] Received auth callback');

      // Parse the URL to extract tokens
      const urlObj = new URL(url);
      const accessToken = urlObj.searchParams.get('access_token');
      const refreshToken = urlObj.searchParams.get('refresh_token');

      if (!accessToken || !refreshToken) {
        const error = urlObj.searchParams.get('error') || 'Missing tokens in callback';
        console.error('[DesktopAuthService] Auth callback error:', error);
        if (this.authCallbackPromiseReject) {
          this.authCallbackPromiseReject(new Error(error));
        }
        return;
      }

      // Always store tokens, regardless of whether we initiated the login
      // This handles the case where the user clicks "Log in" link directly (managed outside this service)
      await this.storeTokens(accessToken, refreshToken);
      console.log('[DesktopAuthService] Tokens stored from callback');

      // Resolve the login promise if it exists
      if (this.authCallbackPromiseResolve) {
        this.authCallbackPromiseResolve({ accessToken, refreshToken });
      } else {
        console.log('[DesktopAuthService] Auth callback handled (implicit flow)');
      }
    } catch (error) {
      console.error('[DesktopAuthService] Error parsing auth callback:', error);
      if (this.authCallbackPromiseReject) {
        this.authCallbackPromiseReject(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      // Clear the promise callbacks
      this.authCallbackPromiseResolve = null;
      this.authCallbackPromiseReject = null;
    }
  }

  /**
   * Store authentication tokens in OS keychain
   */
  private async storeTokens(accessToken: string, refreshToken: string): Promise<void> {
    await Promise.all([
      this.credentialStore.set(AUTH_SERVICE, TOKEN_ACCOUNTS.ACCESS, accessToken),
      this.credentialStore.set(AUTH_SERVICE, TOKEN_ACCOUNTS.REFRESH, refreshToken),
    ]);
    this.notifyAuthChange();
  }

  /**
   * Get stored access token
   */
  async getAccessToken(): Promise<string | null> {
    return this.credentialStore.get(AUTH_SERVICE, TOKEN_ACCOUNTS.ACCESS);
  }

  /**
   * Get stored refresh token
   */
  async getRefreshToken(): Promise<string | null> {
    return this.credentialStore.get(AUTH_SERVICE, TOKEN_ACCOUNTS.REFRESH);
  }

  /**
   * Check if user is authenticated (has stored tokens)
   */
  async isAuthenticated(): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    return accessToken !== null;
  }

  /**
   * Get the current user session
   *
   * @returns User session or null if not authenticated
   */
  async getSession(): Promise<UserSession> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      throw new Error('Not authenticated');
    }
    return this.getSessionWithToken(accessToken);
  }

  /**
   * Check if user has a valid (non-expired) access token
   */
  async hasValidToken(): Promise<boolean> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) return false;

    try {
      const parts = accessToken.split('.');
      if (parts.length !== 3) return false;
      const payload = JSON.parse(atob(parts[1]));
      return payload.exp ? payload.exp * 1000 > Date.now() : true;
    } catch {
      return false;
    }
  }

  /**
   * Get user session using a provided access token.
   * Tries the session API first, falls back to decoding the JWT directly.
   */
  private async getSessionWithToken(accessToken: string): Promise<UserSession> {
    try {
      const response = await fetch(`${this.authBaseUrl}/auth/desktop/session`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (response.ok) {
        const user = await response.json();
        if (user) return user as UserSession;
      }

      if (response.status === 401) {
        const newSession = await this.refreshTokens();
        return newSession;
      }
    } catch (error) {
      console.warn('[DesktopAuthService] Session API unavailable, using JWT decode:', error);
    }

    // Fallback: decode JWT payload directly
    return this.decodeSessionFromJWT(accessToken);
  }

  /**
   * Extract user session from JWT payload
   */
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

  /**
   * Refresh authentication tokens
   *
   * @returns New user session after refresh
   */
  async refreshTokens(): Promise<UserSession> {
    const refreshToken = await this.getRefreshToken();
    if (!refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch(`${this.authBaseUrl}/auth/desktop/refresh`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) {
      // Clear stored tokens on refresh failure
      await this.logout();
      throw new Error('Session expired, please login again');
    }

    const data: TokenResponse = await response.json();

    // Store new tokens
    await this.storeTokens(data.access_token, data.refresh_token);

    // Get updated session
    return this.getSession();
  }

  /**
   * Logout and clear stored tokens
   */
  async logout(): Promise<void> {
    await Promise.all([
      this.credentialStore.delete(AUTH_SERVICE, TOKEN_ACCOUNTS.ACCESS),
      this.credentialStore.delete(AUTH_SERVICE, TOKEN_ACCOUNTS.REFRESH),
    ]);
    this.notifyAuthChange();
  }

  /**
   * Get authorization header for API requests
   *
   * @returns Authorization header value or null if not authenticated
   */
  async getAuthorizationHeader(): Promise<string | null> {
    const accessToken = await this.getAccessToken();
    if (!accessToken) {
      return null;
    }
    return `Bearer ${accessToken}`;
  }
}

/**
 * Singleton instance of DesktopAuthService
 */
let authServiceInstance: DesktopAuthService | null = null;

/**
 * Get or create the DesktopAuthService singleton
 *
 * @param authBaseUrl - Base URL for auth endpoints (required on first call)
 * @returns DesktopAuthService instance
 */
export function getDesktopAuthService(authBaseUrl?: string): DesktopAuthService {
  if (!authServiceInstance) {
    if (!authBaseUrl) {
      throw new Error('authBaseUrl is required on first call to getDesktopAuthService');
    }
    authServiceInstance = new DesktopAuthService(authBaseUrl);
  }
  return authServiceInstance;
}
