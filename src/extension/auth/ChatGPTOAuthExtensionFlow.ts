/**
 * ChatGPT OAuth Extension Flow
 *
 * Coordinates the extension OAuth login flow:
 * 1. Generate PKCE challenge
 * 2. Build authorization URL
 * 3. Open auth URL in a new tab
 * 4. Monitor tab URL for the redirect callback
 * 5. Extract authorization code from redirect URL
 * 6. Close the tab
 * 7. Exchange code for tokens
 *
 * @module extension/auth/ChatGPTOAuthExtensionFlow
 */

import { ChatGPTOAuthService, type ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';

const CALLBACK_URL_PREFIX = 'http://localhost:1455/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class ChatGPTOAuthExtensionFlow {
  private oauthService: ChatGPTOAuthService;
  private isInProgress = false;

  constructor(oauthService: ChatGPTOAuthService) {
    this.oauthService = oauthService;
  }

  /**
   * Start the OAuth login flow via tab-based redirect.
   */
  async login(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ChatGPTTokens> {
    if (this.isInProgress) {
      throw new Error('OAuth login already in progress');
    }

    this.isInProgress = true;
    let authTabId: number | undefined;
    let tabUpdateListener: ((tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) | null = null;

    try {
      // 1. Generate PKCE challenge
      const { codeVerifier, codeChallenge } = await this.oauthService.generatePKCEChallenge();

      // 2. Generate random state for CSRF protection
      const state = crypto.randomUUID();

      // 3. Build authorization URL
      const authUrl = this.oauthService.buildAuthorizationUrl(state, codeChallenge);

      // 4. Open auth URL in a new tab
      const tab = await chrome.tabs.create({ url: authUrl });
      authTabId = tab.id;

      // 5. Wait for the redirect with timeout
      const { code, receivedState } = await new Promise<{ code: string; receivedState: string }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('OAuth callback timed out'));
          }, timeoutMs);

          tabUpdateListener = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
            if (tabId !== authTabId || !changeInfo.url) return;

            if (changeInfo.url.startsWith(CALLBACK_URL_PREFIX)) {
              clearTimeout(timeout);
              try {
                const url = new URL(changeInfo.url);
                const code = url.searchParams.get('code');
                const receivedState = url.searchParams.get('state');

                if (!code) {
                  reject(new Error("Missing 'code' parameter in callback"));
                  return;
                }
                if (!receivedState) {
                  reject(new Error("Missing 'state' parameter in callback"));
                  return;
                }

                resolve({ code, receivedState });
              } catch (err) {
                reject(err);
              }
            }
          };

          const cleanup = () => {
            if (tabUpdateListener) {
              chrome.tabs.onUpdated.removeListener(tabUpdateListener);
              tabUpdateListener = null;
            }
          };

          chrome.tabs.onUpdated.addListener(tabUpdateListener);
        }
      );

      // 6. Close the auth tab
      if (authTabId !== undefined) {
        try {
          await chrome.tabs.remove(authTabId);
        } catch {
          // Tab may have already been closed
        }
      }

      // 7. Validate state parameter
      if (receivedState !== state) {
        throw new Error('OAuth state mismatch — possible CSRF attack');
      }

      // 8. Exchange code for tokens
      return await this.oauthService.exchangeCodeForTokens(code, codeVerifier);
    } finally {
      // Cleanup
      if (tabUpdateListener) {
        chrome.tabs.onUpdated.removeListener(tabUpdateListener);
      }
      this.isInProgress = false;
    }
  }

  get loginInProgress(): boolean {
    return this.isInProgress;
  }
}
