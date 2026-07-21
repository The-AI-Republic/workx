import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceRequest = vi.fn();
vi.mock('@/core/messaging', () => ({
  getInitializedUIClient: vi.fn(async () => ({ serviceRequest })),
}));

import {
  activateApp,
  fetchAppIcon,
  fetchMarketplace,
  getAppsPolicy,
  getAppsState,
  installApp,
  removeAppsApiKey,
  saveAppsApiKey,
  startOAuth,
  submitApiKey,
  validateAppsApiKey,
} from '../index';

describe('runtime Apps service client', () => {
  beforeEach(() => serviceRequest.mockReset());

  it('routes marketplace queries through the runtime service', async () => {
    serviceRequest.mockResolvedValue({ items: [], nextCursor: null });
    await expect(fetchMarketplace({ query: 'mail', cursor: 'next', limit: 20 })).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(serviceRequest).toHaveBeenCalledWith('apps.marketplace.list', {
      query: 'mail',
      cursor: 'next',
      limit: 20,
    });
  });

  it('routes state and policy reads', async () => {
    serviceRequest
      .mockResolvedValueOnce({ configured: true })
      .mockResolvedValueOnce({ authMethod: 'api-key' });
    await getAppsState();
    await getAppsPolicy();
    expect(serviceRequest.mock.calls.map((call) => call[0])).toEqual([
      'apps.getState',
      'apps.getPolicy',
    ]);
  });

  it('routes app mutations without a Webfront credential', async () => {
    serviceRequest.mockResolvedValue(null);
    await installApp('mail');
    await activateApp('mail');
    expect(serviceRequest).toHaveBeenNthCalledWith(1, 'apps.install', { appId: 'mail' });
    expect(serviceRequest).toHaveBeenNthCalledWith(2, 'apps.activate', { appId: 'mail' });
  });

  it('routes OAuth and manual app credentials through narrow services', async () => {
    serviceRequest
      .mockResolvedValueOnce({ authorizationUrl: 'https://provider.example/auth', expiresIn: 600 })
      .mockResolvedValueOnce(null);
    await startOAuth('mail');
    await submitApiKey('mail', { api_key: 'secret' }, { accountHint: 'me@example.com' });
    expect(serviceRequest).toHaveBeenNthCalledWith(1, 'apps.auth.startOAuth', { appId: 'mail' });
    expect(serviceRequest).toHaveBeenNthCalledWith(2, 'apps.auth.submitCredentials', {
      appId: 'mail',
      fields: { api_key: 'secret' },
      accountHint: 'me@example.com',
    });
  });

  it('routes OpenHub credential lifecycle operations', async () => {
    serviceRequest.mockResolvedValue({});
    await validateAppsApiKey('oh-test');
    await saveAppsApiKey('oh-test');
    await removeAppsApiKey();
    expect(serviceRequest.mock.calls).toEqual([
      ['apps.credentials.validate', { apiKey: 'oh-test' }],
      ['apps.credentials.save', { apiKey: 'oh-test' }],
      ['apps.credentials.remove', {}],
    ]);
  });

  it('loads icons through the runtime service', async () => {
    serviceRequest.mockResolvedValue({ mimeType: 'image/png', base64: 'AA==' });
    await fetchAppIcon('mail');
    expect(serviceRequest).toHaveBeenCalledWith('apps.icon.get', { appId: 'mail' });
  });

  it('contains no direct network dependency', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    serviceRequest.mockResolvedValue({ items: [], nextCursor: null });
    await fetchMarketplace();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
