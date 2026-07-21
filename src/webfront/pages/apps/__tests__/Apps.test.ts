import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initialize: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  push: vi.fn(),
  access: {
    configured: true,
    credentialStatus: 'unverified',
    backendStatus: 'reachable',
    capabilityStatus: 'incompatible',
    authMethod: 'session-jwt',
    credentialSource: 'session',
    hasCredential: true,
    reason: 'backend_incompatible',
    revision: 1,
    updatedAt: 1,
  },
}));

vi.mock('@/webfront/stores/appsStore', () => ({
  appsStore: {
    subscribe(run: (value: unknown) => void) {
      run({
        loading: false,
        error: null,
        access: mocks.access,
        policy: {
          authMethod: 'session-jwt',
          setupCopy: {
            title: 'Sign in to your account',
            description: 'Log in to your account',
            action: 'Log in',
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
  activateApp: vi.fn(),
  AppsApiError: class AppsApiError extends Error {},
  fetchAppIcon: vi.fn(),
  fetchMarketplace: vi.fn(),
  getAuthStatus: vi.fn(),
  installApp: vi.fn(),
  needsAuth: vi.fn(() => false),
  startOAuth: vi.fn(),
  submitApiKey: vi.fn(),
}));

vi.mock('@/webfront/lib/gatewayCatalog', () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock('svelte-spa-router', () => ({ push: mocks.push }));

import Apps from '../Apps.svelte';
import { themePreference } from '../../../stores/themeStore';

describe('Apps theme integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(mocks.access, {
      configured: true,
      credentialStatus: 'unverified',
      backendStatus: 'reachable',
      capabilityStatus: 'incompatible',
      authMethod: 'session-jwt',
      credentialSource: 'session',
      hasCredential: true,
      reason: 'backend_incompatible',
      revision: 1,
      updatedAt: 1,
    });
    themePreference.setTheme('modern-light');
  });

  it('labels backend incompatibility separately from login and keeps it under theme control', async () => {
    render(Apps);

    const page = screen.getByTestId('apps-page');
    const accessCard = screen.getByTestId('apps-access-card');
    const retry = screen.getByRole('button', { name: 'Retry' });

    expect(screen.getByRole('heading', { name: 'Apps service update required' })).toBeTruthy();
    expect(screen.queryByText('Sign in to your account')).toBeNull();
    expect(screen.queryByText('Log in to your account')).toBeNull();

    expect(page.classList.contains('font-chat')).toBe(true);
    expect(page.classList.contains('text-chat-text')).toBe(true);
    expect(accessCard.classList.contains('bg-chat-surface')).toBe(true);
    expect(accessCard.classList.contains('border-chat-border')).toBe(true);
    expect(retry.classList.contains('text-chat-primary')).toBe(true);

    themePreference.setTheme('terminal');

    await waitFor(() => {
      expect(page.classList.contains('font-terminal')).toBe(true);
      expect(page.classList.contains('text-term-green')).toBe(true);
      expect(accessCard.classList.contains('bg-[#0a0a0a]')).toBe(true);
      expect(accessCard.classList.contains('border-term-dim-green')).toBe(true);
      expect(retry.classList.contains('text-term-bright-green')).toBe(true);
    });

    expect(page.classList.contains('font-chat')).toBe(false);
    expect(accessCard.classList.contains('bg-chat-surface')).toBe(false);
    expect(retry.classList.contains('text-chat-primary')).toBe(false);
  });

  it('keeps the setup copy and login action for a genuinely missing session', () => {
    Object.assign(mocks.access, {
      credentialStatus: 'needs-login',
      backendStatus: 'unknown',
      capabilityStatus: 'unknown',
      credentialSource: 'none',
      hasCredential: false,
      reason: 'login_required',
    });

    render(Apps);

    expect(screen.getByRole('heading', { name: 'Sign in to your account' })).toBeTruthy();
    expect(screen.getByText('Log in to your account')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('labels a validation outage as service availability rather than login', () => {
    Object.assign(mocks.access, {
      credentialStatus: 'unverified',
      backendStatus: 'unavailable',
      capabilityStatus: 'unknown',
      credentialSource: 'session',
      hasCredential: true,
      reason: 'validation_unavailable',
    });

    render(Apps);

    expect(screen.getByRole('heading', { name: 'Apps service unavailable' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('Sign in to your account')).toBeNull();
  });
});
