import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppsSettings from '../AppsSettings.svelte';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  validate: vi.fn(async () => ({ valid: true })),
  save: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/webfront/stores/appsStore', () => ({
  appsStore: {
    subscribe(run: (value: unknown) => void) {
      run({
        loading: false,
        error: null,
        access: {
          configured: true,
          credentialStatus: 'needs-api-key',
          credentialSource: 'none',
          hasCredential: false,
        },
        policy: {
          authMethod: 'api-key',
          apiKeyManagementUrl: 'https://hub.example/settings/api-keys',
          setupCopy: {
            title: 'Connect Apps',
            description: 'Add an OpenHub API key to install and connect apps.',
            action: 'Add API key',
          },
        },
      });
      return () => undefined;
    },
  },
  initializeAppsStore: mocks.initialize,
  refreshAppsStore: mocks.refresh,
}));

vi.mock('@/webfront/lib/apis/apps', () => ({
  validateAppsApiKey: mocks.validate,
  saveAppsApiKey: mocks.save,
  removeAppsApiKey: mocks.remove,
}));

vi.mock('@/webfront/lib/gatewayCatalog', () => ({
  openExternalUrl: vi.fn(),
}));

describe('AppsSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a validated key in the field so it can be saved without re-entry', async () => {
    render(AppsSettings);
    const input = screen.getByPlaceholderText('OpenHub API key') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'oh-candidate' } });

    await fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

    await waitFor(() => expect(mocks.validate).toHaveBeenCalledWith('oh-candidate'));
    expect(input.value).toBe('oh-candidate');
    expect(screen.getByText('OpenHub API key is valid.')).toBeTruthy();
  });
});
