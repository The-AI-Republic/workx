import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadUserStoreWithHomeUrl(homeUrl: string, loginPath: string | null = '/signin') {
  vi.resetModules();
  vi.doMock('../../lib/constants', () => ({
    AUTH_ROUTE_PATHS: {
      login: loginPath,
    },
    HOME_PAGE_BASE_URL: homeUrl,
  }));
  return import('../userStore');
}

describe('userStore login URL helpers', () => {
  afterEach(() => {
    vi.doUnmock('../../lib/constants');
    vi.resetModules();
  });

  it('normalizes the standard login URL when the home URL has a trailing slash', async () => {
    const { getLoginPageUrl } = await loadUserStoreWithHomeUrl('https://home.example.com/');

    expect(getLoginPageUrl()).toBe('https://home.example.com/signin');
  });

  it('builds the desktop login URL with the deeplink redirect', async () => {
    const { getDesktopLoginPageUrl } = await loadUserStoreWithHomeUrl('https://home.example.com/');

    const desktopLoginPageUrl = getDesktopLoginPageUrl();
    expect(desktopLoginPageUrl).not.toBeNull();
    const url = new URL(desktopLoginPageUrl!);
    expect(url.origin).toBe('https://home.example.com');
    expect(url.pathname).toBe('/signin');
    expect(url.searchParams.get('redirect_url')).toBe('workx://auth/callback');
    expect(url.searchParams.get('desktop_login_ts')).toMatch(/^\d+$/);
  });

  it('returns null when hosted auth is not configured', async () => {
    const { getLoginPageUrl, getDesktopLoginPageUrl } = await loadUserStoreWithHomeUrl('');

    expect(getLoginPageUrl()).toBeNull();
    expect(getDesktopLoginPageUrl()).toBeNull();
  });

  it('returns null when hosted auth login path is not configured', async () => {
    const { getLoginPageUrl, getDesktopLoginPageUrl } = await loadUserStoreWithHomeUrl('https://home.example.com', null);

    expect(getLoginPageUrl()).toBeNull();
    expect(getDesktopLoginPageUrl()).toBeNull();
  });
});
