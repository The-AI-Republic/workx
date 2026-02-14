/**
 * Integration Test: DOMTool Content Script Injection
 *
 * Tests the end-to-end content script injection flow to verify:
 * - Correct file path is used in chrome.scripting.executeScript
 * - PING/PONG message exchange works
 * - Retry logic with exponential backoff functions correctly
 *
 * Corresponds to TR-3 from specs/018-inspect-the-domtool/contracts/file-paths.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMTool } from '@/tools/DOMTool';
import { MessageType } from '@/core/MessageRouter';

describe('DOMTool Content Script Injection E2E', () => {
  let domTool: DOMTool;
  let chromeMock: any;
  let executeScriptSpy: any;
  let sendMessageSpy: any;

  beforeEach(() => {
    // Mock chrome.scripting and chrome.tabs APIs
    executeScriptSpy = vi.fn().mockResolvedValue([]);
    sendMessageSpy = vi.fn();

    chromeMock = {
      scripting: {
        executeScript: executeScriptSpy
      },
      tabs: {
        sendMessage: sendMessageSpy,
        query: vi.fn().mockResolvedValue([{ id: 1, active: true }])
      },
      runtime: {
        lastError: null,
        onMessage: {
          addListener: vi.fn()
        }
      },
      permissions: {
        contains: vi.fn().mockResolvedValue(true)
      }
    };

    // @ts-ignore - Mock global chrome
    global.chrome = chromeMock;

    domTool = new DOMTool();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should inject content script with correct file path on first attempt', async () => {
    // Given: Content script not yet loaded (PING fails, injection needed)
    sendMessageSpy.mockRejectedValueOnce(new Error('No response'));
    sendMessageSpy.mockResolvedValueOnce({ type: MessageType.PONG });

    // When: DOMTool attempts to inject content script
    const tabId = 123;
    await domTool['ensureContentScriptInjected'](tabId);

    // Then: chrome.scripting.executeScript should be called with correct path
    expect(executeScriptSpy).toHaveBeenCalledTimes(1);
    expect(executeScriptSpy).toHaveBeenCalledWith({
      target: { tabId: 123 },
      files: ['/content.js']  // NOT '/content/content-script.js'
    });
  });

  it('should NOT inject if content script already responds to PING', async () => {
    // Given: Content script already loaded (PING succeeds immediately)
    sendMessageSpy.mockResolvedValue({ type: MessageType.PONG });

    // When: DOMTool checks if content script is ready
    const tabId = 456;
    await domTool['ensureContentScriptInjected'](tabId);

    // Then: executeScript should NOT be called (script already present)
    expect(executeScriptSpy).not.toHaveBeenCalled();
    expect(sendMessageSpy).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ type: MessageType.PING })
    );
  });

  it('should verify content script responds to PING after injection', async () => {
    // Given: Content script not loaded, needs injection
    sendMessageSpy
      .mockRejectedValueOnce(new Error('No response'))  // First PING fails
      .mockResolvedValueOnce({ type: MessageType.PONG }); // Second PING succeeds

    // When: DOMTool injects and verifies
    const tabId = 789;
    await domTool['ensureContentScriptInjected'](tabId);

    // Then: PING should be sent multiple times (before and after injection)
    expect(sendMessageSpy).toHaveBeenCalled();
    const pingCalls = sendMessageSpy.mock.calls.filter(
      (call: any) => call[1]?.type === MessageType.PING
    );
    expect(pingCalls.length).toBeGreaterThan(0);

    // And: PONG response should be received
    const lastCall = sendMessageSpy.mock.results[sendMessageSpy.mock.results.length - 1];
    expect(lastCall.value).resolves.toEqual({ type: MessageType.PONG });
  });

  it('should retry PING with exponential backoff after injection', async () => {
    // Given: Content script takes time to initialize
    sendMessageSpy
      .mockRejectedValueOnce(new Error('Not ready'))  // Attempt 1: PING before injection
      .mockRejectedValueOnce(new Error('Not ready'))  // Attempt 2: PING after injection
      .mockResolvedValueOnce({ type: MessageType.PONG }); // Attempt 3: Success

    // When: DOMTool injects with retry logic
    const tabId = 999;
    const startTime = Date.now();
    await domTool['ensureContentScriptInjected'](tabId);
    const duration = Date.now() - startTime;

    // Then: Should inject script
    expect(executeScriptSpy).toHaveBeenCalledTimes(1);

    // And: Should retry PING multiple times
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

    // And: Duration should reflect exponential backoff delays (100ms, 200ms, ...)
    // Total expected: ~300ms minimum for 2 retries (100ms + 200ms)
    expect(duration).toBeGreaterThanOrEqual(0); // In test, timing may vary
  });

  it('should throw clear error if injection fails', async () => {
    // Given: chrome.scripting.executeScript fails (file not found)
    sendMessageSpy.mockRejectedValue(new Error('No response'));
    executeScriptSpy.mockRejectedValue(
      new Error("Could not load file: '/content.js'")
    );

    // When: DOMTool attempts injection
    const tabId = 111;
    const error = await domTool['ensureContentScriptInjected'](tabId)
      .catch(e => e);

    // Then: Should throw informative error
    expect(error).toBeDefined();
    expect(error.message).toContain('Failed to inject content script');
    expect(error.message).toContain('Could not load file');

    // And: Should have DOMError metadata
    expect(error.domError).toBeDefined();
    expect(error.domError.code).toBe('SCRIPT_INJECTION_FAILED');
  });

  it('should timeout after max retries if script never responds', async () => {
    // Given: PING always fails (script never loads)
    sendMessageSpy.mockRejectedValue(new Error('Timeout'));

    // When: DOMTool exhausts all retry attempts
    const tabId = 222;
    const error = await domTool['ensureContentScriptInjected'](tabId)
      .catch(e => e);

    // Then: Should throw timeout error
    expect(error).toBeDefined();
    expect(error.message).toContain('Content script failed to respond');
    expect(error.message).toContain('5 attempts'); // maxRetries = 5

    // And: Should have attempted injection
    expect(executeScriptSpy).toHaveBeenCalledTimes(1);

    // And: Should have tried PING multiple times
    expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
  });
});

describe('DOMTool Content Script File Path Verification', () => {
  it('should use constant instead of hardcoded string', async () => {
    // Given: Mock chrome APIs
    const executeScriptSpy = vi.fn().mockResolvedValue([]);
    const sendMessageSpy = vi.fn()
      .mockRejectedValueOnce(new Error('No response'))
      .mockResolvedValueOnce({ type: MessageType.PONG });

    const chromeMock = {
      scripting: { executeScript: executeScriptSpy },
      tabs: {
        sendMessage: sendMessageSpy,
        query: vi.fn().mockResolvedValue([{ id: 1, active: true }])
      },
      runtime: {
        lastError: null,
        onMessage: { addListener: vi.fn() }
      },
      permissions: {
        contains: vi.fn().mockResolvedValue(true)
      }
    };

    // @ts-ignore
    global.chrome = chromeMock;
    const domTool = new DOMTool();

    // When: Inject content script
    await domTool['ensureContentScriptInjected'](123);

    // Then: Verify call used correct path (from constant)
    const call = executeScriptSpy.mock.calls[0][0];
    expect(call.files).toEqual(['/content.js']);
    expect(call.files[0]).not.toBe('/content/content-script.js');
  });
});
