import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAuthConfig } from '../authConfig';

const ENV_KEYS = [
  'APPLEPI_AUTH_BASE_URL',
  'APPLEPI_HOME_PAGE_BASE_URL',
  'VITE_AUTH_BASE_URL',
  'VITE_HOME_PAGE_BASE_URL',
  'VITE_AUTH_COOKIE_DOMAIN',
  'VITE_COOKIE_DOMAIN',
  'VITE_AUTH_ACCESS_COOKIE_NAME',
  'VITE_AUTH_REFRESH_COOKIE_NAME',
  'VITE_AUTH_CSRF_COOKIE_NAME',
  'VITE_AUTH_STATUS_COOKIE_NAME',
  'VITE_AUTH_USER_NAME_COOKIE_NAME',
  'VITE_AUTH_USER_EMAIL_COOKIE_NAME',
] as const;

const originalEnv = new Map<string, string | undefined>();

describe('resolveAuthConfig', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    originalEnv.clear();
  });

  it('does not configure a hosted provider by default', () => {
    expect(resolveAuthConfig()).toMatchObject({
      authBaseUrl: null,
      cookieDomain: null,
      cookieNames: {
        access: 'access_token',
        refresh: 'refresh_token',
        csrf: 'csrf_token',
        status: 'auth_status',
        userName: 'user_name',
        userEmail: 'user_email',
      },
      source: {
        authBaseUrl: 'default',
        cookieDomain: 'default',
        cookieNames: 'default',
      },
    });
  });

  it('reads neutral hosted auth env values', () => {
    process.env.VITE_AUTH_BASE_URL = 'https://auth.example.com';
    process.env.VITE_AUTH_COOKIE_DOMAIN = '.example.com';
    process.env.VITE_AUTH_ACCESS_COOKIE_NAME = 'custom_access';
    process.env.VITE_AUTH_REFRESH_COOKIE_NAME = 'custom_refresh';
    process.env.VITE_AUTH_CSRF_COOKIE_NAME = 'custom_csrf';
    process.env.VITE_AUTH_STATUS_COOKIE_NAME = 'custom_status';
    process.env.VITE_AUTH_USER_NAME_COOKIE_NAME = 'custom_name';
    process.env.VITE_AUTH_USER_EMAIL_COOKIE_NAME = 'custom_email';

    expect(resolveAuthConfig()).toMatchObject({
      authBaseUrl: 'https://auth.example.com',
      cookieDomain: '.example.com',
      cookieNames: {
        access: 'custom_access',
        refresh: 'custom_refresh',
        csrf: 'custom_csrf',
        status: 'custom_status',
        userName: 'custom_name',
        userEmail: 'custom_email',
      },
      source: {
        authBaseUrl: 'env',
        cookieDomain: 'env',
        cookieNames: 'env',
      },
    });
  });

  it('keeps legacy env aliases for existing private builds', () => {
    process.env.VITE_HOME_PAGE_BASE_URL = 'https://legacy-home.example.com';
    process.env.VITE_COOKIE_DOMAIN = '.legacy.example.com';

    expect(resolveAuthConfig()).toMatchObject({
      authBaseUrl: 'https://legacy-home.example.com',
      cookieDomain: '.legacy.example.com',
      source: {
        authBaseUrl: 'env',
        cookieDomain: 'env',
      },
    });
  });
});
