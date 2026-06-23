import { afterEach, describe, expect, it, vi } from 'vitest';

import { createModelServices } from '../models-services';

const handler = createModelServices({})['models.testConnection'];

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
    vi.unstubAllGlobals();
  });

  it('lists models (prompt-free) and reports valid on 200', async () => {
    const fetchMock = vi.fn<FetchFn>(async () => jsonResponse(200, { data: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(OPENAI, {} as any);

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
    const result = await handler(OPENAI, {} as any);
    expect(result).toEqual({ valid: false, error: 'Invalid API key' });
  });

  it('falls back to a 1-token completion when /models is unsupported (404)', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(404, { error: 'not found' }))
      .mockResolvedValueOnce(jsonResponse(200, { id: 'x' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handler(OPENAI, {} as any);

    expect(result).toEqual({ valid: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://api.moonshot.ai/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.max_tokens).toBe(1);
  });

  it('treats a 400 from the minimal payload as a valid key', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'bad request' }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await handler(OPENAI, {} as any)).toEqual({ valid: true });
  });

  it('uses Anthropic auth headers + messages endpoint on fallback', async () => {
    const fetchMock = vi
      .fn<FetchFn>()
      .mockResolvedValueOnce(jsonResponse(405))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    await handler(
      { providerId: 'anthropic', baseUrl: 'https://api.anthropic.com/v1/messages', apiKey: 'ak', model: 'claude-3' },
      {} as any,
    );

    const [listUrl, listInit] = fetchMock.mock.calls[0];
    expect(listUrl).toBe('https://api.anthropic.com/v1/models');
    expect((listInit?.headers as Record<string, string>)['x-api-key']).toBe('ak');
    expect((listInit?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    const [msgUrl] = fetchMock.mock.calls[1];
    expect(msgUrl).toBe('https://api.anthropic.com/v1/messages');
  });

  it('validates required params', async () => {
    expect(await handler({ baseUrl: 'https://x/v1' }, {} as any)).toEqual({
      valid: false,
      error: 'API key is required',
    });
    expect(await handler({ apiKey: 'k' }, {} as any)).toEqual({
      valid: false,
      error: 'Base URL is required',
    });
  });

  it('returns a network error message when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    expect(await handler(OPENAI, {} as any)).toEqual({ valid: false, error: 'ECONNREFUSED' });
  });
});
