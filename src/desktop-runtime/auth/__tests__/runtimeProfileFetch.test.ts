import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchUserProfileServerSide,
  profileFromAccessToken,
  refreshDesktopAuthTokens,
} from '../runtimeProfileFetch';

function jwtWithPayload(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8')
    .toString('base64url');
  return `header.${encoded}.signature`;
}

describe('profileFromAccessToken', () => {
  it('derives a minimal profile from JWT claims', () => {
    const token = jwtWithPayload({
      sub: 'user-1',
      email: 'rich@example.com',
      name: 'Rich',
      picture: 'https://example.com/avatar.png',
      user_type: 1,
    });

    expect(profileFromAccessToken(token)).toEqual({
      id: 'user-1',
      email: 'rich@example.com',
      name: 'Rich',
      avatar: 'https://example.com/avatar.png',
      userType: 1,
    });
  });

  it('returns null when the token has no profile-like claims', () => {
    expect(profileFromAccessToken(jwtWithPayload({ type: 'access' }))).toBeNull();
    expect(profileFromAccessToken('not-a-jwt')).toBeNull();
  });
});

describe('fetchUserProfileServerSide', () => {
  const originalEnv = new Map<string, string | undefined>();
  const envKeys = [
    'VITE_AUTH_BASE_URL',
    'VITE_AUTH_DESKTOP_SESSION_PATH',
    'VITE_AUTH_PROFILE_PATH',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.VITE_AUTH_BASE_URL = 'https://home.example.com';
    process.env.VITE_AUTH_DESKTOP_SESSION_PATH = '/desktop/session';
    process.env.VITE_AUTH_PROFILE_PATH = '/profile';
  });

  afterEach(() => {
    for (const key of envKeys) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
    vi.unstubAllGlobals();
  });

  it('uses the desktop session endpoint before the legacy profile endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      user_id: 'u1',
      firstName: 'Rich',
      email: 'rich@example.com',
      avatar_url: 'https://example.com/avatar.png',
      user_type: 2,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const profile = await fetchUserProfileServerSide('access-token');

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith('https://home.example.com/desktop/session', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }));
    expect(profile).toEqual({
      id: 'u1',
      name: 'Rich',
      email: 'rich@example.com',
      avatar: 'https://example.com/avatar.png',
      userType: 2,
    });
  });

  it('falls back to the configured profile endpoint only when desktop session is missing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/desktop/session')) {
        return new Response('', { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify({ id: 'u2', name: 'Fallback' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const profile = await fetchUserProfileServerSide('access-token');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith('https://home.example.com/profile', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer access-token' }),
    }));
    expect(profile).toEqual({
      id: 'u2',
      name: 'Fallback',
      email: undefined,
      avatar: undefined,
      userType: 0,
    });
  });

  it('does not fall back to the legacy profile endpoint on auth failure', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401, statusText: 'Unauthorized' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchUserProfileServerSide('access-token')).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('refreshDesktopAuthTokens', () => {
  const originalEnv = new Map<string, string | undefined>();
  const envKeys = [
    'VITE_AUTH_BASE_URL',
    'VITE_AUTH_DESKTOP_REFRESH_PATH',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      originalEnv.set(key, process.env[key]);
    }
    process.env.VITE_AUTH_BASE_URL = 'https://home.example.com';
    process.env.VITE_AUTH_DESKTOP_REFRESH_PATH = '/desktop/refresh';
  });

  afterEach(() => {
    for (const key of envKeys) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
    vi.unstubAllGlobals();
  });

  it('normalizes refreshed desktop tokens', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-at',
      refresh_token: 'new-rt',
      token_type: 'Bearer',
      expires_in: 3600,
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await refreshDesktopAuthTokens('old-rt');

    expect(fetchMock).toHaveBeenCalledWith('https://home.example.com/desktop/refresh', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer old-rt' }),
      body: JSON.stringify({ refresh_token: 'old-rt' }),
    }));
    expect(tokens).toEqual({
      accessToken: 'new-at',
      refreshToken: 'new-rt',
      tokenType: 'Bearer',
      expiresIn: 3600,
    });
  });

  it('returns null for incomplete refresh responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      access_token: 'new-at',
    }), { status: 200 })));

    await expect(refreshDesktopAuthTokens('old-rt')).resolves.toBeNull();
  });
});
