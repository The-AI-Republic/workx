import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAuthConfig } from '../authConfig';

const KEYS = [
  'WORKX_AUTH_CLIENT_ID',
  'VITE_AUTH_CLIENT_ID',
  'WORKX_AUTH_SCOPES',
  'VITE_AUTH_SCOPES',
  'WORKX_AUTH_AUTHORIZE_PATH',
  'WORKX_AUTH_TOKEN_PATH',
  'WORKX_AUTH_REDIRECT_URI',
] as const;

const original = new Map<string, string | undefined>();

describe('resolveAuthConfig.oidc', () => {
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
  });

  it('is null (legacy flow) when no client id is configured', () => {
    expect(resolveAuthConfig().oidc).toBeNull();
    expect(resolveAuthConfig().source.oidc).toBe('default');
  });

  it('enables OIDC with sensible defaults when a client id is set', () => {
    process.env.WORKX_AUTH_CLIENT_ID = 'workx-desktop';
    const cfg = resolveAuthConfig();
    expect(cfg.source.oidc).toBe('env');
    expect(cfg.oidc).toEqual({
      clientId: 'workx-desktop',
      authorizePath: '/auth/authorize',
      tokenPath: '/auth/token',
      redirectUri: 'workx://auth/callback',
      scopes: ['openid', 'profile', 'email'],
    });
  });

  it('parses space-separated scopes and honors path/redirect overrides', () => {
    process.env.VITE_AUTH_CLIENT_ID = 'workx-desktop';
    process.env.WORKX_AUTH_SCOPES = 'openid profile email chat apps models';
    process.env.WORKX_AUTH_AUTHORIZE_PATH = '/oauth/authorize';
    process.env.WORKX_AUTH_TOKEN_PATH = '/oauth/token';
    process.env.WORKX_AUTH_REDIRECT_URI = 'workx://cb';
    const cfg = resolveAuthConfig();
    expect(cfg.oidc?.scopes).toEqual(['openid', 'profile', 'email', 'chat', 'apps', 'models']);
    expect(cfg.oidc?.authorizePath).toBe('/oauth/authorize');
    expect(cfg.oidc?.tokenPath).toBe('/oauth/token');
    expect(cfg.oidc?.redirectUri).toBe('workx://cb');
  });
});
