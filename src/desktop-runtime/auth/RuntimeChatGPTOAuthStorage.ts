/**
 * Runtime-side ChatGPT OAuth token storage.
 *
 * Replaces the WebView-side `ChatGPTOAuthDesktopStorage` that used to call
 * Tauri's keychain commands directly. Inside the runtime sidecar we instead
 * route through the runtime credential store (ControlFrameCredentialStore →
 * keychain.* control frames on the desktop runtime).
 */

import type { ChatGPTOAuthStorage, ChatGPTTokens } from '@/core/auth/ChatGPTOAuthService';
import type { CredentialStore } from '@/core/storage/CredentialStore';

const SERVICE = 'chatgpt';
const TOKENS_ACCOUNT = 'tokens';

export class RuntimeChatGPTOAuthStorage implements ChatGPTOAuthStorage {
  constructor(private readonly credentialStore: CredentialStore) {}

  async getTokens(): Promise<ChatGPTTokens | null> {
    const raw = await this.credentialStore.get(SERVICE, TOKENS_ACCOUNT);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ChatGPTTokens;
    } catch {
      // Malformed entry — clear it so a re-login can succeed.
      await this.credentialStore.delete(SERVICE, TOKENS_ACCOUNT).catch(() => undefined);
      return null;
    }
  }

  async setTokens(tokens: ChatGPTTokens): Promise<void> {
    await this.credentialStore.set(SERVICE, TOKENS_ACCOUNT, JSON.stringify(tokens));
  }

  async clearTokens(): Promise<void> {
    await this.credentialStore.delete(SERVICE, TOKENS_ACCOUNT);
  }
}
