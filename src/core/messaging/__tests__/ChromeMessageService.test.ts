import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChromeMessageService } from '../ChromeMessageService';

// Mock MessageType enum
vi.mock('../../MessageRouter', () => ({
  MessageType: {
    PING: 'PING',
    SUBMIT: 'SUBMIT',
    EVENT: 'EVENT',
    CANCEL: 'CANCEL',
  },
}));

// Re-import the mocked MessageType for use in tests
const MessageType = {
  PING: 'PING' as any,
  SUBMIT: 'SUBMIT' as any,
  EVENT: 'EVENT' as any,
  CANCEL: 'CANCEL' as any,
};

// --- Chrome runtime mock setup ---
let messageListener: ((message: any) => void) | null = null;
let sendMessageCallback: ((response: any) => void) | null = null;

function setupChromeMock() {
  messageListener = null;
  sendMessageCallback = null;

  (global as any).chrome = {
    runtime: {
      lastError: null,
      onMessage: {
        addListener: vi.fn((listener: any) => {
          messageListener = listener;
        }),
        removeListener: vi.fn((listener: any) => {
          if (messageListener === listener) messageListener = null;
        }),
      },
      sendMessage: vi.fn((message: any, callback: (response: any) => void) => {
        sendMessageCallback = callback;
        // Simulate immediate successful response
        setTimeout(() => {
          if (callback) callback({ success: true, data: 'pong' });
        }, 0);
      }),
    },
  };
}

// Fast config for all tests to avoid slow timeouts
const FAST_CONFIG = { maxRetries: 1, retryDelay: 1, timeout: 100 };

