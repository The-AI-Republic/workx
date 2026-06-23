import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadUserStore(opts: {
  homeUrl: string;
  loginPath?: string | null;
  oidcEnabled?: boolean;
  clientId?: string | null;
}) {
  const { homeUrl, loginPath = '/signin', oidcEnabled = false, clientId = 'workx-desktop' } = opts;
  vi.resetModules();
  vi.doMock('../../lib/constants', () => ({
    AUTH_ROUTE_PATHS: {
      login: loginPath,
    },
    HOME_PAGE_BASE_URL: homeUrl,
    AUTH_OIDC_AUTHORIZE_PATH: '/auth/authorize',
    AUTH_OIDC_TOKEN_PATH: '/auth/token',
    AUTH_OIDC_CLIENT_ID: clientId,
    AUTH_OIDC_ENABLED: oidcEnabled,
    DESKTOP_OIDC_REDIRECT_URI: 'workx://auth/callback',
  }));
  return import('../userStore');
}

async function loadUserStoreWithHomeUrl(homeUrl: string, loginPath: string | null = '/signin') {
  return loadUserStore({ homeUrl, loginPath });
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

describe('userStore desktop OIDC helpers', () => {
  afterEach(() => {
    vi.doUnmock('../../lib/constants');
    vi.resetModules();
  });

  it('hasDesktopOidc is false by default (kill-switch off)', async () => {
    const { hasDesktopOidc } = await loadUserStore({ homeUrl: 'https://home.example.com', oidcEnabled: false });
    expect(hasDesktopOidc()).toBe(false);
  });

  it('hasDesktopOidc requires the flag plus a home URL and a client id', async () => {
    const enabled = await loadUserStore({ homeUrl: 'https://home.example.com', oidcEnabled: true });
    expect(enabled.hasDesktopOidc()).toBe(true);

    const noHome = await loadUserStore({ homeUrl: '', oidcEnabled: true });
    expect(noHome.hasDesktopOidc()).toBe(false);

    const noClient = await loadUserStore({ homeUrl: 'https://home.example.com', oidcEnabled: true, clientId: null });
    expect(noClient.hasDesktopOidc()).toBe(false);
  });

  it('builds the OIDC authorize URL with PKCE + state params', async () => {
    const { getDesktopAuthorizeUrl } = await loadUserStore({ homeUrl: 'https://home.example.com', oidcEnabled: true });
    const authorizeUrl = getDesktopAuthorizeUrl({ codeChallenge: 'CHALLENGE', state: 'STATE123' });
    expect(authorizeUrl).not.toBeNull();
    const url = new URL(authorizeUrl!);
    expect(url.origin).toBe('https://home.example.com');
    expect(url.pathname).toBe('/auth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('workx-desktop');
    expect(url.searchParams.get('redirect_uri')).toBe('workx://auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('STATE123');
  });

  it('getDesktopAuthorizeUrl returns null when OIDC is disabled', async () => {
    const { getDesktopAuthorizeUrl } = await loadUserStore({ homeUrl: 'https://home.example.com', oidcEnabled: false });
    expect(getDesktopAuthorizeUrl({ codeChallenge: 'c', state: 's' })).toBeNull();
  });

  it('builds the OIDC token URL from the home base', async () => {
    const { getDesktopTokenUrl } = await loadUserStore({ homeUrl: 'https://home.example.com', oidcEnabled: true });
    expect(getDesktopTokenUrl()).toBe('https://home.example.com/auth/token');
  });
});
