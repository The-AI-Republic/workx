/**
 * ChatGPT OAuth Extension Flow
 *
 * Coordinates the extension OAuth login flow using declarativeNetRequest
 * to cleanly intercept the localhost callback and redirect to an
 * extension-bundled success page:
 *
 * 1. Generate PKCE challenge
 * 2. Build authorization URL
 * 3. Install declarativeNetRequest redirect rule
 * 4. Open auth URL in a new tab
 * 5. declarativeNetRequest intercepts localhost callback → redirects to oauth-success.html
 * 6. oauth-success.html sends code/state to service worker via runtime.sendMessage
 * 7. Close the tab, remove redirect rule
 * 8. Exchange code for tokens
 *
 * @module extension/auth/ChatGPTOAuthExtensionFlow
 */

import { ChatGPTOAuthService, type ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';

const OAUTH_REDIRECT_RULE_ID = 999990;
const KEEPALIVE_ALARM_NAME = 'oauth-keepalive';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

async function installOAuthRedirectRule(): Promise<void> {
  const successPageUrl = chrome.runtime.getURL('oauth-success.html');
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_REDIRECT_RULE_ID],
    addRules: [
      {
        id: OAUTH_REDIRECT_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: {
            regexSubstitution: successPageUrl + '\\1',
          },
        },
        condition: {
          regexFilter: '^http://localhost:1455/auth/callback(\\?.*)?$',
          resourceTypes: [
            chrome.declarativeNetRequest.ResourceType.MAIN_FRAME,
          ],
        },
      },
    ],
  });
}

async function removeOAuthRedirectRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_REDIRECT_RULE_ID],
  });
}

export class ChatGPTOAuthExtensionFlow {
  private oauthService: ChatGPTOAuthService;
  private isInProgress = false;

  constructor(oauthService: ChatGPTOAuthService) {
    this.oauthService = oauthService;
  }

  /**
   * Start the OAuth login flow via declarativeNetRequest redirect.
   */
  async login(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<ChatGPTTokens> {
    if (this.isInProgress) {
      throw new Error('OAuth login already in progress');
    }

    this.isInProgress = true;
    let authTabId: number | undefined;
    let messageListener: ((message: any, sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => void) | null = null;
    let tabRemovedListener: ((tabId: number, removeInfo: chrome.tabs.OnRemovedInfo) => void) | null = null;

    try {
      // 1. Generate PKCE challenge
      const { codeVerifier, codeChallenge } = await this.oauthService.generatePKCEChallenge();

      // 2. Generate random state for CSRF protection
      const state = crypto.randomUUID();

      // 3. Build authorization URL
      const authUrl = this.oauthService.buildAuthorizationUrl(state, codeChallenge);

      // 4. Install declarativeNetRequest redirect rule
      await installOAuthRedirectRule();

      // 5. Keep service worker alive during OAuth flow
      await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.4 });

      // 6. Open auth URL in a new tab
      const tab = await chrome.tabs.create({ url: authUrl });
      authTabId = tab.id;

      // 7. Wait for the callback message from oauth-success.html
      const { code, receivedState } = await new Promise<{ code: string; receivedState: string }>(
        (resolve, reject) => {
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('OAuth callback timed out'));
          }, timeoutMs);

          const cleanup = () => {
            clearTimeout(timeout);
            if (messageListener) {
              chrome.runtime.onMessage.removeListener(messageListener);
              messageListener = null;
            }
            if (tabRemovedListener) {
              chrome.tabs.onRemoved.removeListener(tabRemovedListener);
              tabRemovedListener = null;
            }
          };

          // Listen for the OAUTH_CALLBACK message from oauth-success.html
          messageListener = (message: any) => {
            if (message?.type !== 'OAUTH_CALLBACK') return;

            const { code, state: receivedState } = message;

            if (!code) {
              cleanup();
              reject(new Error("Missing 'code' parameter in callback"));
              return;
            }
            if (!receivedState) {
              cleanup();
              reject(new Error("Missing 'state' parameter in callback"));
              return;
            }

            cleanup();
            resolve({ code, receivedState });
          };

          // Listen for tab being closed before auth completes
          tabRemovedListener = (tabId: number) => {
            if (tabId === authTabId) {
              cleanup();
              authTabId = undefined; // Prevent double-close attempt
              reject(new Error('Authentication tab was closed before completing login'));
            }
          };

          chrome.runtime.onMessage.addListener(messageListener);
          chrome.tabs.onRemoved.addListener(tabRemovedListener);
        }
      );

      // 8. Close the auth tab
      if (authTabId !== undefined) {
        try {
          await chrome.tabs.remove(authTabId);
        } catch {
          // Tab may have already been closed
        }
      }

      // 9. Validate state parameter
      if (receivedState !== state) {
        throw new Error('OAuth state mismatch — possible CSRF attack');
      }

      // 10. Exchange code for tokens
      return await this.oauthService.exchangeCodeForTokens(code, codeVerifier);
    } finally {
      // Cleanup: remove redirect rule, listeners, alarm
      await removeOAuthRedirectRule().catch(() => {});
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME).catch(() => {});
      if (messageListener) {
        chrome.runtime.onMessage.removeListener(messageListener);
      }
      if (tabRemovedListener) {
        chrome.tabs.onRemoved.removeListener(tabRemovedListener);
      }
      this.isInProgress = false;
    }
  }

  get loginInProgress(): boolean {
    return this.isInProgress;
  }
}
