/**
 * ChatGPT OAuth Extension Storage
 *
 * Implements ChatGPTOAuthStorage using chrome.storage.local for the
 * Chrome extension platform.
 *
 * @module extension/auth/ChatGPTOAuthExtensionStorage
 */

import type { ChatGPTOAuthStorage, ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';

const STORAGE_KEYS = {
  ACCESS_TOKEN: 'chatgpt_oauth_access_token',
  REFRESH_TOKEN: 'chatgpt_oauth_refresh_token',
  ID_TOKEN: 'chatgpt_oauth_id_token',
  EXPIRES_AT: 'chatgpt_oauth_expires_at',
} as const;

export class ChatGPTOAuthExtensionStorage implements ChatGPTOAuthStorage {
  async getTokens(): Promise<ChatGPTTokens | null> {
    try {
      const result = await chrome.storage.local.get([
        STORAGE_KEYS.ACCESS_TOKEN,
        STORAGE_KEYS.REFRESH_TOKEN,
        STORAGE_KEYS.ID_TOKEN,
        STORAGE_KEYS.EXPIRES_AT,
      ]);

      const accessToken = result[STORAGE_KEYS.ACCESS_TOKEN];
      const refreshToken = result[STORAGE_KEYS.REFRESH_TOKEN];

      if (!accessToken || !refreshToken) {
        return null;
      }

      return {
        accessToken: accessToken as string,
        refreshToken: refreshToken as string,
        idToken: (result[STORAGE_KEYS.ID_TOKEN] as string) || undefined,
        expiresAt: (result[STORAGE_KEYS.EXPIRES_AT] as number) || 0,
      };
    } catch (error) {
      console.error('[ChatGPTOAuthExtensionStorage] Failed to get tokens:', error);
      return null;
    }
  }

  async setTokens(tokens: ChatGPTTokens): Promise<void> {
    const data: Record<string, string | number> = {
      [STORAGE_KEYS.ACCESS_TOKEN]: tokens.accessToken,
      [STORAGE_KEYS.REFRESH_TOKEN]: tokens.refreshToken,
      [STORAGE_KEYS.EXPIRES_AT]: tokens.expiresAt,
    };
    if (tokens.idToken) {
      data[STORAGE_KEYS.ID_TOKEN] = tokens.idToken;
    }
    await chrome.storage.local.set(data);
  }

  async clearTokens(): Promise<void> {
    await chrome.storage.local.remove([
      STORAGE_KEYS.ACCESS_TOKEN,
      STORAGE_KEYS.REFRESH_TOKEN,
      STORAGE_KEYS.ID_TOKEN,
      STORAGE_KEYS.EXPIRES_AT,
    ]);
  }
}
