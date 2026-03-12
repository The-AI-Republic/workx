/**
 * End-to-end integration test: UIChannelClient → Transport → ServiceResponse
 *
 * Verifies the full RPC round-trip using an in-memory transport that
 * simulates the backend (ServiceRegistry + ChannelManager) responding
 * to ServiceRequest ops.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { UIChannelClient } from '../UIChannelClient';
import type { UIChannelTransport } from '../transports/types';
import type { Op } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type { ChannelEvent } from '@/core/channels/types';

// ---------------------------------------------------------------------------
// In-memory transport that simulates backend service handling
// ---------------------------------------------------------------------------

class InMemoryTransport implements UIChannelTransport {
  private eventListeners: Array<(event: ChannelEvent) => void> = [];
  private serviceHandlers = new Map<string, (params: Record<string, unknown>) => unknown>();

  /** Register a mock service handler (simulates ServiceRegistry) */
  mockService(path: string, handler: (params: Record<string, unknown>) => unknown): void {
    this.serviceHandlers.set(path, handler);
  }

  async sendOp(op: Op): Promise<void> {
    // Simulate backend handling of ServiceRequest
    if (op.type === 'ServiceRequest') {
      const { requestId, service, params } = op as any;
      const handler = this.serviceHandlers.get(service);

      // Respond asynchronously (as a real backend would)
      queueMicrotask(() => {
        let responseEvent: EventMsg;
        if (handler) {
          try {
            const data = handler(params);
            responseEvent = {
              type: 'ServiceResponse',
              data: { requestId, service, success: true, data },
            } as EventMsg;
          } catch (err: any) {
            responseEvent = {
              type: 'ServiceResponse',
              data: { requestId, service, success: false, error: err.message },
            } as EventMsg;
          }
        } else {
          responseEvent = {
            type: 'ServiceResponse',
            data: { requestId, service, success: false, error: `Unknown service: ${service}` },
          } as EventMsg;
        }

        for (const listener of this.eventListeners) {
          listener({ msg: responseEvent });
        }
      });
    }
  }

  onEvent(handler: (event: ChannelEvent) => void): () => void {
    this.eventListeners.push(handler);
    return () => {
      this.eventListeners = this.eventListeners.filter((h) => h !== handler);
    };
  }

  async initialize(): Promise<void> {}
  async destroy(): Promise<void> {
    this.eventListeners = [];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UIChannelClient end-to-end', () => {
  let transport: InMemoryTransport;
  let client: UIChannelClient;

  beforeEach(async () => {
    transport = new InMemoryTransport();
    client = new UIChannelClient(transport);
    await client.initialize();
  });

  afterEach(async () => {
    await client.destroy();
  });

  it('completes a successful service request round-trip', async () => {
    transport.mockService('mcp.getServers', () => [
      { id: '1', name: 'Server A' },
      { id: '2', name: 'Server B' },
    ]);

    const result = await client.serviceRequest<Array<{ id: string; name: string }>>('mcp.getServers');

    expect(result).toEqual([
      { id: '1', name: 'Server A' },
      { id: '2', name: 'Server B' },
    ]);
  });

  it('passes params to the service handler', async () => {
    transport.mockService('mcp.removeServer', (params) => {
      return { removed: params.id };
    });

    const result = await client.serviceRequest<{ removed: string }>('mcp.removeServer', { id: 'srv-42' });

    expect(result).toEqual({ removed: 'srv-42' });
  });

  it('rejects on service handler error', async () => {
    transport.mockService('vault.unlock', () => {
      throw new Error('Invalid PIN');
    });

    await expect(client.serviceRequest('vault.unlock', { pin: '0000' })).rejects.toThrow('Invalid PIN');
  });

  it('rejects on unknown service', async () => {
    await expect(client.serviceRequest('nonexistent.service')).rejects.toThrow('Unknown service: nonexistent.service');
  });

  it('handles concurrent requests with independent requestIds', async () => {
    transport.mockService('storage.get', (params) => ({ key: params.key, value: `val_${params.key}` }));

    const [r1, r2, r3] = await Promise.all([
      client.serviceRequest<any>('storage.get', { key: 'a' }),
      client.serviceRequest<any>('storage.get', { key: 'b' }),
      client.serviceRequest<any>('storage.get', { key: 'c' }),
    ]);

    expect(r1).toEqual({ key: 'a', value: 'val_a' });
    expect(r2).toEqual({ key: 'b', value: 'val_b' });
    expect(r3).toEqual({ key: 'c', value: 'val_c' });
  });

  it('dispatches non-ServiceResponse events to onEvent handlers', async () => {
    const handler = vi.fn();
    client.onEvent('StateUpdate', handler);

    // Simulate backend pushing a state update event
    const stateEvent: EventMsg = {
      type: 'StateUpdate',
      data: { sessionId: 'sess-1', tabId: 42 },
    } as EventMsg;

    // Access transport's event dispatch (via sendOp won't work for events, simulate directly)
    (transport as any).eventListeners.forEach((listener: any) => listener({ msg: stateEvent }));

    // Typed handler now receives full ChannelEvent envelope
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ msg: stateEvent })
    );
  });

  it('cleans up pending requests on destroy', async () => {
    // Don't register any handler so the request will pend forever
    const requestPromise = client.serviceRequest('slow.service');

    await client.destroy();

    await expect(requestPromise).rejects.toThrow('UIChannelClient destroyed');
  });
});
