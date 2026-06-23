import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthOidcConfig } from '@/config/authConfig';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkce,
  parseCallback,
  randomState,
} from '../desktopOidc';

const OIDC: AuthOidcConfig = {
  clientId: 'workx-desktop',
  authorizePath: '/auth/authorize',
  tokenPath: '/auth/token',
  redirectUri: 'workx://auth/callback',
  scopes: ['openid', 'profile', 'email', 'chat', 'apps', 'models'],
};

const BASE = 'https://idp.example.com';

describe('generatePkce', () => {
  it('derives an S256 challenge from the verifier', async () => {
    const { codeVerifier, codeChallenge } = await generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = createHash('sha256').update(codeVerifier).digest('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('produces a fresh verifier each call', async () => {
    const a = await generatePkce();
    const b = await generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('randomState', () => {
  it('returns a non-empty url-safe value', () => {
    expect(randomState()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomState()).not.toBe(randomState());
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds an auth-code + PKCE authorize URL with all params', () => {
    const url = new URL(buildAuthorizeUrl(BASE, OIDC, { state: 'st-1', codeChallenge: 'chal-1' }));
    expect(url.origin + url.pathname).toBe('https://idp.example.com/auth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('workx-desktop');
    expect(url.searchParams.get('redirect_uri')).toBe('workx://auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email chat apps models');
    expect(url.searchParams.get('state')).toBe('st-1');
    expect(url.searchParams.get('code_challenge')).toBe('chal-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('parseCallback', () => {
  it('extracts code and state', () => {
    expect(parseCallback('workx://auth/callback?code=abc&state=st-1')).toEqual({
      code: 'abc',
      state: 'st-1',
    });
  });

  it('throws on an error response', () => {
    expect(() =>
      parseCallback('workx://auth/callback?error=access_denied&error_description=nope'),
    ).toThrow(/access_denied: nope/);
  });

  it('throws when the code is missing', () => {
    expect(() => parseCallback('workx://auth/callback?state=st-1')).toThrow(/missing the code/);
  });
});

describe('exchangeAuthorizationCode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the code + verifier and returns tokens', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const tokens = await exchangeAuthorizationCode(BASE, OIDC, { code: 'abc', codeVerifier: 'ver' });
    expect(tokens).toEqual({ accessToken: 'at', refreshToken: 'rt' });

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://idp.example.com/auth/token');
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('abc');
    expect(body.get('code_verifier')).toBe('ver');
    expect(body.get('client_id')).toBe('workx-desktop');
    expect(body.get('redirect_uri')).toBe('workx://auth/callback');
  });

  it('throws with detail on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('invalid_grant', { status: 400 })),
    );
    await expect(
      exchangeAuthorizationCode(BASE, OIDC, { code: 'bad', codeVerifier: 'ver' }),
    ).rejects.toThrow(/Token exchange failed \(400\): invalid_grant/);
  });

  it('throws when tokens are missing from a 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'at' }), { status: 200 })),
    );
    await expect(
      exchangeAuthorizationCode(BASE, OIDC, { code: 'abc', codeVerifier: 'ver' }),
    ).rejects.toThrow(/did not include access and refresh tokens/);
  });
});
