import { describe, expect, it, vi } from 'vitest';
import { createAuthServices } from '../auth-services';

describe('ChatGPT OAuth runtime services', () => {
  it('retains the provider OAuth lifecycle without product-account handlers', async () => {
    const flow = {
      loginInProgress: false,
      beginLogin: vi.fn(async () => ({ authUrl: 'https://auth.openai.com/' })),
      waitForCompletion: vi.fn(async () => undefined),
      cancel: vi.fn(),
    };
    const storage = { getTokens: vi.fn(async () => ({ access: 'token' })), clearTokens: vi.fn() };
    const services = createAuthServices({ chatgptFlow: flow, getChatGPTStorage: () => storage });

    expect(Object.keys(services).sort()).toEqual([
      'auth.chatgpt.awaitCompletion',
      'auth.chatgpt.cancelLogin',
      'auth.chatgpt.isConnected',
      'auth.chatgpt.logout',
      'auth.chatgpt.startLogin',
    ]);
    await expect(services['auth.chatgpt.startLogin']({}, {} as never)).resolves.toEqual({
      authUrl: 'https://auth.openai.com/',
    });
  });
});
