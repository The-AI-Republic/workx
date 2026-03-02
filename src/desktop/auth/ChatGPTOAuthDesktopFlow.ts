/**
 * ChatGPT OAuth Desktop Flow
 *
 * Coordinates the desktop OAuth login flow:
 * 1. Generate PKCE challenge
 * 2. Build authorization URL
 * 3. Start Rust callback server via Tauri command
 * 4. Open browser to auth URL
 * 5. Wait for callback with authorization code
 * 6. Exchange code for tokens
 *
 * @module desktop/auth/ChatGPTOAuthDesktopFlow
 */

import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { ChatGPTOAuthService, type ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';

interface OAuthCallbackResult {
  code: string;
  state: string;
}

/** Default timeout for the OAuth flow (5 minutes) */
const DEFAULT_TIMEOUT_SECS = 300;

export class ChatGPTOAuthDesktopFlow {
  private oauthService: ChatGPTOAuthService;
  private isInProgress = false;

  constructor(oauthService: ChatGPTOAuthService) {
    this.oauthService = oauthService;
  }

  /**
   * Start the OAuth login flow.
   * Opens the browser, waits for callback, exchanges code for tokens.
   * @returns The obtained tokens
   * @throws If flow fails, times out, or state mismatch
   */
  async login(timeoutSecs: number = DEFAULT_TIMEOUT_SECS): Promise<ChatGPTTokens> {
    if (this.isInProgress) {
      throw new Error('OAuth login already in progress');
    }

    this.isInProgress = true;
    try {
      // 1. Generate PKCE challenge
      const { codeVerifier, codeChallenge } = await this.oauthService.generatePKCEChallenge();

      // 2. Generate random state for CSRF protection
      const state = crypto.randomUUID();

      // 3. Build authorization URL
      const authUrl = this.oauthService.buildAuthorizationUrl(state, codeChallenge);

      // 4. Start the Rust callback server (before opening browser)
      const callbackPromise = invoke<OAuthCallbackResult>('start_oauth_callback_server', {
        timeoutSecs,
      });

      // 5. Open the browser to the auth URL
      await open(authUrl);

      // 6. Wait for the callback
      const result = await callbackPromise;

      // 7. Validate state parameter (CSRF protection)
      if (result.state !== state) {
        throw new Error('OAuth state mismatch — possible CSRF attack');
      }

      // 8. Exchange code for tokens
      const tokens = await this.oauthService.exchangeCodeForTokens(result.code, codeVerifier);

      return tokens;
    } finally {
      this.isInProgress = false;
    }
  }

  /**
   * Check if a login flow is currently in progress.
   */
  get loginInProgress(): boolean {
    return this.isInProgress;
  }
}
