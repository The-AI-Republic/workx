import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@workx/ws-server', () => {
  const handlers = new Map<string, Function>();
  return {
    registerMethodHandler: vi.fn((method: string, handler: Function) => {
      handlers.set(method, handler);
    }),
    getMethodHandler: (method: string) => handlers.get(method),
    unauthorized: (msg: string) => ({ code: 'UNAUTHORIZED', message: msg, retryable: false }),
  };
});

vi.mock('../../auth/authorize', () => ({
  getConnectionAuth: vi.fn(),
}));

vi.mock('../../config/server-config', () => ({
  getServerConfig: vi.fn(),
}));

vi.mock('@/core/services/models-services', () => ({
  testModelConnection: vi.fn(),
}));

import { getMethodHandler } from '@workx/ws-server';
import type { MethodContext } from '@workx/ws-server';
import { testModelConnection } from '@/core/services/models-services';
import { getConnectionAuth } from '../../auth/authorize';
import { getServerConfig } from '../../config/server-config';
import { registerModelHandlers } from '../models';

function makeCtx(overrides?: Partial<MethodContext>): MethodContext {
  return {
    connectionId: 'conn_test123',
    requestId: 'req_1',
    role: 'operator',
    scopes: ['credentials.write'],
    sendEvent: vi.fn(),
    ...overrides,
  };
}

function mockLoopback(): void {
  vi.mocked(getConnectionAuth).mockReturnValue({
    connectionId: 'conn_test123',
    role: 'operator',
    scopes: ['credentials.write'],
    authenticated: true,
    isLoopback: true,
  });
  vi.mocked(getServerConfig).mockReturnValue({
    server: { tls: { enabled: false } },
  } as ReturnType<typeof getServerConfig>);
}

function mockRemoteNoTls(): void {
  vi.mocked(getConnectionAuth).mockReturnValue({
    connectionId: 'conn_test123',
    role: 'operator',
    scopes: ['credentials.write'],
    authenticated: true,
    isLoopback: false,
  });
  vi.mocked(getServerConfig).mockReturnValue({
    server: { tls: { enabled: false } },
  } as ReturnType<typeof getServerConfig>);
}

function mockTlsEnabled(): void {
  vi.mocked(getConnectionAuth).mockReturnValue({
    connectionId: 'conn_test123',
    role: 'operator',
    scopes: ['credentials.write'],
    authenticated: true,
    isLoopback: false,
  });
  vi.mocked(getServerConfig).mockReturnValue({
    server: { tls: { enabled: true } },
  } as ReturnType<typeof getServerConfig>);
}

describe('models handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerModelHandlers();
    vi.mocked(testModelConnection).mockResolvedValue({ valid: true });
  });

  it('registers models.testConnection and delegates on loopback', async () => {
    mockLoopback();
    const handler = getMethodHandler('models.testConnection')!;

    const params = { providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test' };
    await expect(handler(params, makeCtx())).resolves.toEqual({ valid: true });
    expect(testModelConnection).toHaveBeenCalledWith(params);
  });

  it('allows remote connection tests over TLS', async () => {
    mockTlsEnabled();
    const handler = getMethodHandler('models.testConnection')!;

    await expect(handler({ apiKey: 'sk-test' }, makeCtx())).resolves.toEqual({ valid: true });
  });

  it('rejects non-TLS remote connection tests', async () => {
    mockRemoteNoTls();
    const handler = getMethodHandler('models.testConnection')!;

    await expect(handler({ apiKey: 'sk-test' }, makeCtx())).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: expect.stringContaining('TLS or loopback'),
    });
    expect(testModelConnection).not.toHaveBeenCalled();
  });
});
