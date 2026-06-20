import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('@workx/ws-server', () => {
  const handlers = new Map<string, Function>();
  return {
    registerMethodHandler: vi.fn((method: string, handler: Function) => {
      handlers.set(method, handler);
    }),
    getMethodHandler: (method: string) => handlers.get(method),
    invalidRequest: (msg: string) => ({ code: 'INVALID_REQUEST', message: msg, retryable: false }),
    unauthorized: (msg: string) => ({ code: 'UNAUTHORIZED', message: msg, retryable: false }),
  };
});

vi.mock('../../auth/authorize', () => ({
  getConnectionAuth: vi.fn(),
}));

vi.mock('../../config/server-config', () => ({
  getServerConfig: vi.fn(),
}));

import { registerCredentialsHandlers, type CredentialHandlerDeps } from '../credentials';
import { getMethodHandler } from '@workx/ws-server';
import { getConnectionAuth } from '../../auth/authorize';
import { getServerConfig } from '../../config/server-config';
import type { MethodContext } from '@workx/ws-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<MethodContext>): MethodContext {
  return {
    connectionId: 'conn_test123',
    requestId: 'req_1',
    role: 'operator',
    scopes: ['credentials.read', 'credentials.write'],
    sendEvent: vi.fn(),
    ...overrides,
  };
}

function mockLoopback(): void {
  vi.mocked(getConnectionAuth).mockReturnValue({
    connectionId: 'conn_test123',
    role: 'operator',
    scopes: ['credentials.read', 'credentials.write'],
    authenticated: true,
    isLoopback: true,
  });
  vi.mocked(getServerConfig).mockReturnValue({
    server: { tls: { enabled: false } },
  } as any);
}

function mockRemoteNoTls(): void {
  vi.mocked(getConnectionAuth).mockReturnValue({
    connectionId: 'conn_test123',
    role: 'operator',
    scopes: ['credentials.read', 'credentials.write'],
    authenticated: true,
    isLoopback: false,
  });
  vi.mocked(getServerConfig).mockReturnValue({
    server: { tls: { enabled: false } },
  } as any);
}

