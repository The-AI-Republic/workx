import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRemoteCatalog, getRemoteProviders, clearRemoteCatalog } from '../remoteCatalog';
import { getDefaultProviders, buildRuntimeConfig, getDefaultStoredConfig } from '../defaults';

const CATALOG_URL = 'https://api.example.com/api/v1/workx/models';

const VALID_CATALOG = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    apiKey: '',
    timeout: 30000,
    models: [{ name: 'Remote Opus', modelKey: 'remote-opus-x' }],
  },
};

function mockFetchOnce(impl: () => Promise<Response> | Response) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('remoteCatalog', () => {
  const original = process.env.WORKX_MODEL_CATALOG_URL;

  beforeEach(() => {
    clearRemoteCatalog();
    delete process.env.WORKX_MODEL_CATALOG_URL;
  });

  afterEach(() => {
    clearRemoteCatalog();
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.WORKX_MODEL_CATALOG_URL;
    else process.env.WORKX_MODEL_CATALOG_URL = original;
  });

  it('is a no-op and makes no request when no catalog URL is configured', async () => {
    const fetchFn = mockFetchOnce(() => jsonResponse(VALID_CATALOG));
    const result = await fetchRemoteCatalog();
    expect(result).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(getRemoteProviders()).toBeNull();
  });

  it('replaces provider/model data while preserving bundled OpenHub routing pins', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse(VALID_CATALOG));

    const result = await fetchRemoteCatalog();
    expect(result).not.toBeNull();
    expect(getRemoteProviders()).toMatchObject({ anthropic: { id: 'anthropic' } });

    const providers = getDefaultProviders();
    expect(Object.keys(providers)).toEqual(['anthropic']);
    expect(providers.anthropic.models[0].modelKey).toBe('remote-opus-x');
    expect(providers.anthropic.openHubProviderSlug).toBe('anthropic');
  });

  it('defines an explicit OpenHub routing pin for every bundled provider', () => {
    const providers = getDefaultProviders();
    expect(Object.fromEntries(Object.entries(providers).map(([id, provider]) => [
      id,
      provider.openHubProviderSlug,
    ]))).toEqual({
      xai: 'xai',
      openai: 'openai',
      'google-ai-studio': 'google-ai-studio',
      deepseek: 'deepseek',
      anthropic: 'anthropic',
    });
  });

  it('falls back (null cache) on a non-ok response', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse({}, false, 503));

    expect(await fetchRemoteCatalog()).toBeNull();
    expect(getRemoteProviders()).toBeNull();
    // bundled default still used
    expect(getDefaultProviders().anthropic.models.some((m: { modelKey: string }) => m.modelKey === 'remote-opus-x')).toBe(false);
  });

  it('rejects a malformed payload (no models with modelKey) and keeps the bundled default', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse({ anthropic: { id: 'anthropic', models: [{ name: 'x' }] } }));

    expect(await fetchRemoteCatalog()).toBeNull();
    expect(getRemoteProviders()).toBeNull();
  });

  it('rejects a non-object payload', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse([1, 2, 3]));
    expect(await fetchRemoteCatalog()).toBeNull();
  });

  it('swallows network errors and falls back', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => { throw new Error('boom'); });
    expect(await fetchRemoteCatalog()).toBeNull();
    expect(getRemoteProviders()).toBeNull();
  });

  it('buildRuntimeConfig falls back to the first available model when the hardcoded default is absent from a replaced catalog', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    // Remote catalog has only anthropic:remote-opus-x — the hardcoded default
    // deepseek:deepseek-v4-flash is NOT present.
    mockFetchOnce(() => jsonResponse(VALID_CATALOG));
    await fetchRemoteCatalog();

    const stored = { ...getDefaultStoredConfig(), selectedModelKey: 'deepseek:deepseek-v4-flash' };
    const config = buildRuntimeConfig(stored);

    // Must not keep a key that isn't in the replaced catalog.
    expect(config.selectedModelKey).toBe('anthropic:remote-opus-x');
  });

  it('buildRuntimeConfig keeps the default when it IS present in the catalog', async () => {
    // No remote catalog -> bundled default.json, which contains the default.
    const stored = { ...getDefaultStoredConfig(), selectedModelKey: 'deepseek:deepseek-v4-flash' };
    const config = buildRuntimeConfig(stored);
    expect(config.selectedModelKey).toBe('deepseek:deepseek-v4-flash');
  });

  it('dedupes concurrent fetches into a single request', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    const fetchFn = mockFetchOnce(async () => jsonResponse(VALID_CATALOG));

    const [a, b] = await Promise.all([fetchRemoteCatalog(), fetchRemoteCatalog()]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
