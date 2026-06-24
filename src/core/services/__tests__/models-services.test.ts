import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModelServices, testModelConnection } from '../models-services';

const handler = createModelServices({})['models.testConnection'];
const context = {} as Parameters<typeof handler>[1];

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

const OPENAI = {
  providerId: 'moonshot',
  baseUrl: 'https://api.moonshot.ai/v1',
  apiKey: 'sk-test',
  model: 'kimi-k2',
  organization: null,
};

describe('models.testConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lists models (prompt-free) and reports valid on 200', async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(OPENAI, context);

    expect(result).toEqual({ valid: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.moonshot.ai/v1/models');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
    // Prompt-free: only one request, no chat/completions.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports invalid API key on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { error: 'unauthorized' })));
    const result = await handler(OPENAI, context);
    expect(result).toEqual({ valid: false, error: 'Invalid API key' });
  });

  it('falls back to a 1-token completion when /models is unsupported (404)', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(OPENAI, context);

    expect(result).toEqual({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.max_tokens).toBe(1);
  });

  it('preserves base URL query params when appending probe paths', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(
      {
        providerId: 'custom-azure',
        baseUrl: 'https://example.openai.azure.com/openai/deployments/test/chat/completions?api-version=2024-02-15',
        apiKey: 'sk-custom',
        model: 'deployment-name',
        isCustom: true,
        apiFormat: 'chat_completions',
      },
      context,
    );

    expect(result).toEqual({ valid: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.openai.azure.com/openai/deployments/test/models?api-version=2024-02-15',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://example.openai.azure.com/openai/deployments/test/chat/completions?api-version=2024-02-15',
    );
  });

  it('treats a 400 from the minimal payload as a valid key', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'bad request' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await handler(OPENAI, context)).toEqual({ valid: true });
  });

  it('uses Anthropic auth headers + messages endpoint on fallback', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(405))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    await handler(
      { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'ak', model: 'claude-3' },
      context,
    );

    const [listUrl, listInit] = fetchMock.mock.calls[0];
    expect(listUrl).toBe('https://api.anthropic.com/v1/models');
    expect((listInit?.headers as Record<string, string>)['x-api-key']).toBe('ak');
    expect((listInit?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    const [msgUrl] = fetchMock.mock.calls[1];
    expect(msgUrl).toBe('https://api.anthropic.com/v1/messages');
  });

  it('uses Google AI Studio native models endpoint with API key query auth', async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(200, { models: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(
      {
        providerId: 'google-ai-studio',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'AIza-test',
        model: 'gemini-3.1-pro',
      },
      context,
    );

    expect(result).toEqual({ valid: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?key=AIza-test');
    expect(init?.method).toBe('GET');
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('reports invalid Google API keys from the Google 400 error shape', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(400, {
      error: { message: 'API key not valid. Please pass a valid API key.' },
    })));

    expect(await handler(
      {
        providerId: 'google-ai-studio',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'bad',
        model: 'gemini-3.1-pro',
      },
      context,
    )).toEqual({ valid: false, error: 'Invalid API key' });
  });

  it('falls back to /responses for custom Responses API providers', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(
      {
        providerId: 'custom-abc',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-custom',
        model: 'custom-model',
        apiFormat: 'responses',
        isCustom: true,
      },
      context,
    );

    expect(result).toEqual({ valid: true });
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.example.com/v1/responses');
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: 'custom-model', input: 'ping', max_output_tokens: 1 });
  });

  it('validates required params', async () => {
    expect(await testModelConnection()).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(await handler({ baseUrl: 'https://x/v1' }, context)).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(await handler({ apiKey: 'k' }, context)).toEqual({
      valid: false,
      error: 'Base URL is required',
    });
  });

  it('returns a network error message when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await handler(OPENAI, context)).toEqual({ valid: false, error: 'ECONNREFUSED' });
  });

  it('times out a hanging provider request', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<FetchFn>(
      (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = handler(OPENAI, context);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toEqual({
      valid: false,
      error: 'Connection test timed out after 30 seconds',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
