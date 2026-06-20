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

/**
 * Takes a lazy getter rather than a CredentialStore reference so callers
 * cannot accidentally pin a stale singleton. The store is resolved on each
 * call, which is the cheap correct path — `getCredentialStore()` is a
 * map-lookup. This also lets tests rebuild the store between cases without
 * having to also rebuild the storage object.
 */
export class RuntimeChatGPTOAuthStorage implements ChatGPTOAuthStorage {
  constructor(private readonly getCredentialStore: () => CredentialStore) {}

  async getTokens(): Promise<ChatGPTTokens | null> {
    const store = this.getCredentialStore();
    const raw = await store.get(SERVICE, TOKENS_ACCOUNT);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ChatGPTTokens;
    } catch {
      // Malformed entry — clear it so a re-login can succeed.
      await store.delete(SERVICE, TOKENS_ACCOUNT).catch(() => undefined);
      return null;
    }
  }

  async setTokens(tokens: ChatGPTTokens): Promise<void> {
    await this.getCredentialStore().set(SERVICE, TOKENS_ACCOUNT, JSON.stringify(tokens));
  }

  async clearTokens(): Promise<void> {
    await this.getCredentialStore().delete(SERVICE, TOKENS_ACCOUNT);
  }
}
