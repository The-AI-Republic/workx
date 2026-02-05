/**
 * Desktop Authentication Service
 *
 * Handles OAuth authentication for the Pi desktop app using deep links.
 *
 * Flow:
 * 1. Open browser to HOME_BASE_URL/auth/login/google?redirect_url=airepublic-pi://auth/callback
 * 2. User logs in via Google OAuth
 * 3. Backend redirects to airepublic-pi://auth/callback?access_token=xxx&refresh_token=xxx
 * 4. OS routes deep link to Pi app
 * 5. Pi app extracts tokens and stores them in OS keychain
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

  constructor(authBaseUrl: string) {
    this.credentialStore = new KeytarCredentialStore();
    this.authBaseUrl = authBaseUrl;
  }

  /**
   * Initialize the auth service and set up deep link listener
   */
  async initialize(): Promise<void> {
    // Listen for auth callback deep links
    this.unlistenCallback = await listen<string>('auth-callback', (event) => {
      this.handleAuthCallback(event.payload);
    });
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
    // Build the login URL with deep link callback
    const loginUrl = `${this.authBaseUrl}/auth/login/google?redirect_url=${encodeURIComponent(AUTH_CALLBACK_SCHEME)}`;

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

    // Store tokens in OS keychain
    await this.storeTokens(accessToken, refreshToken);

    // Get user session
    return this.getSession();
  }

  /**
   * Handle the OAuth callback deep link
   *
   * @param url - The full callback URL with tokens
   */
  private handleAuthCallback(url: string): void {
    try {
      console.log('[DesktopAuthService] Received auth callback:', url.substring(0, 50) + '...');

      // Parse the URL to extract tokens
      const urlObj = new URL(url);
      const accessToken = urlObj.searchParams.get('access_token');
      const refreshToken = urlObj.searchParams.get('refresh_token');

      if (!accessToken || !refreshToken) {
        const error = urlObj.searchParams.get('error') || 'Missing tokens in callback';
        if (this.authCallbackPromiseReject) {
          this.authCallbackPromiseReject(new Error(error));
        }
        return;
      }

      // Resolve the login promise
      if (this.authCallbackPromiseResolve) {
        this.authCallbackPromiseResolve({ accessToken, refreshToken });
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

    const response = await fetch(`${this.authBaseUrl}/auth/desktop/session`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Try to refresh token
        const newSession = await this.refreshTokens();
        return newSession;
      }
      throw new Error(`Failed to get session: ${response.status}`);
    }

    const user = await response.json();
    if (!user) {
      throw new Error('No user session');
    }

    return user as UserSession;
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
