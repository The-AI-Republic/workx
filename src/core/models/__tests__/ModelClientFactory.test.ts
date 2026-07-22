import { describe, expect, it, vi } from 'vitest';
import { ModelClientFactory } from '../ModelClientFactory';
import type { AuthContext } from '@/core/auth/AuthContext';

describe('ModelClientFactory OSS routing', () => {
  it('never enables hosted backend routing', () => {
    const factory = new ModelClientFactory();
    expect(factory.isBackendRouting()).toBe(false);
  });

  it('retains ChatGPT provider OAuth retry handling', () => {
    const authContext = {
      current: () => ({ isChatGPTOAuthActive: () => true }),
      gatewayCredentials: () => null,
      subscribe: vi.fn(() => () => {}),
    } as unknown as AuthContext;
    const factory = new ModelClientFactory({ authContext });
    expect(factory.handleChatGPTOAuth401()).toBe(true);
    expect(factory.handleChatGPTOAuth401()).toBe(false);
  });
});
