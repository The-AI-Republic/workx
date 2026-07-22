/** Runtime service handlers for ChatGPT provider OAuth. */

import type { ServiceHandler } from '@/core/channels/ServiceRegistry';

export interface AuthServiceDeps {
  chatgptFlow?: {
    loginInProgress: boolean;
    beginLogin(timeoutMs?: number): Promise<{ authUrl: string }>;
    waitForCompletion(): Promise<unknown>;
    cancel(reason?: string): void;
  };
  getChatGPTStorage?: () => {
    getTokens(): Promise<unknown | null>;
    clearTokens(): Promise<void>;
  };
}

export function createAuthServices(deps: AuthServiceDeps): Record<string, ServiceHandler> {
  return {
    'auth.chatgpt.startLogin': async (params) => {
      if (!deps.chatgptFlow) {
        throw new Error('auth.chatgpt.startLogin: ChatGPT OAuth not available on this platform');
      }
      const { timeoutMs } = (params ?? {}) as { timeoutMs?: number };
      return deps.chatgptFlow.beginLogin(timeoutMs);
    },
    'auth.chatgpt.awaitCompletion': async () => {
      if (!deps.chatgptFlow) {
        throw new Error(
          'auth.chatgpt.awaitCompletion: ChatGPT OAuth not available on this platform'
        );
      }
      await deps.chatgptFlow.waitForCompletion();
      return { success: true };
    },
    'auth.chatgpt.cancelLogin': async () => {
      deps.chatgptFlow?.cancel('cancelled by UI');
      return { success: true };
    },
    'auth.chatgpt.isConnected': async () => {
      if (!deps.getChatGPTStorage) return { connected: false };
      return { connected: (await deps.getChatGPTStorage().getTokens()) !== null };
    },
    'auth.chatgpt.logout': async () => {
      await deps.getChatGPTStorage?.().clearTokens().catch(() => undefined);
      return { success: true };
    },
  };
}
