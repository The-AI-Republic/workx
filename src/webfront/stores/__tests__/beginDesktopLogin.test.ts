import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEYS = [
  'VITE_AUTH_BASE_URL',
  'WORKX_AUTH_BASE_URL',
  'VITE_AUTH_LOGIN_PATH',
  'WORKX_AUTH_LOGIN_PATH',
  'VITE_AUTH_CLIENT_ID',
  'WORKX_AUTH_CLIENT_ID',
  'VITE_AUTH_SCOPES',
] as const;

const original = new Map<string, string | undefined>();

async function loadUserStore() {
  vi.resetModules();
  return import('../userStore');
}

describe('beginDesktopLogin', () => {
  beforeEach(() => {
    for (const k of KEYS) {
      original.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      const v = original.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('OIDC mode: builds a PKCE authorize URL and completes via token exchange', async () => {
    process.env.VITE_AUTH_BASE_URL = 'https://idp.example.com';
    process.env.VITE_AUTH_CLIENT_ID = 'workx-desktop';
    process.env.VITE_AUTH_SCOPES = 'openid chat apps';
    const { beginDesktopLogin } = await loadUserStore();

    const session = await beginDesktopLogin();
    expect(session).not.toBeNull();
    const url = new URL(session!.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://idp.example.com/auth/authorize');
    expect(url.searchParams.get('client_id')).toBe('workx-desktop');
    expect(url.searchParams.get('scope')).toBe('openid chat apps');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    const state = url.searchParams.get('state')!;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), { status: 200 }),
      ),
    );
    const tokens = await session!.complete(`workx://auth/callback?code=abc&state=${state}`);
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt' });
  });

  it('OIDC mode: rejects a state mismatch (CSRF guard)', async () => {
    process.env.VITE_AUTH_BASE_URL = 'https://idp.example.com';
    process.env.VITE_AUTH_CLIENT_ID = 'workx-desktop';
    const { beginDesktopLogin } = await loadUserStore();

    const session = await beginDesktopLogin();
    await expect(
      session!.complete('workx://auth/callback?code=abc&state=WRONG'),
    ).rejects.toThrow(/state mismatch/);
  });

  it('legacy mode: no client id -> deep-link login URL, tokens read from callback', async () => {
    process.env.VITE_AUTH_BASE_URL = 'https://idp.example.com';
    process.env.VITE_AUTH_LOGIN_PATH = '/login';
    const { beginDesktopLogin } = await loadUserStore();

    const session = await beginDesktopLogin();
    expect(session).not.toBeNull();
    const url = new URL(session!.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://idp.example.com/login');
    expect(url.searchParams.get('redirect_url')).toBe('workx://auth/callback');

    const tokens = await session!.complete(
      'workx://auth/callback?access_token=AT&refresh_token=RT',
    );
    expect(tokens).toEqual({ accessToken: 'AT', refreshToken: 'RT' });
  });
});
