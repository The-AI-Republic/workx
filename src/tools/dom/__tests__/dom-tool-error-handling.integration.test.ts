/**
 * Integration Test: DOMTool Error Handling
 *
 * Tests error handling for content script injection failures to verify:
 * - Clear error messages when files are not found (EC-1)
 * - Distinction between file errors and permission errors (EC-2)
 * - Proper error codes and metadata
 *
 * Corresponds to error conditions from specs/018-inspect-the-domtool/contracts/file-paths.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMTool } from '@/tools/DOMTool';
import { ErrorCode } from '../../../specs/001-dom-tool-integration/contracts/dom-operations';

describe('DOMTool Error Handling - EC-1: File Not Found', () => {
  let domTool: DOMTool;
  let chromeMock: any;

  beforeEach(() => {
    const executeScriptSpy = vi.fn();
    const sendMessageSpy = vi.fn();

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
        onMessage: { addListener: vi.fn() }
      },
      permissions: {
        contains: vi.fn().mockResolvedValue(true)
      }
    };

    // @ts-ignore
    global.chrome = chromeMock;
    domTool = new DOMTool();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should provide clear error when file not found', async () => {
    // Given: chrome.scripting.executeScript fails with file not found
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error("Could not load file: '/wrong-path.js'")
    );

    // When: DOMTool attempts injection
    const tabId = 123;
    const error = await domTool['ensureContentScriptInjected'](tabId)
      .catch(e => e);

    // Then: Error message should be informative
    expect(error).toBeDefined();
    expect(error.message).toContain('Failed to inject content script');
    expect(error.message).toContain('Could not load file');

    // And: Should have proper error code
    expect(error.domError).toBeDefined();
    expect(error.domError.code).toBe(ErrorCode.SCRIPT_INJECTION_FAILED);
  });

  it('should include original error details', async () => {
    // Given: Injection fails with specific path
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error("Could not load file: '/content/content-script.js'")
    );

    // When: DOMTool attempts injection
    const error = await domTool['ensureContentScriptInjected'](456)
      .catch(e => e);

    // Then: Original error should be preserved
    expect(error.domError.details).toBeDefined();
    expect(error.domError.details.tabId).toBe(456);
    expect(error.domError.details.originalError).toBeDefined();
  });

  it('should format error message for user readability', async () => {
    // Given: File not found error
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error("Could not load file: '/missing.js'")
    );

    // When: DOMTool attempts injection
    const error = await domTool['ensureContentScriptInjected'](789)
      .catch(e => e);

    // Then: Error should be user-friendly
    expect(error.message).toMatch(/Failed to inject content script/);
    expect(error.message).not.toMatch(/undefined/);
    expect(error.message).not.toMatch(/\[object Object\]/);
  });
});

describe('DOMTool Error Handling - EC-2: Permission Denied', () => {
  let domTool: DOMTool;
  let chromeMock: any;

  beforeEach(() => {
    chromeMock = {
      scripting: {
        executeScript: vi.fn()
      },
      tabs: {
        sendMessage: vi.fn(),
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
    domTool = new DOMTool();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should distinguish file errors from permission errors', async () => {
    // Given: Permission denied error (different from file not found)
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error('Cannot access contents of url "chrome://extensions/". Extension manifest must request permission to access this host.')
    );

    // When: DOMTool attempts injection
    const error = await domTool['ensureContentScriptInjected'](123)
      .catch(e => e);

    // Then: Error type should be identifiable
    expect(error).toBeDefined();
    expect(error.message).toContain('Cannot access');
    expect(error.message).not.toContain('Could not load file');

    // And: Error should indicate injection failure
    expect(error.message).toContain('Failed to inject content script');
  });

  it('should handle CSP violations differently than file errors', async () => {
    // Given: CSP violation (different error pattern)
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error('Refused to execute inline script because it violates Content Security Policy')
    );

    // When: DOMTool attempts injection
    const error = await domTool['ensureContentScriptInjected'](456)
      .catch(e => e);

    // Then: Should not confuse with file path issue
    expect(error.message).not.toContain('Could not load file');
    expect(error.message).toContain('Failed to inject content script');
  });
});

describe('DOMTool Error Handling - Timeout Errors', () => {
  let domTool: DOMTool;
  let chromeMock: any;

  beforeEach(() => {
    chromeMock = {
      scripting: {
        executeScript: vi.fn().mockResolvedValue([])
      },
      tabs: {
        sendMessage: vi.fn().mockRejectedValue(new Error('Timeout')),
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
    domTool = new DOMTool();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should provide clear timeout error after max retries', async () => {
    // Given: PING never succeeds (content script never responds)
    // sendMessage already mocked to always reject

    // When: DOMTool exhausts all retry attempts
    const error = await domTool['ensureContentScriptInjected'](789)
      .catch(e => e);

    // Then: Timeout error should be clear
    expect(error).toBeDefined();
    expect(error.message).toContain('Content script failed to respond');
    expect(error.message).toContain('5 attempts');

    // And: Should have proper error code
    expect(error.domError).toBeDefined();
    expect(error.domError.code).toBe(ErrorCode.TIMEOUT);
    expect(error.domError.details.tabId).toBe(789);
  });

  it('should indicate number of retry attempts in error', async () => {
    // Given: PING always times out
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('Timeout'));

    // When: DOMTool retries multiple times
    const error = await domTool['ensureContentScriptInjected'](999)
      .catch(e => e);

    // Then: Error should mention retry count
    expect(error.message).toMatch(/\d+ attempts/);
    const attemptMatch = error.message.match(/(\d+) attempts/);
    expect(attemptMatch).toBeTruthy();
    const attemptCount = parseInt(attemptMatch![1], 10);
    expect(attemptCount).toBe(5); // maxRetries = 5
  });
});

describe('DOMTool Error Handling - Error Metadata', () => {
  let domTool: DOMTool;
  let chromeMock: any;

  beforeEach(() => {
    chromeMock = {
      scripting: {
        executeScript: vi.fn()
      },
      tabs: {
        sendMessage: vi.fn(),
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
    domTool = new DOMTool();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should include DOMError metadata for all injection errors', async () => {
    // Given: Any injection failure
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error('Generic injection error')
    );

    // When: Error occurs
    const error = await domTool['ensureContentScriptInjected'](123)
      .catch(e => e);

    // Then: Should have domError property with standard fields
    expect(error.domError).toBeDefined();
    expect(error.domError.code).toBeDefined();
    expect(error.domError.message).toBeDefined();
    expect(error.domError.details).toBeDefined();
  });

  it('should include tabId in error details for debugging', async () => {
    // Given: Injection fails
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(
      new Error('Injection failed')
    );

    // When: Error occurs on specific tab
    const testTabId = 42;
    const error = await domTool['ensureContentScriptInjected'](testTabId)
      .catch(e => e);

    // Then: Tab ID should be in error details
    expect(error.domError.details.tabId).toBe(testTabId);
  });

  it('should preserve original error in details', async () => {
    // Given: Specific error from Chrome API
    const originalError = new Error('Original Chrome API error');
    chromeMock.tabs.sendMessage.mockRejectedValue(new Error('No response'));
    chromeMock.scripting.executeScript.mockRejectedValue(originalError);

    // When: Error is wrapped
    const error = await domTool['ensureContentScriptInjected'](123)
      .catch(e => e);

    // Then: Original error should be preserved
    expect(error.domError.details.originalError).toBe(originalError);
  });
});
