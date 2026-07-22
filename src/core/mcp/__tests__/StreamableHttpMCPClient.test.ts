import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMCPServerConfig } from '../types';

let StreamableHttpMCPClient: typeof import('../StreamableHttpMCPClient').StreamableHttpMCPClient;

const mocks = vi.hoisted(() => {
  const transports: any[] = [];
  const defaultTools = {
    tools: [
      {
        name: 'app_search',
        description: 'Search apps',
        inputSchema: { type: 'object' },
      },
    ],
  };
  const Transport = vi.fn();
  const Client = vi.fn();
  const listTools = vi.fn();
  const callTool = vi.fn();
  return { transports, defaultTools, Transport, Client, listTools, callTool };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: mocks.Transport,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: mocks.Client,
}));

function config(overrides: Partial<IMCPServerConfig> = {}): IMCPServerConfig {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    name: 'gateway',
    url: 'https://gateway.example.com/mcp',
    enabled: true,
    timeout: 30000,
    transport: 'streamable-http',
    authMode: 'api-key',
    headers: { 'X-Custom-Tool-Discovery': 'folded' },
    platform: 'desktop',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('StreamableHttpMCPClient', () => {
  beforeAll(async () => {
    ({ StreamableHttpMCPClient } = await import('../StreamableHttpMCPClient'));
  });

  beforeEach(() => {
    mocks.transports.length = 0;
    mocks.Transport.mockReset().mockImplementation(function transport(this: any, url: URL, opts: any) {
      this.url = url;
      this.opts = opts;
      this.onclose = undefined;
      this.onerror = undefined;
      this.protocolVersion = '2025-01-01';
      this.close = vi.fn(async () => undefined);
      mocks.transports.push(this);
    });
    mocks.listTools.mockReset().mockResolvedValue(mocks.defaultTools);
    mocks.callTool.mockReset().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
    });
    mocks.Client.mockReset().mockImplementation(() => ({
      connect: vi.fn(async () => undefined),
      getServerVersion: vi.fn(() => ({ name: 'hub', version: '1.0.0' })),
      getServerCapabilities: vi.fn(() => ({ tools: {} })),
      listTools: mocks.listTools,
      callTool: mocks.callTool,
      listResources: vi.fn(async () => ({ resources: [] })),
      readResource: vi.fn(async () => ({ contents: [] })),
    }));
  });

  it('injects the API key and configured headers into transport fetches', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    const client = new StreamableHttpMCPClient({
      config: config(),
      tokenProvider: async () => 'api-key-123',
    });

    await client.connect();
    await mocks.transports[0].opts.fetch('https://gateway.example.com/mcp', {
      headers: new Headers({ Accept: 'application/json' }),
    });

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const headers = requestInit.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer api-key-123');
    expect(headers.get('X-Custom-Tool-Discovery')).toBe('folded');
  });

  it('reports the negotiated protocol version after connect', async () => {
    const client = new StreamableHttpMCPClient({
      config: config(),
      tokenProvider: async () => 'api-key-123',
    });

    await client.connect();

    expect(client.getProtocolVersion()).toBe('2025-01-01');
  });

  it('refreshes and retries dynamic API-key fetches once after a 401', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const refreshTokenProvider = vi.fn(async () => 'api-key-new');
    const client = new StreamableHttpMCPClient({
      config: config(),
      tokenProvider: async () => 'api-key-old',
      refreshTokenProvider,
    });

    await client.connect();
    const response = await mocks.transports[0].opts.fetch('https://gateway.example.com/mcp');

    expect(response.status).toBe(200);
    expect(refreshTokenProvider).toHaveBeenCalledTimes(1);
    const firstHeaders = fetchMock.mock.calls[0][1].headers as Headers;
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(firstHeaders.get('Authorization')).toBe('Bearer api-key-old');
    expect(secondHeaders.get('Authorization')).toBe('Bearer api-key-new');
  });

  it('refreshes tools after app activation changes folded discovery output', async () => {
    const client = new StreamableHttpMCPClient({
      config: config(),
      tokenProvider: async () => 'api-key-123',
    });

    await client.connect();
    await client.callTool('app_activate', { appId: 'zoominfo' });

    expect(mocks.callTool).toHaveBeenCalledWith({
      name: 'app_activate',
      arguments: { appId: 'zoominfo' },
    });
    expect(mocks.listTools).toHaveBeenCalledTimes(2);
  });
});
