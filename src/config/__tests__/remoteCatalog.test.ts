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
    models: [{ name: 'Remote Fable', modelKey: 'claude-fable-5' }],
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

  it('replaces provider/model data while preserving bundled per-model OpenHub routes', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse(VALID_CATALOG));

    const result = await fetchRemoteCatalog();
    expect(result).not.toBeNull();
    expect(getRemoteProviders()).toMatchObject({ anthropic: { id: 'anthropic' } });

    const providers = getDefaultProviders();
    expect(Object.keys(providers)).toEqual(['anthropic']);
    expect(providers.anthropic.models[0].name).toBe('Remote Fable');
    expect(providers.anthropic.models[0].openHubRoute).toEqual({
      modelSlug: 'anthropic/claude-fable-5',
      providerSlug: 'anthropic',
    });
  });

  it('accepts providers without models without crashing the route overlay', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse({
      ...VALID_CATALOG,
      openai: { id: 'openai', name: 'OpenAI', apiKey: '', timeout: 30000 },
    }));

    await fetchRemoteCatalog();

    expect(getDefaultProviders().openai.models).toEqual([]);
  });

  it('defines an explicit OpenHub route for every bundled model', () => {
    const providers = getDefaultProviders();
    expect(Object.fromEntries(Object.entries(providers).flatMap(([providerId, provider]) =>
      provider.models.map((model) => [
        `${providerId}:${model.modelKey}`,
        model.openHubRoute,
      ]),
    ))).toEqual({
      'xai:grok-4-1-fast-reasoning': {
        modelSlug: 'x-ai/grok-4-1-fast-reasoning', providerSlug: 'xai',
      },
      'openai:gpt-5.5': { modelSlug: 'openai/gpt-5.5', providerSlug: 'azure' },
      'openai:gpt-5.4': { modelSlug: 'openai/gpt-5.4', providerSlug: 'azure' },
      'google-ai-studio:gemini-3.1-pro': {
        modelSlug: 'google/gemini-3.1-pro', providerSlug: 'google-ai-studio',
      },
      'deepseek:deepseek-v4-flash': {
        modelSlug: 'deepseek/deepseek-v4-flash', providerSlug: 'deepseek',
      },
      'anthropic:claude-opus-4-8': {
        modelSlug: 'anthropic/claude-opus-4-8', providerSlug: 'deepinfra',
      },
      'anthropic:claude-sonnet-4-6': {
        modelSlug: 'anthropic/claude-sonnet-4-6', providerSlug: 'deepinfra',
      },
      'anthropic:claude-fable-5': {
        modelSlug: 'anthropic/claude-fable-5', providerSlug: 'anthropic',
      },
      'anthropic:claude-haiku-4-5-20251001': {
        modelSlug: 'anthropic/claude-haiku-4.5', providerSlug: 'anthropic',
      },
    });
  });

  it('falls back (null cache) on a non-ok response', async () => {
    process.env.WORKX_MODEL_CATALOG_URL = CATALOG_URL;
    mockFetchOnce(() => jsonResponse({}, false, 503));

    expect(await fetchRemoteCatalog()).toBeNull();
    expect(getRemoteProviders()).toBeNull();
    // bundled default still used
    expect(getDefaultProviders().anthropic.models.some((m) => m.name === 'Remote Fable')).toBe(false);
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
    // Remote catalog has only anthropic:claude-fable-5 — the hardcoded default
    // deepseek:deepseek-v4-flash is NOT present.
    mockFetchOnce(() => jsonResponse(VALID_CATALOG));
    await fetchRemoteCatalog();

    const stored = { ...getDefaultStoredConfig(), selectedModelKey: 'deepseek:deepseek-v4-flash' };
    const config = buildRuntimeConfig(stored);

    // Must not keep a key that isn't in the replaced catalog.
    expect(config.selectedModelKey).toBe('anthropic:claude-fable-5');
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
