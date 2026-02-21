/**
 * Test for MessageRouter ResponseEvent integration (Phase 6)
 * Tests message passing between background and sidepanel for ResponseEvents
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { MessageRouter, MessageType } from '../MessageRouter';
import type { ResponseEvent } from '../models/types/ResponseEvent';

// Mock Chrome runtime API
const mockChrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn()
    },
    onConnect: {
      addListener: vi.fn()
    }
  },
  tabs: {
    sendMessage: vi.fn(),
    query: vi.fn()
  }
};

describe('MessageRouter ResponseEvent Integration', () => {
  let backgroundRouter: MessageRouter;
  let sidepanelRouter: MessageRouter;
  let mockResponseEventHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Must set chrome mock AFTER vi.clearAllMocks and AFTER setup.ts beforeEach
    // because setup.ts overwrites global.chrome without onConnect
    Object.defineProperty(globalThis, 'chrome', {
      value: mockChrome,
      writable: true,
    });

    backgroundRouter = new MessageRouter('background');
    sidepanelRouter = new MessageRouter('sidepanel');
    mockResponseEventHandler = vi.fn();

    // Setup response event handler on sidepanel
    sidepanelRouter.on(MessageType.RESPONSE_EVENT, mockResponseEventHandler);
  });

  test('should send ResponseEvent from background to sidepanel', async () => {
    const testEvent: ResponseEvent = {
      type: 'OutputTextDelta',
      delta: 'Test response text'
    };

    // Mock successful message sending
    mockChrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback({ success: true, data: 'message sent' });
    });

    // Send ResponseEvent from background
    await backgroundRouter.sendResponseEvent(testEvent);

    // Verify message was sent with correct structure
    expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.RESPONSE_EVENT,
        payload: testEvent,
        source: 'background',
        id: expect.any(String),
        timestamp: expect.any(Number)
      }),
      expect.any(Function)
    );
  });

  test('should send typed ResponseEvent with automatic message type detection', async () => {
    const outputTextEvent: ResponseEvent = {
      type: 'OutputTextDelta',
      delta: 'Hello world'
    };

    mockChrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback({ success: true });
    });

    await backgroundRouter.sendTypedResponseEvent(outputTextEvent);

    expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.RESPONSE_OUTPUT_TEXT_DELTA,
        payload: outputTextEvent
      }),
      expect.any(Function)
    );
  });

  test('should handle different ResponseEvent types with correct MessageTypes', async () => {
    mockChrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback({ success: true });
    });

    const testCases: Array<{ event: ResponseEvent; expectedType: MessageType }> = [
      {
        event: { type: 'Created' },
        expectedType: MessageType.RESPONSE_CREATED
      },
      {
        event: { type: 'OutputItemDone', item: { id: 'test', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'test' }] } },
        expectedType: MessageType.RESPONSE_OUTPUT_ITEM_DONE
      },
      {
        event: { type: 'Completed', responseId: 'test-123' },
        expectedType: MessageType.RESPONSE_COMPLETED
      },
      {
        event: { type: 'ReasoningSummaryDelta', delta: 'reasoning text' },
        expectedType: MessageType.RESPONSE_REASONING_SUMMARY_DELTA
      },
      {
        event: { type: 'ReasoningContentDelta', delta: 'thinking text' },
        expectedType: MessageType.RESPONSE_REASONING_CONTENT_DELTA
      },
      {
        event: { type: 'ReasoningSummaryPartAdded' },
        expectedType: MessageType.RESPONSE_REASONING_SUMMARY_PART_ADDED
      },
      {
        event: { type: 'WebSearchCallBegin', callId: 'search-123' },
        expectedType: MessageType.RESPONSE_WEB_SEARCH_CALL_BEGIN
      },
      {
        event: { type: 'RateLimits', snapshot: { primary: { used_percent: 10, window_minutes: 60, resets_in_seconds: 300 } } },
        expectedType: MessageType.RESPONSE_RATE_LIMITS
      }
    ];

    for (const { event, expectedType } of testCases) {
      await backgroundRouter.sendTypedResponseEvent(event);

      expect(mockChrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: expectedType,
          payload: event
        }),
        expect.any(Function)
      );
    }
  });

  test('should use specific send methods for each ResponseEvent type', async () => {
    mockChrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback({ success: true });
    });

    // Test individual send methods
    await backgroundRouter.sendResponseCreated();
    expect(mockChrome.runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MessageType.RESPONSE_CREATED,
        payload: {}
      }),
      expect.any(Function)
    );

    await backgroundRouter.sendResponseOutputTextDelta('Hello');
    expect(mockChrome.runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MessageType.RESPONSE_OUTPUT_TEXT_DELTA,
        payload: { delta: 'Hello' }
      }),
      expect.any(Function)
    );

    await backgroundRouter.sendResponseCompleted('response-123', { total_tokens: 100 });
    expect(mockChrome.runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MessageType.RESPONSE_COMPLETED,
        payload: { responseId: 'response-123', tokenUsage: { total_tokens: 100 } }
      }),
      expect.any(Function)
    );

    await backgroundRouter.sendResponseWebSearchCallBegin('search-456');
    expect(mockChrome.runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: MessageType.RESPONSE_WEB_SEARCH_CALL_BEGIN,
        payload: { callId: 'search-456' }
      }),
      expect.any(Function)
    );
  });

  test('should broadcast ResponseEvent to all tabs', async () => {
    const testEvent: ResponseEvent = {
      type: 'OutputTextDelta',
      delta: 'Broadcast test'
    };

    // Mock tabs.query to return some tabs
    mockChrome.tabs.query.mockResolvedValue([
      { id: 1 },
      { id: 2 },
      { id: 3 }
    ]);

    // Mock successful tab message sending
    mockChrome.tabs.sendMessage.mockImplementation((tabId, message, callback) => {
      callback({ success: true });
    });

    await backgroundRouter.broadcastResponseEvent(testEvent);

    // Should query for all tabs
    expect(mockChrome.tabs.query).toHaveBeenCalledWith({});

    // Should send message to each tab
    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledTimes(3);
    expect(mockChrome.tabs.sendMessage).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        type: MessageType.RESPONSE_EVENT,
        payload: testEvent
      }),
      expect.any(Function)
    );
  });

  test('should handle message sending errors gracefully', async () => {
    const testEvent: ResponseEvent = {
      type: 'OutputTextDelta',
      delta: 'Error test'
    };

    // Mock Chrome runtime error
    mockChrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback({ success: false, error: 'Connection failed' });
    });

    // Should reject with error
    await expect(backgroundRouter.sendResponseEvent(testEvent))
      .rejects.toThrow('Connection failed');
  });

  test('should handle message timeout', async () => {
    vi.useFakeTimers();

    const testEvent: ResponseEvent = {
      type: 'OutputTextDelta',
      delta: 'Timeout test'
    };

    // Mock timeout by not calling callback
    mockChrome.runtime.sendMessage.mockImplementation(() => {
      // Don't call callback - simulates timeout
    });

    // Start the send (will be pending)
    const sendPromise = backgroundRouter.sendResponseEvent(testEvent);

    // Advance timer past the 30 second timeout
    vi.advanceTimersByTime(31000);

    // Should timeout after configured delay
    await expect(sendPromise).rejects.toThrow('Message timeout');

    vi.useRealTimers();
  });

  test('should handle Chrome runtime errors', async () => {
    const testEvent: ResponseEvent = {
      type: 'OutputTextDelta',
      delta: 'Runtime error test'
    };

    // Mock Chrome runtime lastError
    const mockError = { message: 'Extension not found' };
    Object.defineProperty(mockChrome.runtime, 'lastError', {
      get: () => mockError,
      configurable: true
    });

    mockChrome.runtime.sendMessage.mockImplementation((message, callback) => {
      callback(null); // Chrome sets null response when there's a lastError
    });

    await expect(backgroundRouter.sendResponseEvent(testEvent))
      .rejects.toEqual(mockError);
  });

  test('should register and handle ResponseEvent message types', () => {
    const handlers = new Map();

    // Mock the handler registration
    sidepanelRouter.on(MessageType.RESPONSE_OUTPUT_TEXT_DELTA, (message) => {
      expect(message.payload.delta).toBe('test delta');
      return 'handled';
    });

    sidepanelRouter.on(MessageType.RESPONSE_COMPLETED, (message) => {
      expect(message.payload.responseId).toBe('test-response');
      return 'completed handled';
    });

    // Verify handlers can be registered for all ResponseEvent types
    const responseEventTypes = [
      MessageType.RESPONSE_EVENT,
      MessageType.RESPONSE_CREATED,
      MessageType.RESPONSE_OUTPUT_ITEM_DONE,
      MessageType.RESPONSE_COMPLETED,
      MessageType.RESPONSE_OUTPUT_TEXT_DELTA,
      MessageType.RESPONSE_REASONING_SUMMARY_DELTA,
      MessageType.RESPONSE_REASONING_CONTENT_DELTA,
      MessageType.RESPONSE_REASONING_SUMMARY_PART_ADDED,
      MessageType.RESPONSE_WEB_SEARCH_CALL_BEGIN,
      MessageType.RESPONSE_RATE_LIMITS
    ];

    responseEventTypes.forEach(messageType => {
      expect(() => {
        sidepanelRouter.on(messageType, () => {});
      }).not.toThrow();
    });
  });
});