function mockTlsEnabled(): void {
  vi.mocked(getConnectionAuth).mockReturnValue({
    connectionId: 'conn_test123',
    role: 'operator',
    scopes: ['credentials.read', 'credentials.write'],
    authenticated: true,
    isLoopback: false,
  });
  vi.mocked(getServerConfig).mockReturnValue({
    server: { tls: { enabled: true } },
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('credentials handlers', () => {
  let deps: CredentialHandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      setProviderApiKey: vi.fn().mockResolvedValue({}),
      deleteProviderApiKey: vi.fn().mockResolvedValue(undefined),
      listProviders: vi.fn().mockResolvedValue([
        { id: 'openai', name: 'OpenAI', hasKey: true },
        { id: 'anthropic', name: 'Anthropic', hasKey: false },
      ]),
    };
    registerCredentialsHandlers(deps);
  });

  // ── credentials.list ──────────────────────────────────────────────────

  describe('credentials.list', () => {
    it('returns provider metadata without secrets', async () => {
      mockLoopback();
      const handler = getMethodHandler('credentials.list')!;
      const result = await handler({}, makeCtx());
      expect(result).toEqual({
        providers: [
          { id: 'openai', name: 'OpenAI', hasKey: true },
          { id: 'anthropic', name: 'Anthropic', hasKey: false },
        ],
      });
    });
  });

  // ── credentials.set ───────────────────────────────────────────────────

  describe('credentials.set', () => {
    it('succeeds on loopback', async () => {
      mockLoopback();
      const handler = getMethodHandler('credentials.set')!;
      const result = await handler(
        { providerId: 'openai', apiKey: 'sk-test' },
        makeCtx()
      );
      expect(result).toEqual({ status: 'ok', providerId: 'openai' });
      expect(deps.setProviderApiKey).toHaveBeenCalledWith('openai', 'sk-test');
    });

    it('succeeds with TLS enabled (remote)', async () => {
      mockTlsEnabled();
      const handler = getMethodHandler('credentials.set')!;
      const result = await handler(
        { providerId: 'openai', apiKey: 'sk-test' },
        makeCtx()
      );
      expect(result).toEqual({ status: 'ok', providerId: 'openai' });
    });

    it('rejects non-TLS remote connection', async () => {
      mockRemoteNoTls();
      const handler = getMethodHandler('credentials.set')!;
      await expect(
        handler({ providerId: 'openai', apiKey: 'sk-test' }, makeCtx())
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('TLS or loopback'),
      });
    });

    it('rejects missing providerId', async () => {
      mockLoopback();
      const handler = getMethodHandler('credentials.set')!;
      await expect(
        handler({ apiKey: 'sk-test' }, makeCtx())
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('providerId'),
      });
    });

    it('rejects missing apiKey', async () => {
      mockLoopback();
      const handler = getMethodHandler('credentials.set')!;
      await expect(
        handler({ providerId: 'openai' }, makeCtx())
      ).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('apiKey'),
      });
    });
  });

  // ── credentials.delete ────────────────────────────────────────────────

  describe('credentials.delete', () => {
    it('succeeds on loopback', async () => {
      mockLoopback();
      const handler = getMethodHandler('credentials.delete')!;
      const result = await handler({ providerId: 'openai' }, makeCtx());
      expect(result).toEqual({ status: 'ok', providerId: 'openai' });
      expect(deps.deleteProviderApiKey).toHaveBeenCalledWith('openai');
    });

    it('rejects non-TLS remote connection', async () => {
      mockRemoteNoTls();
      const handler = getMethodHandler('credentials.delete')!;
      await expect(
        handler({ providerId: 'openai' }, makeCtx())
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: expect.stringContaining('TLS or loopback'),
      });
    });

    it('rejects missing providerId', async () => {
      mockLoopback();
      const handler = getMethodHandler('credentials.delete')!;
      await expect(handler({}, makeCtx())).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
        message: expect.stringContaining('providerId'),
      });
    });
  });

  // ── deps not initialized ──────────────────────────────────────────────

  describe('deps not initialized', () => {
    it('handlers are not registered before registerCredentialsHandlers is called', async () => {
      vi.resetModules();

      vi.doMock('@workx/ws-server', () => {
        const handlers = new Map<string, Function>();
        return {
          registerMethodHandler: vi.fn((method: string, handler: Function) => {
            handlers.set(method, handler);
          }),
          getMethodHandler: (method: string) => handlers.get(method),
          invalidRequest: (msg: string) => ({ code: 'INVALID_REQUEST', message: msg, retryable: false }),
          unauthorized: (msg: string) => ({ code: 'UNAUTHORIZED', message: msg, retryable: false }),
        };
      });
      vi.doMock('../../auth/authorize', () => ({
        getConnectionAuth: vi.fn(),
      }));
      vi.doMock('../../config/server-config', () => ({
        getServerConfig: vi.fn(),
      }));

      // Import fresh module — no handlers registered yet
      await import('../credentials');
      const { getMethodHandler: freshGet } = await import('@workx/ws-server');

      expect(freshGet('credentials.list')).toBeUndefined();
      expect(freshGet('credentials.set')).toBeUndefined();
      expect(freshGet('credentials.delete')).toBeUndefined();
    });

    it('throws "not initialized" when deps are forced to null', async () => {
      vi.resetModules();

      vi.doMock('@workx/ws-server', () => {
        const handlers = new Map<string, Function>();
        return {
          registerMethodHandler: vi.fn((method: string, handler: Function) => {
            handlers.set(method, handler);
          }),
          getMethodHandler: (method: string) => handlers.get(method),
          invalidRequest: (msg: string) => ({ code: 'INVALID_REQUEST', message: msg, retryable: false }),
          unauthorized: (msg: string) => ({ code: 'UNAUTHORIZED', message: msg, retryable: false }),
        };
      });
      vi.doMock('../../auth/authorize', () => ({
        getConnectionAuth: vi.fn().mockReturnValue({ isLoopback: true }),
      }));
      vi.doMock('../../config/server-config', () => ({
        getServerConfig: vi.fn().mockReturnValue({ server: { tls: { enabled: false } } }),
      }));

      const { registerCredentialsHandlers: freshRegister } = await import('../credentials');
      const { getMethodHandler: freshGet } = await import('@workx/ws-server');

      // Register with null deps (cast) to get handler refs while _deps stays null
      freshRegister(null as any);

      const listHandler = freshGet('credentials.list')!;
      const setHandler = freshGet('credentials.set')!;
      const deleteHandler = freshGet('credentials.delete')!;

      await expect(listHandler({}, makeCtx())).rejects.toThrow('Credential handlers not initialized');
      await expect(setHandler({ providerId: 'x', apiKey: 'y' }, makeCtx())).rejects.toThrow('Credential handlers not initialized');
      await expect(deleteHandler({ providerId: 'x' }, makeCtx())).rejects.toThrow('Credential handlers not initialized');
    });
  });
});
