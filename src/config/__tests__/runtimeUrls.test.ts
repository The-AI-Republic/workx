import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRuntimeUrls } from '../runtimeUrls';

const ENV_KEYS = [
  'APPLEPI_HOME_PAGE_BASE_URL',
  'APPLEPI_BACKEND_API_BASE_URL',
  'VITE_HOME_PAGE_BASE_URL',
  'VITE_BACKEND_API_BASE_URL',
] as const;

const originalEnv = new Map<string, string | undefined>();

describe('resolveRuntimeUrls', () => {
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

  it('uses production defaults when no runtime env is set', () => {
    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      homePageBaseUrl: 'https://airepublic.com',
      backendApiBaseUrl: null,
      llmApiUrl: '/api/llm',
      deeplinkRedirectUrl: 'applepi://auth/callback',
      source: {
        homePageBaseUrl: 'default',
        backendApiBaseUrl: 'default',
        llmApiUrl: 'default',
        deeplinkRedirectUrl: 'default',
      },
    });
  });

  it('prefers APPLEPI env values over VITE env values', () => {
    process.env.APPLEPI_HOME_PAGE_BASE_URL = 'https://localhome.airepublic.com';
    process.env.VITE_HOME_PAGE_BASE_URL = 'https://vite-home.example.com';
    process.env.APPLEPI_BACKEND_API_BASE_URL = 'https://backend.example.com';
    process.env.VITE_BACKEND_API_BASE_URL = 'https://vite-backend.example.com';

    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      homePageBaseUrl: 'https://localhome.airepublic.com',
      backendApiBaseUrl: 'https://backend.example.com',
      llmApiUrl: 'https://backend.example.com/api/llm',
      source: {
        homePageBaseUrl: 'env',
        backendApiBaseUrl: 'env',
        llmApiUrl: 'env',
      },
    });
  });

  it('falls back to process VITE env values', () => {
    process.env.VITE_HOME_PAGE_BASE_URL = 'https://vite-home.example.com';
    process.env.VITE_BACKEND_API_BASE_URL = 'https://vite-backend.example.com';

    const urls = resolveRuntimeUrls();

    expect(urls).toMatchObject({
      homePageBaseUrl: 'https://vite-home.example.com',
      backendApiBaseUrl: 'https://vite-backend.example.com',
      llmApiUrl: 'https://vite-backend.example.com/api/llm',
      source: {
        homePageBaseUrl: 'env',
        backendApiBaseUrl: 'env',
        llmApiUrl: 'env',
      },
    });
  });
});
