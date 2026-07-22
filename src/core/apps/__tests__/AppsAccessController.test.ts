import { describe, expect, it, vi } from 'vitest';
import { AppsAccessController } from '../AppsAccessController';

const policy = {
  authMethod: 'api-key' as const,
  apiKeyManagementUrl: 'https://hub.example/settings/api-keys',
  setupCopy: { title: '', description: '', action: '' },
};

describe('AppsAccessController OSS policy', () => {
  it('requests an OpenHub API key when none is configured', async () => {
    const controller = new AppsAccessController({
      configured: true,
      policy,
      provider: { getCredential: vi.fn(async () => null) } as never,
      client: { setObserver: vi.fn() } as never,
    });
    await expect(controller.initialize()).resolves.toMatchObject({
      credentialStatus: 'needs-api-key', reason: 'api_key_missing', authMethod: 'api-key',
    });
  });
});
