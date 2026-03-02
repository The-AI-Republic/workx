/**
 * ChatGPT OAuth Desktop Storage
 *
 * Implements ChatGPTOAuthStorage using the OS keychain via KeytarCredentialStore.
 * Stores each token field as a separate keychain entry under the 'chatgpt-oauth' service.
 *
 * @module desktop/auth/ChatGPTOAuthDesktopStorage
 */

import { KeytarCredentialStore } from '../storage/KeytarCredentialStore';
import type { ChatGPTOAuthStorage, ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';

const CHATGPT_OAUTH_SERVICE = 'chatgpt-oauth';

const TOKEN_ACCOUNTS = {
  ACCESS_TOKEN: 'access_token',
  REFRESH_TOKEN: 'refresh_token',
  ID_TOKEN: 'id_token',
  EXPIRES_AT: 'expires_at',
} as const;

export class ChatGPTOAuthDesktopStorage implements ChatGPTOAuthStorage {
  private credentialStore: KeytarCredentialStore;

  constructor(credentialStore?: KeytarCredentialStore) {
    this.credentialStore = credentialStore ?? new KeytarCredentialStore();
  }

  async getTokens(): Promise<ChatGPTTokens | null> {
    try {
      const [accessToken, refreshToken, idToken, expiresAtStr] = await Promise.all([
        this.credentialStore.get(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.ACCESS_TOKEN),
        this.credentialStore.get(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.REFRESH_TOKEN),
        this.credentialStore.get(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.ID_TOKEN),
        this.credentialStore.get(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.EXPIRES_AT),
      ]);

      if (!accessToken || !refreshToken) {
        return null;
      }

      return {
        accessToken,
        refreshToken,
        idToken: idToken || undefined,
        expiresAt: expiresAtStr ? parseInt(expiresAtStr, 10) : 0,
      };
    } catch (error) {
      console.error('[ChatGPTOAuthDesktopStorage] Failed to get tokens:', error);
      return null;
    }
  }

  async setTokens(tokens: ChatGPTTokens): Promise<void> {
    await Promise.all([
      this.credentialStore.set(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.ACCESS_TOKEN, tokens.accessToken),
      this.credentialStore.set(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.REFRESH_TOKEN, tokens.refreshToken),
      tokens.idToken
        ? this.credentialStore.set(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.ID_TOKEN, tokens.idToken)
        : Promise.resolve(),
      this.credentialStore.set(
        CHATGPT_OAUTH_SERVICE,
        TOKEN_ACCOUNTS.EXPIRES_AT,
        tokens.expiresAt.toString()
      ),
    ]);
  }

  async clearTokens(): Promise<void> {
    await Promise.all([
      this.credentialStore.delete(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.ACCESS_TOKEN),
      this.credentialStore.delete(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.REFRESH_TOKEN),
      this.credentialStore.delete(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.ID_TOKEN),
      this.credentialStore.delete(CHATGPT_OAUTH_SERVICE, TOKEN_ACCOUNTS.EXPIRES_AT),
    ]);
  }
}
