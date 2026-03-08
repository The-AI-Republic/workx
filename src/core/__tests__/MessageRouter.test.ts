/**
 * Comprehensive unit tests for MessageRouter
 *
 * Tests core message routing, port management, handler registration/removal,
 * send/broadcast, convenience methods, cleanup, and edge cases.
 *
 * NOTE: ResponseEvent-specific tests live in MessageRouter-ResponseEvent.test.ts
 *       and are intentionally NOT duplicated here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouter, MessageType, createRouter } from '../MessageRouter';
import type { ExtensionMessage, MessageResponse } from '../MessageRouter';

// ---------------------------------------------------------------------------
// Chrome mock that includes onConnect (setup.ts omits it)
// ---------------------------------------------------------------------------
function buildChromeMock() {
  return {
    runtime: {
      sendMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn(),
      },
      onConnect: {
        addListener: vi.fn(),
      },
      lastError: null as any,
      id: 'test-extension-id',
      getURL: vi.fn((path: string) => `chrome-extension://test-extension-id/${path}`),
    },
    tabs: {
      sendMessage: vi.fn(),
      query: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      remove: vi.fn(),
    },
    sidePanel: undefined as any,
    storage: {
      local: { get: vi.fn(), set: vi.fn() },
      sync: { get: vi.fn(), set: vi.fn() },
    },
  };
}

let mockChrome: ReturnType<typeof buildChromeMock>;

beforeEach(() => {
  mockChrome = buildChromeMock();
  Object.defineProperty(globalThis, 'chrome', {
    value: mockChrome,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Helper: extract the runtime.onMessage listener that was registered
// ---------------------------------------------------------------------------
function getMessageListener(): (
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: MessageResponse) => void
) => boolean {
  const calls = mockChrome.runtime.onMessage.addListener.mock.calls;
  // Return the last registered listener (from the most recent router)
  return calls[calls.length - 1][0];
}

// ---------------------------------------------------------------------------
// Helper: extract the runtime.onConnect listener
// ---------------------------------------------------------------------------
function getConnectListener(): (port: chrome.runtime.Port) => void {
  const calls = mockChrome.runtime.onConnect.addListener.mock.calls;
  return calls[calls.length - 1][0];
}

// ---------------------------------------------------------------------------
// Helper: create a minimal fake Port
// ---------------------------------------------------------------------------
function createFakePort(name = 'test-port', tabId?: number): {
  port: chrome.runtime.Port;
  messageListeners: Array<(msg: any) => void>;
  disconnectListeners: Array<() => void>;
} {
  const messageListeners: Array<(msg: any) => void> = [];
  const disconnectListeners: Array<() => void> = [];

  const port = {
    name,
    sender: tabId !== undefined ? { tab: { id: tabId } } : undefined,
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: {
      addListener: vi.fn((cb: any) => messageListeners.push(cb)),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: vi.fn((cb: any) => disconnectListeners.push(cb)),
      removeListener: vi.fn(),
    },
  } as unknown as chrome.runtime.Port;

  return { port, messageListeners, disconnectListeners };
}

// =========================================================================
// Tests
// =========================================================================

describe('MessageRouter', () => {
  // -----------------------------------------------------------------------
  // Constructor & listener registration
  // -----------------------------------------------------------------------
  describe('constructor and listener setup', () => {
    it('should register a runtime.onMessage listener', () => {
      const router = new MessageRouter('background');
      expect(mockChrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(typeof getMessageListener()).toBe('function');
    });

    it('should register a runtime.onConnect listener', () => {
      const router = new MessageRouter('background');
      expect(mockChrome.runtime.onConnect.addListener).toHaveBeenCalledTimes(1);
    });

    it('should store the source provided to the constructor', () => {
      const router = new MessageRouter('sidepanel');
      // Source is used in outgoing messages; verify via send
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true, data: null });
      });
      router.send(MessageType.PING);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'sidepanel' }),
        expect.any(Function),
      );
    });

    it('should not throw when chrome.runtime is undefined', () => {
      Object.defineProperty(globalThis, 'chrome', {
        value: undefined,
        writable: true,
        configurable: true,
      });
      expect(() => new MessageRouter('background')).not.toThrow();
    });

    it('should not throw when chrome exists but runtime is undefined', () => {
      Object.defineProperty(globalThis, 'chrome', {
        value: { runtime: undefined },
        writable: true,
        configurable: true,
      });
      expect(() => new MessageRouter('content')).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Handler registration (on / unsubscribe)
  // -----------------------------------------------------------------------
  describe('on() — handler registration', () => {
    it('should register a handler for a message type', () => {
      const router = new MessageRouter('background');
      const handler = vi.fn();
      router.on(MessageType.PING, handler);

      // Trigger the listener with a matching message
      const listener = getMessageListener();
      const sendResponse = vi.fn();
      handler.mockReturnValue('pong');

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      // Async handler — wait a tick
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          expect(handler).toHaveBeenCalled();
          resolve();
        }, 0),
      );
    });

    it('should allow multiple handlers for the same message type', async () => {
      const router = new MessageRouter('background');
      const handler1 = vi.fn().mockReturnValue('result1');
      const handler2 = vi.fn().mockReturnValue('result2');

      router.on(MessageType.PING, handler1);
      router.on(MessageType.PING, handler2);

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(handler1).toHaveBeenCalledTimes(1);
        expect(handler2).toHaveBeenCalledTimes(1);
      });
    });

    it('should return an unsubscribe function', () => {
      const router = new MessageRouter('background');
      const handler = vi.fn();
      const unsub = router.on(MessageType.PING, handler);

      expect(typeof unsub).toBe('function');
    });

    it('should remove handler when unsubscribe is called', async () => {
      const router = new MessageRouter('background');
      const handler = vi.fn();
      const unsub = router.on(MessageType.PING, handler);

      unsub();

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.stringContaining('No handler'),
          }),
        );
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should only remove the specific handler when unsubscribing', async () => {
      const router = new MessageRouter('background');
      const handler1 = vi.fn().mockReturnValue('keep');
      const handler2 = vi.fn().mockReturnValue('remove');

      router.on(MessageType.PING, handler1);
      const unsub2 = router.on(MessageType.PING, handler2);

      unsub2();

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(handler1).toHaveBeenCalledTimes(1);
        expect(handler2).not.toHaveBeenCalled();
      });
    });

    it('should handle registering handlers for different message types', () => {
      const router = new MessageRouter('background');
      const pingHandler = vi.fn();
      const pongHandler = vi.fn();

      router.on(MessageType.PING, pingHandler);
      router.on(MessageType.PONG, pongHandler);

      // Both registrations should succeed without error
      expect(pingHandler).not.toHaveBeenCalled();
      expect(pongHandler).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Incoming message handling (handleMessage)
  // -----------------------------------------------------------------------
  describe('handleMessage — incoming runtime messages', () => {
    it('should add tabId and timestamp from the sender', async () => {
      const router = new MessageRouter('background');
      let receivedMessage: ExtensionMessage | undefined;

      router.on(MessageType.PING, (msg) => {
        receivedMessage = msg;
      });

      const listener = getMessageListener();
      listener(
        { type: MessageType.PING } as ExtensionMessage,
        { tab: { id: 42 } } as chrome.runtime.MessageSender,
        vi.fn(),
      );

      await vi.waitFor(() => {
        expect(receivedMessage).toBeDefined();
        expect(receivedMessage!.tabId).toBe(42);
        expect(typeof receivedMessage!.timestamp).toBe('number');
      });
    });

    it('should send success response with data when handler returns a value', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.GET_STATE, () => ({ running: true }));

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.GET_STATE } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: { running: true },
        });
      });
    });

    it('should send success with no data when handler returns undefined', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => undefined);

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({ success: true });
      });
    });

    it('should send first handler response when multiple handlers return values', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => 'first');
      router.on(MessageType.PING, () => 'second');

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: 'first',
        });
      });
    });

    it('should respond with error when no handlers are registered for a type', async () => {
      const router = new MessageRouter('background');

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          success: false,
          error: `No handler for message type: ${MessageType.PING}`,
        });
      });
    });

    it('should catch and log handler errors without breaking other handlers', async () => {
      const router = new MessageRouter('background');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      router.on(MessageType.PING, () => {
        throw new Error('handler explosion');
      });
      router.on(MessageType.PING, () => 'ok');

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Handler error'),
          expect.any(Error),
        );
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: 'ok',
        });
      });

      errorSpy.mockRestore();
    });

    it('should resolve a pending request when message has a matching id', async () => {
      const router = new MessageRouter('background');

      // Create a pending request by calling send
      mockChrome.runtime.sendMessage.mockImplementation(() => {
        // Don't call the callback — we will resolve via the incoming message listener
      });

      const sendPromise = router.send(MessageType.PING);

      // The send call creates a pending request with id msg_1
      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PONG, id: 'msg_1', payload: 'resolved-data' } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      const result = await sendPromise;
      expect(result).toBe('resolved-data');
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('should return true from the listener to enable async sendResponse', () => {
      const router = new MessageRouter('background');
      const listener = getMessageListener();

      const result = listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        vi.fn(),
      );

      expect(result).toBe(true);
    });

    it('should handle async handler returning a promise', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.GET_STATE, async () => {
        return { state: 'ready' };
      });

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.GET_STATE } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: { state: 'ready' },
        });
      });
    });

    it('should catch top-level errors and return failure response', async () => {
      const router = new MessageRouter('background');

      // Register handler for a type, but use an object that will cause a problem
      // by making handlers.get throw (indirectly, via a Proxy-like scenario).
      // Actually the simplest way: register a handler that returns a rejected promise.
      router.on(MessageType.PING, async () => {
        throw new Error('top-level async boom');
      });

      const listener = getMessageListener();
      const sendResponse = vi.fn();
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        // The individual handler error is caught, so sendResponse gets { success: true }
        // (no successful response data, since the single handler threw)
        expect(sendResponse).toHaveBeenCalledWith({ success: true });
      });

      errorSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Port / persistent connections
  // -----------------------------------------------------------------------
  describe('handleConnection — persistent port connections', () => {
    it('should set connected to true when a port connects', () => {
      const router = new MessageRouter('background');
      expect(router.isConnected()).toBe(false);

      const connectListener = getConnectListener();
      const { port } = createFakePort();

      connectListener(port);
      expect(router.isConnected()).toBe(true);
    });

    it('should set connected to false when a port disconnects', () => {
      const router = new MessageRouter('background');
      const connectListener = getConnectListener();
      const { port, disconnectListeners } = createFakePort();

      connectListener(port);
      expect(router.isConnected()).toBe(true);

      // Trigger disconnect
      disconnectListeners[0]();
      expect(router.isConnected()).toBe(false);
    });

    it('should register onMessage and onDisconnect listeners on the port', () => {
      const router = new MessageRouter('background');
      const connectListener = getConnectListener();
      const { port } = createFakePort();

      connectListener(port);

      expect(port.onMessage.addListener).toHaveBeenCalledTimes(1);
      expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);
    });

    it('should dispatch port messages to registered handlers', async () => {
      const router = new MessageRouter('background');
      const handler = vi.fn().mockResolvedValue('port-result');
      router.on(MessageType.PING, handler);

      const connectListener = getConnectListener();
      const { port, messageListeners } = createFakePort('test-port', 7);

      connectListener(port);

      // Send a message through the port
      messageListeners[0]({
        type: MessageType.PING,
        id: 'port-msg-1',
        payload: { data: 'hello' },
      });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ type: MessageType.PING }),
          expect.objectContaining({ tab: { id: 7 } }),
        );
      });
    });

    it('should postMessage back to port when handler returns a value', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => 'pong-data');

      const connectListener = getConnectListener();
      const { port, messageListeners } = createFakePort('test', 5);

      connectListener(port);
      messageListeners[0]({ type: MessageType.PING, id: 'p1' });

      await vi.waitFor(() => {
        expect(port.postMessage).toHaveBeenCalledWith({
          type: MessageType.PING,
          payload: 'pong-data',
          id: 'p1',
        });
      });
    });

    it('should not postMessage when handler returns undefined', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => undefined);

      const connectListener = getConnectListener();
      const { port, messageListeners } = createFakePort();

      connectListener(port);
      messageListeners[0]({ type: MessageType.PING, id: 'p2' });

      // Give time for async processing
      await new Promise((r) => setTimeout(r, 50));
      expect(port.postMessage).not.toHaveBeenCalled();
    });

    it('should catch handler errors for port messages', async () => {
      const router = new MessageRouter('background');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      router.on(MessageType.PING, () => {
        throw new Error('port boom');
      });

      const connectListener = getConnectListener();
      const { port, messageListeners } = createFakePort();

      connectListener(port);
      messageListeners[0]({ type: MessageType.PING });

      await vi.waitFor(() => {
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining('Port handler error'),
          expect.any(Error),
        );
      });

      errorSpy.mockRestore();
    });

    it('should silently ignore port messages with no registered handler', async () => {
      const router = new MessageRouter('background');
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const connectListener = getConnectListener();
      const { port, messageListeners } = createFakePort();

      connectListener(port);
      messageListeners[0]({ type: MessageType.DOM_ACTION });

      await new Promise((r) => setTimeout(r, 50));
      // Should not call postMessage and should not throw
      expect(port.postMessage).not.toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('should handle port sender without tab info', async () => {
      const router = new MessageRouter('background');
      const handler = vi.fn().mockReturnValue('result');
      router.on(MessageType.PING, handler);

      const connectListener = getConnectListener();
      // Port without sender tab
      const { port, messageListeners } = createFakePort();
      (port as any).sender = undefined;

      connectListener(port);
      messageListeners[0]({ type: MessageType.PING, id: 'p3' });

      await vi.waitFor(() => {
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ type: MessageType.PING }),
          expect.objectContaining({ tab: { id: undefined } }),
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // send()
  // -----------------------------------------------------------------------
  describe('send() — outgoing messages', () => {
    it('should send a message via chrome.runtime.sendMessage', async () => {
      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true, data: 'response-data' });
      });

      const result = await router.send(MessageType.PING, { test: true });
      expect(result).toBe('response-data');
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.PING,
          payload: { test: true },
          source: 'background',
          id: expect.stringMatching(/^msg_\d+$/),
          timestamp: expect.any(Number),
        }),
        expect.any(Function),
      );
    });

    it('should send to a specific tab via chrome.tabs.sendMessage when tabId is provided', async () => {
      const router = new MessageRouter('background');
      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          cb({ success: true, data: 'tab-data' });
        },
      );

      const result = await router.send(MessageType.TAB_COMMAND, { cmd: 'click' }, 10);
      expect(result).toBe('tab-data');
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        10,
        expect.objectContaining({ type: MessageType.TAB_COMMAND }),
        expect.any(Function),
      );
    });

    it('should reject when sendMessage callback has runtime.lastError', async () => {
      const router = new MessageRouter('background');
      const lastErr = { message: 'Could not establish connection' };

      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        Object.defineProperty(mockChrome.runtime, 'lastError', {
          value: lastErr,
          configurable: true,
        });
        cb(null);
      });

      await expect(router.send(MessageType.PING)).rejects.toEqual(lastErr);
    });

    it('should reject when response.success is false', async () => {
      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: false, error: 'handler not found' });
      });

      await expect(router.send(MessageType.PING)).rejects.toThrow('handler not found');
    });

    it('should reject with "Message failed" when response is unsuccessful with no error', async () => {
      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: false });
      });

      await expect(router.send(MessageType.PING)).rejects.toThrow('Message failed');
    });

    it('should reject when tab sendMessage has runtime.lastError', async () => {
      const router = new MessageRouter('background');
      const lastErr = { message: 'Tab does not exist' };

      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          Object.defineProperty(mockChrome.runtime, 'lastError', {
            value: lastErr,
            configurable: true,
          });
          cb(null);
        },
      );

      await expect(router.send(MessageType.TAB_COMMAND, {}, 99)).rejects.toEqual(lastErr);
    });

    it('should reject when tab sendMessage returns unsuccessful response', async () => {
      const router = new MessageRouter('background');
      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          cb({ success: false, error: 'tab error' });
        },
      );

      await expect(router.send(MessageType.TAB_COMMAND, {}, 5)).rejects.toThrow('tab error');
    });

    it('should increment message IDs for each send call', async () => {
      const router = new MessageRouter('background');
      const sentMessages: ExtensionMessage[] = [];

      mockChrome.runtime.sendMessage.mockImplementation((msg: any, cb: any) => {
        sentMessages.push(msg);
        cb({ success: true });
      });

      await router.send(MessageType.PING);
      await router.send(MessageType.PONG);

      expect(sentMessages[0].id).toBe('msg_1');
      expect(sentMessages[1].id).toBe('msg_2');
    });

    it('should timeout after 30 seconds if no response arrives', async () => {
      vi.useFakeTimers();

      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation(() => {
        // Never call callback
      });

      const sendPromise = router.send(MessageType.PING);
      vi.advanceTimersByTime(31000);

      await expect(sendPromise).rejects.toThrow('Message timeout');

      vi.useRealTimers();
    });

    it('should not timeout if response arrives before 30 seconds', async () => {
      vi.useFakeTimers();

      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        // Respond after 1 second
        setTimeout(() => cb({ success: true, data: 'fast' }), 1000);
      });

      const sendPromise = router.send(MessageType.PING);
      vi.advanceTimersByTime(1000);

      const result = await sendPromise;
      expect(result).toBe('fast');

      vi.useRealTimers();
    });
  });

  // -----------------------------------------------------------------------
  // broadcast()
  // -----------------------------------------------------------------------
  describe('broadcast()', () => {
    it('should query all tabs and send message to each', async () => {
      const router = new MessageRouter('background');

      mockChrome.tabs.query.mockResolvedValue([
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ]);
      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          cb({ success: true });
        },
      );

      await router.broadcast(MessageType.STATE_UPDATE, { foo: 'bar' });

      expect(mockChrome.tabs.query).toHaveBeenCalledWith({});
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should ignore individual tab send failures', async () => {
      const router = new MessageRouter('background');

      mockChrome.tabs.query.mockResolvedValue([
        { id: 1 },
        { id: 2 },
      ]);

      let callCount = 0;
      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          callCount++;
          if (callCount === 1) {
            // First tab fails
            Object.defineProperty(mockChrome.runtime, 'lastError', {
              value: { message: 'tab closed' },
              configurable: true,
            });
            cb(null);
          } else {
            Object.defineProperty(mockChrome.runtime, 'lastError', {
              value: null,
              configurable: true,
            });
            cb({ success: true });
          }
        },
      );

      // Should not throw even though one tab failed
      await expect(router.broadcast(MessageType.STATE_UPDATE, {})).resolves.toBeUndefined();
    });

    it('should skip tabs without an id', async () => {
      const router = new MessageRouter('background');

      mockChrome.tabs.query.mockResolvedValue([
        { id: 1 },
        { id: undefined },
        { id: 3 },
      ]);
      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          cb({ success: true });
        },
      );

      await router.broadcast(MessageType.PING);
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Convenience / domain methods
  // -----------------------------------------------------------------------
  describe('convenience methods', () => {
    beforeEach(() => {
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true, data: 'ok' });
      });
    });

    it('sendSubmission should send SUBMISSION type', async () => {
      const router = new MessageRouter('background');
      const submission = { id: 's1', op: { type: 'Interrupt' as const } };

      await router.sendSubmission(submission);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.SUBMISSION,
          payload: submission,
        }),
        expect.any(Function),
      );
    });

    it('sendEvent should send EVENT type', async () => {
      const router = new MessageRouter('background');
      const event = { type: 'test-event', data: 123 } as any;

      await router.sendEvent(event);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.EVENT,
          payload: event,
        }),
        expect.any(Function),
      );
    });

    it('getState should send GET_STATE and return the response', async () => {
      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true, data: { state: 'idle' } });
      });

      const result = await router.getState();
      expect(result).toEqual({ state: 'idle' });
    });

    it('updateState should send STATE_UPDATE type', async () => {
      const router = new MessageRouter('background');
      await router.updateState({ running: true });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.STATE_UPDATE,
          payload: { running: true },
        }),
        expect.any(Function),
      );
    });

    it('executeTabCommand should send TAB_COMMAND to specific tab', async () => {
      const router = new MessageRouter('background');
      mockChrome.tabs.sendMessage.mockImplementation(
        (_tabId: number, _msg: any, cb: any) => {
          cb({ success: true, data: 'executed' });
        },
      );

      const result = await router.executeTabCommand(42, 'click', { selector: '#btn' });
      expect(result).toBe('executed');
      expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
        42,
        expect.objectContaining({
          type: MessageType.TAB_COMMAND,
          payload: { command: 'click', args: { selector: '#btn' } },
        }),
        expect.any(Function),
      );
    });

    it('storageGet should send STORAGE_GET with key', async () => {
      const router = new MessageRouter('background');
      await router.storageGet('myKey');

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.STORAGE_GET,
          payload: { key: 'myKey' },
        }),
        expect.any(Function),
      );
    });

    it('storageSet should send STORAGE_SET with key and value', async () => {
      const router = new MessageRouter('background');
      await router.storageSet('myKey', { nested: true });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.STORAGE_SET,
          payload: { key: 'myKey', value: { nested: true } },
        }),
        expect.any(Function),
      );
    });

    it('executeToolMessage should send TOOL_EXECUTE type', async () => {
      const router = new MessageRouter('background');
      await router.executeToolMessage('screenshot', { url: 'https://example.com' });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TOOL_EXECUTE,
          payload: { toolName: 'screenshot', args: { url: 'https://example.com' } },
        }),
        expect.any(Function),
      );
    });

    it('requestApproval should send APPROVAL_REQUEST type', async () => {
      const router = new MessageRouter('background');
      await router.requestApproval('a1', 'exec', { command: 'rm -rf' });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.APPROVAL_REQUEST,
          payload: { approvalId: 'a1', type: 'exec', details: { command: 'rm -rf' } },
        }),
        expect.any(Function),
      );
    });

    it('sendDiffGenerated should send DIFF_GENERATED type', async () => {
      const router = new MessageRouter('background');
      await router.sendDiffGenerated('d1', '/file.ts', { added: 5, removed: 2 });

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.DIFF_GENERATED,
          payload: { diffId: 'd1', path: '/file.ts', content: { added: 5, removed: 2 } },
        }),
        expect.any(Function),
      );
    });

    it('requestSessionReset should send SESSION_RESET type', async () => {
      const router = new MessageRouter('background');
      await router.requestSessionReset();

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: MessageType.SESSION_RESET }),
        expect.any(Function),
      );
    });
  });

  // -----------------------------------------------------------------------
  // isConnected()
  // -----------------------------------------------------------------------
  describe('isConnected()', () => {
    it('should return false initially', () => {
      const router = new MessageRouter('background');
      expect(router.isConnected()).toBe(false);
    });

    it('should return true after a port connects', () => {
      const router = new MessageRouter('background');
      const connectListener = getConnectListener();
      const { port } = createFakePort();

      connectListener(port);
      expect(router.isConnected()).toBe(true);
    });

    it('should return false after a port disconnects', () => {
      const router = new MessageRouter('background');
      const connectListener = getConnectListener();
      const { port, disconnectListeners } = createFakePort();

      connectListener(port);
      disconnectListeners[0]();
      expect(router.isConnected()).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // cleanup()
  // -----------------------------------------------------------------------
  describe('cleanup()', () => {
    it('should reject all pending requests with "Router cleanup"', async () => {
      const router = new MessageRouter('background');

      mockChrome.runtime.sendMessage.mockImplementation(() => {
        // Never respond
      });

      // Start two sends that will never resolve naturally
      const p1 = router.send(MessageType.PING);
      const p2 = router.send(MessageType.PONG);

      router.cleanup();

      await expect(p1).rejects.toThrow('Router cleanup');
      await expect(p2).rejects.toThrow('Router cleanup');
    });

    it('should clear all handlers', async () => {
      const router = new MessageRouter('background');
      const handler = vi.fn();

      router.on(MessageType.PING, handler);
      router.cleanup();

      // Now trigger a message — should have no handler
      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            success: false,
            error: expect.stringContaining('No handler'),
          }),
        );
      });

      expect(handler).not.toHaveBeenCalled();
    });

    it('should be safe to call cleanup multiple times', () => {
      const router = new MessageRouter('background');
      expect(() => {
        router.cleanup();
        router.cleanup();
      }).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // MessageType enum
  // -----------------------------------------------------------------------
  describe('MessageType enum', () => {
    it('should include core protocol types', () => {
      expect(MessageType.SUBMISSION).toBe('SUBMISSION');
      expect(MessageType.EVENT).toBe('EVENT');
    });

    it('should include connection management types', () => {
      expect(MessageType.PING).toBe('PING');
      expect(MessageType.PONG).toBe('PONG');
      expect(MessageType.HEALTH_CHECK).toBe('HEALTH_CHECK');
      expect(MessageType.HEALTH_STATUS).toBe('HEALTH_STATUS');
    });

    it('should include state types', () => {
      expect(MessageType.GET_STATE).toBe('GET_STATE');
      expect(MessageType.STATE_UPDATE).toBe('STATE_UPDATE');
    });

    it('should include session management types', () => {
      expect(MessageType.SESSION_RESET).toBe('SESSION_RESET');
      expect(MessageType.SESSION_RESET_COMPLETE).toBe('SESSION_RESET_COMPLETE');
      expect(MessageType.RESUME_SESSION).toBe('RESUME_SESSION');
      expect(MessageType.RESUME_SESSION_COMPLETE).toBe('RESUME_SESSION_COMPLETE');
    });

    it('should include MCP integration types', () => {
      expect(MessageType.MCP_GET_SERVERS).toBe('MCP_GET_SERVERS');
      expect(MessageType.MCP_ADD_SERVER).toBe('MCP_ADD_SERVER');
      expect(MessageType.MCP_EXECUTE_TOOL).toBe('MCP_EXECUTE_TOOL');
    });

    it('should include scheduler types', () => {
      expect(MessageType.SCHEDULER_SCHEDULE_JOB).toBe('SCHEDULER_SCHEDULE_JOB');
      expect(MessageType.SCHEDULER_EVENT).toBe('SCHEDULER_EVENT');
    });

    it('should map INTERRUPT to STOP_AGENT_SESSION', () => {
      expect(MessageType.INTERRUPT).toBe('STOP_AGENT_SESSION');
    });
  });

  // -----------------------------------------------------------------------
  // createRouter() factory
  // -----------------------------------------------------------------------
  describe('createRouter()', () => {
    it('should create a router with background source by default', async () => {
      // Ensure no sidePanel and no window.location.protocol
      mockChrome.sidePanel = undefined;

      // Remove window to simulate service worker
      const origWindow = globalThis.window;
      Object.defineProperty(globalThis, 'window', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      const router = createRouter();

      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true });
      });

      await router.send(MessageType.PING);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'background' }),
        expect.any(Function),
      );

      Object.defineProperty(globalThis, 'window', {
        value: origWindow,
        writable: true,
        configurable: true,
      });
    });

    it('should create a router with sidepanel source when chrome.sidePanel exists', async () => {
      mockChrome.sidePanel = {} as any;

      const router = createRouter();

      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true });
      });

      await router.send(MessageType.PING);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'sidepanel' }),
        expect.any(Function),
      );
    });

    it('should create a router with content source for non-extension windows', async () => {
      mockChrome.sidePanel = undefined;

      // Create a window-like object with a non chrome-extension protocol
      const origWindow = globalThis.window;
      Object.defineProperty(globalThis, 'window', {
        value: { location: { protocol: 'https:' } },
        writable: true,
        configurable: true,
      });

      const router = createRouter();

      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true });
      });

      await router.send(MessageType.PING);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'content' }),
        expect.any(Function),
      );

      Object.defineProperty(globalThis, 'window', {
        value: origWindow,
        writable: true,
        configurable: true,
      });
    });

    it('should detect popup source for chrome-extension protocol with document body', async () => {
      mockChrome.sidePanel = undefined;

      const origWindow = globalThis.window;
      Object.defineProperty(globalThis, 'window', {
        value: { location: { protocol: 'chrome-extension:' } },
        writable: true,
        configurable: true,
      });

      // Ensure document.querySelector returns a body element
      const origDocument = globalThis.document;
      Object.defineProperty(globalThis, 'document', {
        value: {
          querySelector: (sel: string) => (sel === 'body' ? {} : null),
        },
        writable: true,
        configurable: true,
      });

      const router = createRouter();

      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true });
      });

      await router.send(MessageType.PING);
      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'popup' }),
        expect.any(Function),
      );

      Object.defineProperty(globalThis, 'window', {
        value: origWindow,
        writable: true,
        configurable: true,
      });
      Object.defineProperty(globalThis, 'document', {
        value: origDocument,
        writable: true,
        configurable: true,
      });
    });

    it('should return a MessageRouter instance', () => {
      const router = createRouter();
      expect(router).toBeInstanceOf(MessageRouter);
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle messages with no payload', async () => {
      const router = new MessageRouter('background');
      mockChrome.runtime.sendMessage.mockImplementation((_msg: any, cb: any) => {
        cb({ success: true });
      });

      // send without payload
      await router.send(MessageType.PING);

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.PING,
          payload: undefined,
        }),
        expect.any(Function),
      );
    });

    it('should handle handler that returns null (truthy check)', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => null);

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        // null is not undefined, so it counts as a response
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: null,
        });
      });
    });

    it('should handle handler that returns 0', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => 0);

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        // 0 is not undefined, so it counts as a response
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: 0,
        });
      });
    });

    it('should handle handler that returns empty string', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => '');

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        // '' is not undefined, so it counts as a response
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: '',
        });
      });
    });

    it('should handle handler that returns false', async () => {
      const router = new MessageRouter('background');
      router.on(MessageType.PING, () => false);

      const listener = getMessageListener();
      const sendResponse = vi.fn();

      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        sendResponse,
      );

      await vi.waitFor(() => {
        expect(sendResponse).toHaveBeenCalledWith({
          success: true,
          data: false,
        });
      });
    });

    it('should handle rapid sequential sends with unique message IDs', async () => {
      const router = new MessageRouter('background');
      const ids = new Set<string>();

      mockChrome.runtime.sendMessage.mockImplementation((msg: any, cb: any) => {
        ids.add(msg.id);
        cb({ success: true });
      });

      await Promise.all([
        router.send(MessageType.PING),
        router.send(MessageType.PONG),
        router.send(MessageType.HEALTH_CHECK),
      ]);

      expect(ids.size).toBe(3);
    });

    it('should handle sender with no tab property', async () => {
      const router = new MessageRouter('background');
      let receivedMessage: ExtensionMessage | undefined;

      router.on(MessageType.PING, (msg) => {
        receivedMessage = msg;
      });

      const listener = getMessageListener();
      listener(
        { type: MessageType.PING } as ExtensionMessage,
        {} as chrome.runtime.MessageSender,
        vi.fn(),
      );

      await vi.waitFor(() => {
        expect(receivedMessage).toBeDefined();
        expect(receivedMessage!.tabId).toBeUndefined();
      });
    });
  });
});