describe('ChromeMessageService', () => {
  let service: ChromeMessageService;

  beforeEach(() => {
    vi.useFakeTimers();
    setupChromeMock();
    service = new ChromeMessageService(FAST_CONFIG);
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  // ----------------------------------------------------------------
  // 1. Constructor
  // ----------------------------------------------------------------
  describe('constructor', () => {
    it('starts in the disconnected state', () => {
      expect(service.getConnectionState()).toBe('disconnected');
    });

    it('is not connected initially', () => {
      expect(service.isConnected()).toBe(false);
    });

    it('uses default config when none provided', () => {
      const defaultService = new ChromeMessageService();
      // It should still start disconnected regardless of config
      expect(defaultService.getConnectionState()).toBe('disconnected');
    });
  });

  // ----------------------------------------------------------------
  // 2. getConnectionState
  // ----------------------------------------------------------------
  describe('getConnectionState', () => {
    it('returns "disconnected" initially', () => {
      expect(service.getConnectionState()).toBe('disconnected');
    });

    it('returns "connected" after successful initialize', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      expect(service.getConnectionState()).toBe('connected');
    });
  });

  // ----------------------------------------------------------------
  // 3. isConnected
  // ----------------------------------------------------------------
  describe('isConnected', () => {
    it('returns false before initialization', () => {
      expect(service.isConnected()).toBe(false);
    });

    it('returns true after successful initialization', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      expect(service.isConnected()).toBe(true);
    });

    it('returns false after destroy', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      await service.destroy();
      expect(service.isConnected()).toBe(false);
    });
  });

  // ----------------------------------------------------------------
  // 4. initialize
  // ----------------------------------------------------------------
  describe('initialize', () => {
    it('transitions state to connected on success', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (message: any, callback: any) => {
          setTimeout(() => callback({ success: true, data: 'pong' }), 0);
        },
      );

      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      expect(service.getConnectionState()).toBe('connected');
      expect(service.isConnected()).toBe(true);
    });

    it('registers a message listener on chrome.runtime.onMessage', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(messageListener).not.toBeNull();
    });

    it('sends a PING message during initialization', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      expect(chrome.runtime.sendMessage).toHaveBeenCalled();
      const sentMessage = (chrome.runtime.sendMessage as any).mock.calls[0][0];
      expect(sentMessage.type).toBe(MessageType.PING);
    });

    it('transitions to error state when all retries fail', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, callback: any) => {
          setTimeout(() => callback({ success: false, error: 'Not ready' }), 0);
        },
      );

      const failService = new ChromeMessageService(FAST_CONFIG);
      const initPromise = failService.initialize().catch((e: Error) => e);

      // Advance enough time for the retry loop (retry delay + sendMessage timeout)
      await vi.advanceTimersByTimeAsync(500);

      const error = await initPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Failed to connect to service worker');
      expect(failService.getConnectionState()).toBe('error');
    });

    it('retries when the service worker is not available (port closed)', async () => {
      let callCount = 0;
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, callback: any) => {
          callCount++;
          if (callCount < 2) {
            // First call: simulate port closed error
            (chrome.runtime as any).lastError = { message: 'message port closed' };
            setTimeout(() => callback(undefined), 0);
          } else {
            (chrome.runtime as any).lastError = null;
            setTimeout(() => callback({ success: true, data: 'pong' }), 0);
          }
        },
      );

      const retryService = new ChromeMessageService({ maxRetries: 3, retryDelay: 1, timeout: 100 });
      const initPromise = retryService.initialize();
      await vi.advanceTimersByTimeAsync(500);
      await initPromise;

      expect(retryService.getConnectionState()).toBe('connected');
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ----------------------------------------------------------------
  // 5. on / off
  // ----------------------------------------------------------------
  describe('on / off', () => {
    it('registers a handler for a message type', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      // Internal state check: handler should be callable via incoming message
      // We verify by dispatching a message through the listener
      // (tested more thoroughly in handleIncomingMessage tests)
      expect(handler).not.toHaveBeenCalled();
    });

    it('removes a handler with off()', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      // Dispatch a message -- handler should fire
      messageListener?.({
        type: 'EVENT',
        payload: { data: 'first' },
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      service.off(MessageType.EVENT, handler);

      // Dispatch again -- handler should NOT fire
      messageListener?.({
        type: 'EVENT',
        payload: { data: 'second' },
        id: 'msg2',
        timestamp: Date.now(),
        source: 'sw',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('off() is a no-op for unregistered handlers', () => {
      const handler = vi.fn();
      // Should not throw when removing a handler that was never registered
      expect(() => service.off(MessageType.EVENT, handler)).not.toThrow();
    });

    it('off() is a no-op for unregistered message types', () => {
      const handler = vi.fn();
      // No handlers registered for CANCEL at all
      expect(() => service.off(MessageType.CANCEL, handler)).not.toThrow();
    });

    it('can register multiple handlers for the same type', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      service.on(MessageType.EVENT, handler1);
      service.on(MessageType.EVENT, handler2);

      messageListener?.({
        type: 'EVENT',
        payload: 'hello',
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });

      expect(handler1).toHaveBeenCalledWith('hello');
      expect(handler2).toHaveBeenCalledWith('hello');
    });
  });

  // ----------------------------------------------------------------
  // 6. on returns unsubscribe function
  // ----------------------------------------------------------------
  describe('on returns unsubscribe function', () => {
    it('returns a function', () => {
      const unsubscribe = service.on(MessageType.EVENT, vi.fn());
      expect(typeof unsubscribe).toBe('function');
    });

    it('calling unsubscribe removes the handler', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      const handler = vi.fn();
      const unsubscribe = service.on(MessageType.EVENT, handler);

      // Handler should receive messages
      messageListener?.({
        type: 'EVENT',
        payload: 'before',
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });
      expect(handler).toHaveBeenCalledTimes(1);

      // Unsubscribe
      unsubscribe();

      // Handler should no longer receive messages
      messageListener?.({
        type: 'EVENT',
        payload: 'after',
        id: 'msg2',
        timestamp: Date.now(),
        source: 'sw',
      });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unsubscribing one handler does not affect others', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const unsub1 = service.on(MessageType.EVENT, handler1);
      service.on(MessageType.EVENT, handler2);

      unsub1();

      messageListener?.({
        type: 'EVENT',
        payload: 'test',
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalledWith('test');
    });
  });

  // ----------------------------------------------------------------
  // 7. handleIncomingMessage (via messageListener)
  // ----------------------------------------------------------------
  describe('handleIncomingMessage', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;
    });

    it('dispatches payload to registered handlers', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      messageListener?.({
        type: 'EVENT',
        payload: { data: 'test' },
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({ data: 'test' });
    });

    it('does not dispatch to handlers of a different type', () => {
      const eventHandler = vi.fn();
      const submitHandler = vi.fn();
      service.on(MessageType.EVENT, eventHandler);
      service.on(MessageType.SUBMIT, submitHandler);

      messageListener?.({
        type: 'EVENT',
        payload: { data: 'test' },
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });

      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect(submitHandler).not.toHaveBeenCalled();
    });

    it('ignores messages with no type', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      messageListener?.({ payload: 'no type' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('ignores null/undefined messages', () => {
      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      messageListener?.(null);
      messageListener?.(undefined);

      expect(handler).not.toHaveBeenCalled();
    });

    it('catches handler errors without breaking other handlers', () => {
      const errorHandler = vi.fn(() => {
        throw new Error('handler exploded');
      });
      const goodHandler = vi.fn();

      service.on(MessageType.EVENT, errorHandler);
      service.on(MessageType.EVENT, goodHandler);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      messageListener?.({
        type: 'EVENT',
        payload: 'boom',
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });

      expect(errorHandler).toHaveBeenCalled();
      expect(goodHandler).toHaveBeenCalledWith('boom');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('handles messages with no registered handlers gracefully', () => {
      // No handler registered for CANCEL; should not throw
      expect(() => {
        messageListener?.({
          type: 'CANCEL',
          payload: null,
          id: 'msg1',
          timestamp: Date.now(),
          source: 'sw',
        });
      }).not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // 8. destroy
  // ----------------------------------------------------------------
  describe('destroy', () => {
    it('removes the message listener from chrome.runtime.onMessage', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      await service.destroy();

      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
      expect(messageListener).toBeNull();
    });

    it('transitions state to disconnected', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      expect(service.getConnectionState()).toBe('connected');

      await service.destroy();

      expect(service.getConnectionState()).toBe('disconnected');
      expect(service.isConnected()).toBe(false);
    });

    it('clears all registered handlers', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      const handler = vi.fn();
      service.on(MessageType.EVENT, handler);

      await service.destroy();

      // Re-init so messageListener is active again for this verification
      // The handler map was cleared, so previously registered handler should not fire
      const reInitPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await reInitPromise;

      messageListener?.({
        type: 'EVENT',
        payload: 'after-destroy',
        id: 'msg1',
        timestamp: Date.now(),
        source: 'sw',
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('rejects pending requests with "Service destroyed"', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      // Set up a send that will NOT get a response (block the callback)
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, _callback: any) => {
          // Intentionally do not call callback -- request stays pending
        },
      );

      const sendPromise = service.send(MessageType.SUBMIT, { form: 'data' });

      // Destroy while request is pending
      await service.destroy();

      await expect(sendPromise).rejects.toThrow('Service destroyed');
    });

    it('is safe to call destroy before initialize', async () => {
      await expect(service.destroy()).resolves.not.toThrow();
      expect(service.getConnectionState()).toBe('disconnected');
    });

    it('is safe to call destroy multiple times', async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;

      await service.destroy();
      await expect(service.destroy()).resolves.not.toThrow();
    });
  });

  // ----------------------------------------------------------------
  // 9. send
  // ----------------------------------------------------------------
  describe('send', () => {
    beforeEach(async () => {
      const initPromise = service.initialize();
      await vi.advanceTimersByTimeAsync(10);
      await initPromise;
    });

    afterEach(async () => {
      // Destroy service to clear any pending request timeouts and avoid
      // unhandled rejections from lingering timers.
      await service.destroy();
    });

    it('creates a message envelope with correct fields', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (message: any, callback: any) => {
          // Validate envelope shape
          expect(message).toHaveProperty('id');
          expect(message.id).toMatch(/^chrome_/);
          expect(message).toHaveProperty('type', MessageType.SUBMIT);
          expect(message).toHaveProperty('payload', { key: 'value' });
          expect(message).toHaveProperty('timestamp');
          expect(typeof message.timestamp).toBe('number');
          expect(message).toHaveProperty('source', 'sidepanel');

          setTimeout(() => callback({ success: true, data: 'ok' }), 0);
        },
      );

      const sendPromise = service.send(MessageType.SUBMIT, { key: 'value' });
      await vi.advanceTimersByTimeAsync(10);
      await sendPromise;
    });

    it('resolves with response data on success', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, callback: any) => {
          setTimeout(() => callback({ success: true, data: { result: 42 } }), 0);
        },
      );

      const sendPromise = service.send(MessageType.SUBMIT, { x: 1 });
      await vi.advanceTimersByTimeAsync(10);
      const result = await sendPromise;

      expect(result).toEqual({ result: 42 });
    });

    it('rejects when response indicates failure', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, callback: any) => {
          // Call callback synchronously to avoid timer race conditions
          callback({ success: false, error: 'Bad request' });
        },
      );

      const sendPromise = service.send(MessageType.SUBMIT);

      await expect(sendPromise).rejects.toThrow('Bad request');
    });

    it('rejects with generic message when failure has no error string', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, callback: any) => {
          callback({ success: false });
        },
      );

      const sendPromise = service.send(MessageType.SUBMIT);

      await expect(sendPromise).rejects.toThrow('Request failed');
    });

    it('rejects when chrome.runtime.lastError is set', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, callback: any) => {
          (chrome.runtime as any).lastError = { message: 'Could not establish connection' };
          callback(undefined);
        },
      );

      const sendPromise = service.send(MessageType.SUBMIT);

      await expect(sendPromise).rejects.toThrow('Could not establish connection');

      // Clean up
      (chrome.runtime as any).lastError = null;
    });

    it('rejects with timeout error when no response is received', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (_message: any, _callback: any) => {
          // Never call callback -- simulate timeout
        },
      );

      // Capture the promise rejection immediately to avoid unhandled rejection
      const sendPromise = service.send(MessageType.SUBMIT).catch((e: Error) => e);

      // Advance past the timeout (100ms from FAST_CONFIG)
      await vi.advanceTimersByTimeAsync(200);

      const error = await sendPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Message timeout');
    });

    it('generates unique message IDs', async () => {
      const capturedIds: string[] = [];

      (chrome.runtime.sendMessage as any).mockImplementation(
        (message: any, callback: any) => {
          capturedIds.push(message.id);
          setTimeout(() => callback({ success: true, data: null }), 0);
        },
      );

      const p1 = service.send(MessageType.SUBMIT);
      await vi.advanceTimersByTimeAsync(10);
      await p1;

      const p2 = service.send(MessageType.EVENT);
      await vi.advanceTimersByTimeAsync(10);
      await p2;

      expect(capturedIds).toHaveLength(2);
      expect(capturedIds[0]).not.toBe(capturedIds[1]);
    });

    it('sends without payload when none is provided', async () => {
      (chrome.runtime.sendMessage as any).mockImplementation(
        (message: any, callback: any) => {
          expect(message.payload).toBeUndefined();
          setTimeout(() => callback({ success: true, data: null }), 0);
        },
      );

      const sendPromise = service.send(MessageType.PING);
      await vi.advanceTimersByTimeAsync(10);
      await sendPromise;
    });
  });
});
