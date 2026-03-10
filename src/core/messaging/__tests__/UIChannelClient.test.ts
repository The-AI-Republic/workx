import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UIChannelClient } from '../UIChannelClient';
import type { UIChannelTransport } from '../transports/types';
import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type { ChannelEvent } from '@/core/channels/types';

// ---------------------------------------------------------------------------
// Mock Transport
// ---------------------------------------------------------------------------

function createMockTransport(): UIChannelTransport & {
  _handlers: Array<(event: ChannelEvent) => void>;
  _simulateEvent(event: EventMsg): void;
} {
  const handlers: Array<(event: ChannelEvent) => void> = [];

  return {
    _handlers: handlers,
    _simulateEvent(event: EventMsg) {
      for (const h of handlers) h({ msg: event });
    },
    sendOp: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn((handler: (event: ChannelEvent) => void) => {
      handlers.push(handler);
      return () => {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      };
    }),
    initialize: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UIChannelClient', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let client: UIChannelClient;

  beforeEach(async () => {
    // Mock crypto.randomUUID
    vi.stubGlobal('crypto', { randomUUID: () => 'uuid-123' });

    transport = createMockTransport();
    client = new UIChannelClient(transport);
    await client.initialize();
  });

  afterEach(async () => {
    await client.destroy();
    vi.unstubAllGlobals();
  });

  describe('initialize', () => {
    it('initializes the transport and sets up event listener', () => {
      expect(transport.initialize).toHaveBeenCalledOnce();
      expect(transport.onEvent).toHaveBeenCalledOnce();
    });
  });

  describe('submitOp', () => {
    it('delegates to transport.sendOp', async () => {
      const op: Op = { type: 'Interrupt' };
      await client.submitOp(op, { tabId: 1 });

      expect(transport.sendOp).toHaveBeenCalledWith(op, { tabId: 1 });
    });
  });

  describe('serviceRequest', () => {
    it('sends a ServiceRequest Op with requestId', async () => {
      const promise = client.serviceRequest('mcp.getServers');

      // Verify the Op was sent
      expect(transport.sendOp).toHaveBeenCalledWith(
        {
          type: 'ServiceRequest',
          requestId: 'uuid-123',
          service: 'mcp.getServers',
          params: {},
        },
      );

      // Simulate the response
      transport._simulateEvent({
        type: 'ServiceResponse',
        data: {
          requestId: 'uuid-123',
          service: 'mcp.getServers',
          success: true,
          data: ['server1'],
        },
      } as any);

      const result = await promise;
      expect(result).toEqual(['server1']);
    });

    it('resolves when matching ServiceResponse arrives', async () => {
      const promise = client.serviceRequest('vault.status');

      transport._simulateEvent({
        type: 'ServiceResponse',
        data: {
          requestId: 'uuid-123',
          service: 'vault.status',
          success: true,
          data: { locked: false },
        },
      } as any);

      expect(await promise).toEqual({ locked: false });
    });

    it('rejects on error ServiceResponse', async () => {
      const promise = client.serviceRequest('failing.service');

      transport._simulateEvent({
        type: 'ServiceResponse',
        data: {
          requestId: 'uuid-123',
          service: 'failing.service',
          success: false,
          error: 'Something went wrong',
        },
      } as any);

      await expect(promise).rejects.toThrow('Something went wrong');
    });

    it('rejects on timeout', async () => {
      vi.useFakeTimers();

      const promise = client.serviceRequest('slow.service');

      // Fast-forward past the timeout
      vi.advanceTimersByTime(30_001);

      await expect(promise).rejects.toThrow("Service request 'slow.service' timed out");

      vi.useRealTimers();
    });

    it('passes params to the ServiceRequest Op', async () => {
      const promise = client.serviceRequest('storage.get', { key: 'theme' });

      expect(transport.sendOp).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ServiceRequest',
          params: { key: 'theme' },
        }),
      );

      transport._simulateEvent({
        type: 'ServiceResponse',
        data: { requestId: 'uuid-123', service: 'storage.get', success: true, data: 'dark' },
      } as any);

      expect(await promise).toBe('dark');
    });
  });

  describe('onEvent', () => {
    it('dispatches non-ServiceResponse events to handlers', () => {
      const handler = vi.fn();
      client.onEvent('AgentMessageDelta', handler);

      transport._simulateEvent({
        type: 'AgentMessageDelta',
        data: { delta: 'hello' },
      } as any);

      expect(handler).toHaveBeenCalledWith({ delta: 'hello' });
    });

    it('returns an unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = client.onEvent('AgentMessage', handler);

      unsub();

      transport._simulateEvent({
        type: 'AgentMessage',
        data: { message: 'test' },
      } as any);

      expect(handler).not.toHaveBeenCalled();
    });

    it('dispatches wildcard events', () => {
      const handler = vi.fn();
      client.onEvent('*', handler);

      const event = { type: 'TaskComplete', data: { submission_id: '1' } } as any;
      transport._simulateEvent(event);

      expect(handler).toHaveBeenCalledWith(event);
    });
  });

  describe('destroy', () => {
    it('rejects all pending requests', async () => {
      // Use a counter-based UUID to avoid conflicts
      let counter = 0;
      vi.stubGlobal('crypto', { randomUUID: () => `uuid-${counter++}` });

      const promise1 = client.serviceRequest('svc1');
      const promise2 = client.serviceRequest('svc2');

      await client.destroy();

      await expect(promise1).rejects.toThrow('UIChannelClient destroyed');
      await expect(promise2).rejects.toThrow('UIChannelClient destroyed');
    });

    it('destroys the transport', async () => {
      await client.destroy();

      expect(transport.destroy).toHaveBeenCalledOnce();
    });
  });

  describe('concurrent requests', () => {
    it('resolves multiple concurrent service requests independently', async () => {
      let counter = 0;
      vi.stubGlobal('crypto', { randomUUID: () => `req-${counter++}` });

      const promise1 = client.serviceRequest('svc.a');
      const promise2 = client.serviceRequest('svc.b');

      // Resolve in reverse order
      transport._simulateEvent({
        type: 'ServiceResponse',
        data: { requestId: 'req-1', service: 'svc.b', success: true, data: 'B' },
      } as any);

      transport._simulateEvent({
        type: 'ServiceResponse',
        data: { requestId: 'req-0', service: 'svc.a', success: true, data: 'A' },
      } as any);

      expect(await promise1).toBe('A');
      expect(await promise2).toBe('B');
    });
  });
});
