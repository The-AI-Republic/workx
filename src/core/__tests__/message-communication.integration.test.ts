import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageRouter, MessageType } from '@/core/MessageRouter';

describe('PING/PONG Health Check Integration', () => {
  let router: MessageRouter;
  let chromeMock: any;

  beforeEach(() => {
    chromeMock = {
      runtime: {
        onMessage: {
          addListener: vi.fn()
        },
        onConnect: {
          addListener: vi.fn()
        },
        sendMessage: vi.fn()
      },
      tabs: {
        sendMessage: vi.fn()
      }
    };
    global.chrome = chromeMock;
    global.window = {} as any;

    router = new MessageRouter('content');
  });

  it('should respond to PING with PONG within 100ms', async () => {
    // Setup PING handler (simulating content-script.ts)
    router.on(MessageType.PING, () => {
      return {
        type: MessageType.PONG,
        timestamp: Date.now(),
        initLevel: 4,
        readyState: 'complete',
        version: '1.0.0',
        capabilities: ['dom', 'events', 'forms', 'accessibility']
      };
    });

    // Simulate chrome.tabs.sendMessage call
    const start = Date.now();
    const listenerCallback = chromeMock.runtime.onMessage.addListener.mock.calls[0][0];

    let response: any;
    const mockSendResponse = (r: any) => { response = r; };

    await listenerCallback(
      { type: MessageType.PING },
      {},
      mockSendResponse
    );

    const duration = Date.now() - start;

    expect(response.success).toBe(true);
    expect(response.data.type).toBe(MessageType.PONG);
    expect(response.data.initLevel).toBeGreaterThanOrEqual(2);
    expect(duration).toBeLessThan(100);
  });

  it('should include correct initLevel in PONG response', async () => {
    router.on(MessageType.PING, () => {
      return {
        type: MessageType.PONG,
        initLevel: 4,
        timestamp: Date.now(),
        readyState: 'complete',
        version: '1.0.0',
        capabilities: []
      };
    });

    const listenerCallback = chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
    let response: any;
    await listenerCallback(
      { type: MessageType.PING },
      {},
      (r: any) => { response = r; }
    );

    expect(response.data.initLevel).toBe(4);
  });

  it('should respond with readyState from document', async () => {
    // Mock document readyState
    Object.defineProperty(global, 'document', {
      value: { readyState: 'complete' },
      writable: true,
      configurable: true
    });

    router.on(MessageType.PING, () => {
      return {
        type: MessageType.PONG,
        initLevel: 4,
        timestamp: Date.now(),
        readyState: document.readyState,
        version: '1.0.0',
        capabilities: []
      };
    });

    const listenerCallback = chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
    let response: any;
    await listenerCallback(
      { type: MessageType.PING },
      {},
      (r: any) => { response = r; }
    );

    expect(response.data.readyState).toBe('complete');
  });
});
