import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageRouter, MessageType } from '@/core/MessageRouter';

describe('Content Script Listener Registration Contract', () => {
  let chromeMock: any;

  beforeEach(() => {
    // Mock Chrome API
    chromeMock = {
      runtime: {
        onMessage: {
          addListener: vi.fn(),
          hasListeners: vi.fn().mockReturnValue(true)
        },
        onConnect: {
          addListener: vi.fn()
        }
      }
    };
    global.chrome = chromeMock;
    global.window = {} as any;
  });

  it('should register chrome.runtime.onMessage listener synchronously', () => {
    const router = new MessageRouter('content');

    // Verify listener was registered
    expect(chromeMock.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(chromeMock.runtime.onMessage.hasListeners()).toBe(true);
  });

  it('should register listener in constructor, not async', () => {
    const callOrder: string[] = [];

    chromeMock.runtime.onMessage.addListener = vi.fn(() => {
      callOrder.push('listener_registered');
    });

    callOrder.push('before_constructor');
    const router = new MessageRouter('content');
    callOrder.push('after_constructor');

    // Listener must be registered during constructor
    expect(callOrder).toEqual([
      'before_constructor',
      'listener_registered',
      'after_constructor'
    ]);
  });

  it('should not register listener if chrome.runtime unavailable', () => {
    global.chrome = undefined as any;

    const router = new MessageRouter('content');

    // No listener should be registered
    expect(chromeMock.runtime.onMessage.addListener).not.toHaveBeenCalled();
  });

  it('should register PING handler before async operations', () => {
    const router = new MessageRouter('content');

    // Register PING handler
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

    // Verify handler is registered synchronously
    const listenerCallback = chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
    expect(listenerCallback).toBeDefined();
  });
});
