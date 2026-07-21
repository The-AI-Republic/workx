import { describe, expect, it, vi } from 'vitest';
import { createAppsServices } from '../apps-services';
import type { SubmissionContext } from '@/core/channels/types';

const desktop: SubmissionContext = { channelId: 'desktop-runtime-main', channelType: 'tauri' };
const websocket: SubmissionContext = { channelId: 'ws', channelType: 'websocket' };

function setup() {
  const access = {
    getState: vi.fn(() => ({ configured: true })),
    refresh: vi.fn(async () => ({ configured: true })),
    get policy() {
      return {
        authMethod: 'api-key',
        apiKeyManagementUrl: 'https://hub.example/keys',
        setupCopy: { title: '', description: '', action: '' },
      };
    },
    requireReady: vi.fn(),
    validateCandidate: vi.fn(async () => ({ valid: true })),
    saveCandidate: vi.fn(async () => ({ credentialStatus: 'ready' })),
    removeStoredKey: vi.fn(async () => ({ credentialStatus: 'needs-api-key' })),
  };
  const client = {
    marketplace: vi.fn(async () => ({ items: [], nextCursor: null })),
    install: vi.fn(async () => null),
    uninstall: vi.fn(async () => null),
    activate: vi.fn(async () => null),
    deactivate: vi.fn(async () => null),
    getAuthStatus: vi.fn(async () => ({ manualFields: [{ key: 'api_key', optional: false }] })),
    startOAuth: vi.fn(async () => ({
      authorizationUrl: 'https://provider.example',
      expiresIn: null,
    })),
    submitCredentials: vi.fn(async () => null),
    getIcon: vi.fn(async () => null),
  };
  const handlers = createAppsServices({
    access: access as any,
    client: client as any,
    authorizeContext: (context) =>
      context.channelType === 'tauri' && context.channelId === 'desktop-runtime-main',
  });
  return { access, client, handlers };
}

describe('apps.* services', () => {
  it('denies untrusted channels before executing a handler', async () => {
    const { handlers, client } = setup();
    await expect(handlers['apps.marketplace.list']({}, websocket)).rejects.toMatchObject({
      errorCode: 'APPS_AUTH_METHOD_DISABLED',
    });
    expect(client.marketplace).not.toHaveBeenCalled();
  });

  it('validates marketplace input bounds', async () => {
    const { handlers, client } = setup();
    await expect(handlers['apps.marketplace.list']({ limit: 101 }, desktop)).rejects.toMatchObject({
      errorCode: 'APPS_INVALID_ARGUMENT',
    });
    await handlers['apps.marketplace.list']({ query: 'mail', limit: 20 }, desktop);
    expect(client.marketplace).toHaveBeenCalledWith({
      query: 'mail',
      cursor: undefined,
      limit: 20,
    });
  });

  it('accepts only runtime-declared manual credential fields', async () => {
    const { handlers, client } = setup();
    await expect(
      handlers['apps.auth.submitCredentials'](
        { appId: 'mail', fields: { unexpected: 'secret' } },
        desktop
      )
    ).rejects.toMatchObject({ errorCode: 'APPS_INVALID_ARGUMENT' });
    await handlers['apps.auth.submitCredentials'](
      { appId: 'mail', fields: { api_key: 'secret' } },
      desktop
    );
    expect(client.submitCredentials).toHaveBeenCalledWith('mail', { api_key: 'secret' }, undefined);
  });

  it('does not trust a previous validation when saving', async () => {
    const { handlers, access } = setup();
    await handlers['apps.credentials.validate']({ apiKey: 'candidate' }, desktop);
    await handlers['apps.credentials.save']({ apiKey: 'candidate' }, desktop);
    expect(access.validateCandidate).toHaveBeenCalledWith('candidate');
    expect(access.saveCandidate).toHaveBeenCalledWith('candidate');
  });

  it('rejects oversized credential fields', async () => {
    const { handlers } = setup();
    await expect(
      handlers['apps.auth.submitCredentials'](
        { appId: 'mail', fields: { api_key: 'x'.repeat(16 * 1024 + 1) } },
        desktop
      )
    ).rejects.toMatchObject({ errorCode: 'APPS_INVALID_ARGUMENT' });
  });
});
