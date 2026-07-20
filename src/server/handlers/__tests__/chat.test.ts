import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@workx/ws-server', () => {
  const handlers = new Map<string, Function>();
  return {
    registerMethodHandler: vi.fn((method: string, handler: Function) => {
      handlers.set(method, handler);
    }),
    getMethodHandler: (method: string) => handlers.get(method),
    invalidRequest: (message: string) => ({ code: 'INVALID_REQUEST', message, retryable: false }),
  };
});

import { getMethodHandler, type MethodContext } from '@workx/ws-server';
import { registerChatHandlers, type ChatHandlerDeps } from '../chat';

function context(): MethodContext {
  return {
    connectionId: 'connection-1',
    requestId: 'request-1',
    role: 'operator',
    scopes: [],
    sessionKey: 'session-1',
    sendEvent: vi.fn(),
  };
}

describe('chat.history handler', () => {
  let deps: ChatHandlerDeps;

  beforeEach(() => {
    deps = {
      submitOp: vi.fn(),
      getHistory: vi.fn().mockResolvedValue({
        revision: 1,
        items: [],
        turns: [],
        nextCursor: null,
      }),
    };
    registerChatHandlers(deps);
  });

  it('passes validated numeric pagination parameters to canonical history', async () => {
    const handler = getMethodHandler('chat.history')!;

    await handler({ limit: 10, beforeSequence: 20 }, context());

    expect(deps.getHistory).toHaveBeenCalledWith('session-1', {
      limit: 10,
      beforeSequence: 20,
    });
  });

  it.each([
    [{ limit: '10' }, '"limit" must be an integer'],
    [{ limit: 0 }, '"limit" must be an integer'],
    [{ beforeSequence: '20' }, '"beforeSequence" must be a non-negative safe integer'],
    [{ beforeSequence: -1 }, '"beforeSequence" must be a non-negative safe integer'],
  ])('rejects invalid pagination parameters %#', async (params, message) => {
    const handler = getMethodHandler('chat.history')!;

    await expect(handler(params, context())).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: expect.stringContaining(message),
    });
    expect(deps.getHistory).not.toHaveBeenCalled();
  });
});
