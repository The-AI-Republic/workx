/**
 * Unit tests for WebSearchTool
 *
 * Covers: tool definition, parameter validation, CDP-based search flow,
 * window/tab lifecycle, debugger attach/detach, page load waiting,
 * consent dialog dismissal, result extraction, error handling, cleanup,
 * debug mode, maxResults capping, and edge cases.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { WebSearchTool } from '@/tools/WebSearchTool';
import type { WebSearchToolRequest } from '@/tools/WebSearchTool';
import type { BaseToolOptions } from '@/tools/BaseTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a minimal chrome.tabs.Tab stub */
function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 42,
    index: 0,
    pinned: false,
    highlighted: false,
    windowId: 100,
    active: true,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: 'about:blank',
    title: '',
    status: 'complete',
    ...overrides,
  } as chrome.tabs.Tab;
}

/** Creates a minimal chrome.windows.Window stub */
function makeWindow(
  overrides: Partial<chrome.windows.Window> = {},
  tabs: chrome.tabs.Tab[] = [makeTab()],
): chrome.windows.Window {
  return {
    id: 100,
    focused: false,
    alwaysOnTop: false,
    incognito: false,
    state: 'minimized',
    type: 'popup',
    tabs,
    ...overrides,
  } as chrome.windows.Window;
}

/**
 * Set up all chrome APIs that WebSearchTool requires.
 * Call this inside beforeEach after the global chrome is installed.
 */
function setupChromeForWebSearch() {
  const c = (globalThis as any).chrome;

  // windows API
  c.windows = {
    create: vi.fn().mockResolvedValue(makeWindow()),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };

  // debugger API
  c.debugger = {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  };
}

/** Convenience accessor for the chrome mock */
function chromeMock(): any {
  return (globalThis as any).chrome;
}

/**
 * By default, Page.loadEventFired fires immediately when listener is added.
 * This simulates a fast page load.
 */
function simulateImmediatePageLoad(tabId: number = 42) {
  chromeMock().debugger.onEvent.addListener.mockImplementation(
    (listener: (source: any, method: string) => void) => {
      // Fire the load event immediately (async to match real behavior)
      setTimeout(() => listener({ tabId }, 'Page.loadEventFired'), 0);
    },
  );
}

/**
 * Simulate successful result extraction via CDP Runtime.evaluate.
 * The last sendCommand call (for extraction) returns mock search results.
 */
function simulateSearchResults(results: any[] = []) {
  const sendCommand = chromeMock().debugger.sendCommand as Mock;
  // The extraction call is Runtime.evaluate with the extraction script
  // We need to intercept it and return the expected shape
  sendCommand.mockImplementation(async (_target: any, method: string, params?: any) => {
    if (method === 'Runtime.evaluate' && params?.expression?.includes('isAdElement')) {
      return { result: { value: results } };
    }
    return {};
  });
}

// ---------------------------------------------------------------------------
// Testable subclass that exposes protected executeImpl for direct testing
// ---------------------------------------------------------------------------

class TestableWebSearchTool extends WebSearchTool {
  public async callExecuteImpl(request: WebSearchToolRequest, options?: any) {
    return this.executeImpl(request, options);
  }
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('WebSearchTool', () => {
  let tool: WebSearchTool;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    tool = new WebSearchTool();
    setupChromeForWebSearch();
    simulateImmediatePageLoad();
    simulateSearchResults([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'Snippet 1' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Snippet 2' },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Tool Definition
  // -----------------------------------------------------------------------
  describe('Tool Definition', () => {
    it('should expose a function-type tool definition', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
    });

    it('should be named web_search', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.name).toBe('web_search');
      }
    });

    it('should have a description mentioning Google search', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.description).toContain('Google');
      }
    });

    it('should declare query as a required parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        expect(def.function.parameters.required).toContain('query');
      }
    });

    it('should define maxResults as a number parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const props = def.function.parameters.properties as any;
        expect(props.maxResults.type).toBe('number');
      }
    });

    it('should include search category', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).category).toBe('search');
      }
    });

    it('should include version 1.0.0', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).version).toBe('1.0.0');
      }
    });

    it('should list web_search and information_retrieval capabilities', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.capabilities).toEqual(
          expect.arrayContaining(['web_search', 'information_retrieval']),
        );
      }
    });

    it('should require tabs, scripting, and debugger permissions', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.permissions).toEqual(
          expect.arrayContaining(['tabs', 'scripting', 'debugger']),
        );
      }
    });

    it('should support extension and desktop platforms', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.platforms).toEqual(
          expect.arrayContaining(['extension', 'desktop']),
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // Parameter Validation (handled by BaseTool.execute -> validateParameters)
  // -----------------------------------------------------------------------
  describe('Parameter Validation', () => {
    it('should fail when required query parameter is missing', async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain('query');
    });

    it('should fail when query is null', async () => {
      const result = await tool.execute({ query: null });
      expect(result.success).toBe(false);
      expect(result.error).toContain('query');
    });

    it('should fail when query has wrong type (number)', async () => {
      const result = await tool.execute({ query: 123 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should fail when maxResults has wrong type (string)', async () => {
      const result = await tool.execute({ query: 'test', maxResults: 'many' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('number');
    });

    it('should reject unknown parameters', async () => {
      const result = await tool.execute({ query: 'test', unknownParam: 'value' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown parameter');
    });

    it('should accept valid minimal parameters (query only)', async () => {
      const result = await tool.execute({ query: 'test search' });
      expect(result.success).toBe(true);
    });

    it('should accept query with maxResults', async () => {
      const result = await tool.execute({ query: 'test', maxResults: 5 });
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Empty Query Validation (in executeImpl)
  // -----------------------------------------------------------------------
  describe('Empty Query Validation', () => {
    it('should fail when query is empty string', async () => {
      const result = await tool.execute({ query: '' });
      // Empty string passes required check (it's present) but fails the trim check
      // Actually, BaseTool validation passes empty strings - the executeImpl checks trim
      // But BaseTool validates 'string' type first. Let's check if '' passes that.
      // '' is a string, so type check passes. Then executeImpl checks trim().length === 0
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });

    it('should fail when query is only whitespace', async () => {
      const result = await tool.execute({ query: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('empty');
    });
  });

  // -----------------------------------------------------------------------
  // Chrome Context Validation
  // -----------------------------------------------------------------------
  describe('Chrome Context Validation', () => {
    it('should fail when chrome is undefined', async () => {
      const original = (globalThis as any).chrome;
      delete (globalThis as any).chrome;

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Chrome extension APIs not available');

      // Restore
      (globalThis as any).chrome = original;
    });
  });

  // -----------------------------------------------------------------------
  // Window and Tab Creation
  // -----------------------------------------------------------------------
  describe('Window and Tab Creation', () => {
    it('should create a popup window with correct parameters', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().windows.create).toHaveBeenCalledWith({
        url: 'about:blank',
        type: 'popup',
        width: 100,
        height: 100,
        focused: false,
      });
    });

    it('should minimize the window after creation', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().windows.update).toHaveBeenCalledWith(100, { state: 'minimized' });
    });

    it('should fail when window creation returns null', async () => {
      chromeMock().windows.create.mockResolvedValue(null);

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
    });

    it('should fail when window has no tabs', async () => {
      chromeMock().windows.create.mockResolvedValue(makeWindow({}, []));

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create search window/tab');
    });

    it('should fail when tab has no id', async () => {
      const tabNoId = makeTab({ id: undefined });
      chromeMock().windows.create.mockResolvedValue(makeWindow({}, [tabNoId]));

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to create search window/tab');
    });

    it('should not minimize if window has no id', async () => {
      const windowNoId = makeWindow({ id: undefined });
      // But tabs still have id, so won't fail at tab check
      chromeMock().windows.create.mockResolvedValue(windowNoId);

      // Will fail at tab check since tabs[0] exists but window.id might cause issues
      // Actually looking at the code: first it checks searchWindow?.id for update
      // then checks searchWindow?.tabs?.[0]?.id. If window.id is undefined, update is skipped
      // but tab check still works.
      const result = await tool.execute({ query: 'test' });
      // Window update should NOT be called when window.id is undefined
      expect(chromeMock().windows.update).not.toHaveBeenCalledWith(undefined, expect.anything());
    });
  });

  // -----------------------------------------------------------------------
  // Debugger Lifecycle
  // -----------------------------------------------------------------------
  describe('Debugger Lifecycle', () => {
    it('should attach debugger with version 1.3', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().debugger.attach).toHaveBeenCalledWith({ tabId: 42 }, '1.3');
    });

    it('should enable Page and Runtime CDP domains', async () => {
      await tool.execute({ query: 'test' });

      const sendCommand = chromeMock().debugger.sendCommand;
      expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Page.enable', {});
      expect(sendCommand).toHaveBeenCalledWith({ tabId: 42 }, 'Runtime.enable', {});
    });

    it('should detach debugger after successful search', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    });

    it('should detach debugger even when detach throws (ignores error)', async () => {
      // Make the first detach call throw, second call succeed (in cleanup)
      chromeMock().debugger.detach.mockRejectedValue(new Error('already detached'));

      // Should not throw - error is caught and ignored
      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
    });

    it('should fail when debugger attach throws', async () => {
      chromeMock().debugger.attach.mockRejectedValue(
        new Error('Cannot attach to this target'),
      );

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot attach to this target');
    });

    it('should detach debugger in catch block when error occurs after attach', async () => {
      // Attach succeeds, but sendCommand fails
      chromeMock().debugger.sendCommand.mockRejectedValue(
        new Error('CDP command failed'),
      );

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      // Debugger should have been detached in catch block
      expect(chromeMock().debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    });

    it('should ignore detach errors during error cleanup', async () => {
      // Attach succeeds
      chromeMock().debugger.attach.mockResolvedValue(undefined);
      // sendCommand fails to trigger catch block
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('CDP failed'));
      // Detach also fails during cleanup
      chromeMock().debugger.detach.mockRejectedValue(new Error('detach failed'));

      const result = await tool.execute({ query: 'test' });
      // The original error should propagate, not the detach error
      expect(result.success).toBe(false);
      expect(result.error).toContain('CDP failed');
    });
  });

  // -----------------------------------------------------------------------
  // Page Navigation
  // -----------------------------------------------------------------------
  describe('Page Navigation', () => {
    it('should navigate to Google search URL with encoded query', async () => {
      await tool.execute({ query: 'hello world' });

      const sendCommand = chromeMock().debugger.sendCommand;
      expect(sendCommand).toHaveBeenCalledWith(
        { tabId: 42 },
        'Page.navigate',
        { url: 'https://www.google.com/search?q=hello%20world' },
      );
    });

    it('should URL-encode special characters in query', async () => {
      await tool.execute({ query: 'test & search = "query"' });

      const sendCommand = chromeMock().debugger.sendCommand;
      const navigateCall = sendCommand.mock.calls.find(
        (call: any[]) => call[1] === 'Page.navigate',
      );
      expect(navigateCall).toBeDefined();
      expect(navigateCall[2].url).toContain(
        encodeURIComponent('test & search = "query"'),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Page Load Waiting
  // -----------------------------------------------------------------------
  describe('Page Load Waiting (waitForPageLoad)', () => {
    it('should resolve when Page.loadEventFired is received', async () => {
      // Already set up via simulateImmediatePageLoad()
      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
    });

    it('should register an event listener on debugger.onEvent', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().debugger.onEvent.addListener).toHaveBeenCalled();
    });

    it('should remove the event listener after load event fires', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().debugger.onEvent.removeListener).toHaveBeenCalled();
    });

    it('should timeout if page never loads', async () => {
      // Override: listener is added but never fires
      chromeMock().debugger.onEvent.addListener.mockImplementation(() => {
        // Do nothing - the event never fires
      });

      const executePromise = tool.execute({ query: 'test' });

      // Advance past the 15000ms default timeout
      await vi.advanceTimersByTimeAsync(16000);

      const result = await executePromise;
      expect(result.success).toBe(false);
      expect(result.error).toContain('timed out');
    });

    it('should ignore events from other tabs', async () => {
      // Fire event from a different tab first, then from the correct tab
      chromeMock().debugger.onEvent.addListener.mockImplementation(
        (listener: (source: any, method: string) => void) => {
          setTimeout(() => listener({ tabId: 999 }, 'Page.loadEventFired'), 0);
          setTimeout(() => listener({ tabId: 42 }, 'Page.loadEventFired'), 10);
        },
      );

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
    });

    it('should ignore non-loadEventFired events from the correct tab', async () => {
      chromeMock().debugger.onEvent.addListener.mockImplementation(
        (listener: (source: any, method: string) => void) => {
          // Fire some other event first
          setTimeout(() => listener({ tabId: 42 }, 'Network.requestWillBeSent'), 0);
          // Then fire the actual load event
          setTimeout(() => listener({ tabId: 42 }, 'Page.loadEventFired'), 10);
        },
      );

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Consent Dialog Dismissal
  // -----------------------------------------------------------------------
  describe('Consent Dialog Dismissal (dismissConsentDialogs)', () => {
    it('should execute a consent dismissal script via Runtime.evaluate', async () => {
      await tool.execute({ query: 'test' });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      // Find calls to Runtime.evaluate that include consent-related code
      const consentCalls = sendCommand.mock.calls.filter(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('reject all'),
      );
      expect(consentCalls.length).toBeGreaterThan(0);
    });

    it('should not fail when consent dismissal throws', async () => {
      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const originalImpl = sendCommand.getMockImplementation();

      sendCommand.mockImplementation(async (target: any, method: string, params?: any) => {
        // Make the consent dismissal script fail
        if (
          method === 'Runtime.evaluate' &&
          params?.expression?.includes('reject all')
        ) {
          throw new Error('Script execution failed');
        }
        // For extraction, return results
        if (method === 'Runtime.evaluate' && params?.expression?.includes('isAdElement')) {
          return { result: { value: [] } };
        }
        return {};
      });

      const result = await tool.execute({ query: 'test' });
      // Should succeed despite consent dismissal failure
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Result Extraction
  // -----------------------------------------------------------------------
  describe('Result Extraction (extractResultsWithCDP)', () => {
    it('should return extracted search results', async () => {
      const mockResults = [
        { title: 'First Result', url: 'https://first.com', snippet: 'First snippet' },
        { title: 'Second Result', url: 'https://second.com', snippet: 'Second snippet' },
      ];
      simulateSearchResults(mockResults);

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.results).toEqual(mockResults);
    });

    it('should return empty array when no results are found', async () => {
      simulateSearchResults([]);

      const result = await tool.execute({ query: 'obscure query xyz123' });
      expect(result.success).toBe(true);
      expect(result.data.results).toEqual([]);
    });

    it('should include the query in the response', async () => {
      const result = await tool.execute({ query: 'my search query' });
      expect(result.success).toBe(true);
      expect(result.data.query).toBe('my search query');
    });

    it('should return empty array when extraction throws', async () => {
      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      sendCommand.mockImplementation(async (_target: any, method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression?.includes('isAdElement')) {
          throw new Error('Extraction failed');
        }
        return {};
      });

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.results).toEqual([]);
    });

    it('should handle null result.value gracefully', async () => {
      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      sendCommand.mockImplementation(async (_target: any, method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression?.includes('isAdElement')) {
          return { result: { value: null } };
        }
        return {};
      });

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.results).toEqual([]);
    });

    it('should handle missing result property gracefully', async () => {
      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      sendCommand.mockImplementation(async (_target: any, method: string, params?: any) => {
        if (method === 'Runtime.evaluate' && params?.expression?.includes('isAdElement')) {
          return {};
        }
        return {};
      });

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(true);
      expect(result.data.results).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // maxResults Handling
  // -----------------------------------------------------------------------
  describe('maxResults Handling', () => {
    it('should default maxResults to 10', async () => {
      await tool.execute({ query: 'test' });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const extractionCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('isAdElement'),
      );
      expect(extractionCall).toBeDefined();
      expect(extractionCall[2].expression).toContain(')(10)');
    });

    it('should respect provided maxResults value', async () => {
      await tool.execute({ query: 'test', maxResults: 5 });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const extractionCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('isAdElement'),
      );
      expect(extractionCall).toBeDefined();
      expect(extractionCall[2].expression).toContain(')(5)');
    });

    it('should cap maxResults at 20', async () => {
      await tool.execute({ query: 'test', maxResults: 50 });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const extractionCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('isAdElement'),
      );
      expect(extractionCall).toBeDefined();
      expect(extractionCall[2].expression).toContain(')(20)');
    });

    it('should use 10 when maxResults is 0 (falsy)', async () => {
      await tool.execute({ query: 'test', maxResults: 0 });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const extractionCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('isAdElement'),
      );
      expect(extractionCall).toBeDefined();
      // 0 is falsy, so || 10 gives 10, then Math.min(10, 20) = 10
      expect(extractionCall[2].expression).toContain(')(10)');
    });
  });

  // -----------------------------------------------------------------------
  // Window Cleanup (non-debug mode)
  // -----------------------------------------------------------------------
  describe('Window Cleanup', () => {
    it('should close the search window after successful search', async () => {
      await tool.execute({ query: 'test' });

      expect(chromeMock().windows.remove).toHaveBeenCalledWith(100);
    });

    it('should close the window in catch block when error occurs', async () => {
      // Make sendCommand fail after attach
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('fail'));

      await tool.execute({ query: 'test' });

      expect(chromeMock().windows.remove).toHaveBeenCalledWith(100);
    });

    it('should ignore window removal errors during error cleanup', async () => {
      // Make sendCommand fail after attach
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('fail'));
      // Make window removal also fail
      chromeMock().windows.remove.mockRejectedValue(new Error('window gone'));

      const result = await tool.execute({ query: 'test' });
      // The original error should propagate
      expect(result.success).toBe(false);
      expect(result.error).toContain('fail');
    });

    it('should not attempt to remove window when window.id is falsy in catch', async () => {
      // Create a window with no id
      chromeMock().windows.create.mockResolvedValue(makeWindow({ id: undefined }));
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('fail'));

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      // windows.remove should not be called with undefined
      expect(chromeMock().windows.remove).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Debug Mode (via direct executeImpl, since debug is not in the tool schema)
  // -----------------------------------------------------------------------
  describe('Debug Mode', () => {
    let testableTool: TestableWebSearchTool;

    beforeEach(() => {
      testableTool = new TestableWebSearchTool();
    });

    it('should reject debug parameter through public execute (unknown param)', async () => {
      const result = await tool.execute({ query: 'test', debug: true });
      // debug is not in the tool definition; additionalProperties: false rejects it
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown parameter');
    });

    it('should NOT close window when debug=true (via executeImpl)', async () => {
      await testableTool.callExecuteImpl({ query: 'test', debug: true });

      // Window should not be removed in debug mode
      expect(chromeMock().windows.remove).not.toHaveBeenCalled();
    });

    it('should restore window to normal focused state in debug mode on success', async () => {
      await testableTool.callExecuteImpl({ query: 'test', debug: true });

      expect(chromeMock().windows.update).toHaveBeenCalledWith(100, {
        state: 'normal',
        focused: true,
      });
    });

    it('should NOT close window when debug=true on error (via executeImpl)', async () => {
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('fail'));

      await expect(
        testableTool.callExecuteImpl({ query: 'test', debug: true }),
      ).rejects.toThrow('fail');

      expect(chromeMock().windows.remove).not.toHaveBeenCalled();
    });

    it('should restore window to normal focused state in debug mode on error', async () => {
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('fail'));

      await expect(
        testableTool.callExecuteImpl({ query: 'test', debug: true }),
      ).rejects.toThrow('fail');

      // The last call to windows.update should be the debug restore
      const updateCalls = chromeMock().windows.update.mock.calls;
      const lastCall = updateCalls[updateCalls.length - 1];
      expect(lastCall).toEqual([100, { state: 'normal', focused: true }]);
    });

    it('should default debug to false and close window', async () => {
      await tool.execute({ query: 'test' });

      // Window should be removed (not debug mode)
      expect(chromeMock().windows.remove).toHaveBeenCalled();
    });

    it('should log debug info when keeping window open on success', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

      await testableTool.callExecuteImpl({ query: 'test', debug: true });

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Debug mode: keeping search window open'),
      );
      consoleSpy.mockRestore();
    });

    it('should log debug info when keeping window open on error', async () => {
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('fail'));

      await expect(
        testableTool.callExecuteImpl({ query: 'test', debug: true }),
      ).rejects.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Debug mode: keeping search window open on error'),
      );
      consoleSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // Full Successful Flow
  // -----------------------------------------------------------------------
  describe('Full Successful Search Flow', () => {
    it('should return query and results on success', async () => {
      const mockResults = [
        { title: 'Test', url: 'https://test.com', snippet: 'Test snippet' },
      ];
      simulateSearchResults(mockResults);

      const result = await tool.execute({ query: 'test search' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        query: 'test search',
        results: mockResults,
      });
    });

    it('should follow the complete CDP flow in order', async () => {
      const callOrder: string[] = [];

      chromeMock().windows.create.mockImplementation(async () => {
        callOrder.push('windows.create');
        return makeWindow();
      });
      chromeMock().windows.update.mockImplementation(async () => {
        callOrder.push('windows.update');
      });
      chromeMock().debugger.attach.mockImplementation(async () => {
        callOrder.push('debugger.attach');
      });
      chromeMock().debugger.sendCommand.mockImplementation(
        async (_target: any, method: string, params?: any) => {
          callOrder.push(`sendCommand:${method}`);
          if (method === 'Runtime.evaluate' && params?.expression?.includes('isAdElement')) {
            return { result: { value: [] } };
          }
          return {};
        },
      );
      chromeMock().debugger.detach.mockImplementation(async () => {
        callOrder.push('debugger.detach');
      });
      chromeMock().windows.remove.mockImplementation(async () => {
        callOrder.push('windows.remove');
      });

      await tool.execute({ query: 'test' });

      expect(callOrder).toEqual([
        'windows.create',
        'windows.update', // minimize
        'debugger.attach',
        'sendCommand:Page.enable',
        'sendCommand:Runtime.enable',
        'sendCommand:Page.navigate',
        // waitForPageLoad happens via event
        'sendCommand:Runtime.evaluate', // consent dismissal
        'sendCommand:Runtime.evaluate', // extraction
        'debugger.detach',
        'windows.remove',
      ]);
    });

    it('should include metadata with duration and toolName', async () => {
      const result = await tool.execute({ query: 'test' });

      expect(result.success).toBe(true);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.toolName).toBe('web_search');
      expect(typeof result.metadata!.duration).toBe('number');
    });
  });

  // -----------------------------------------------------------------------
  // Error Propagation
  // -----------------------------------------------------------------------
  describe('Error Propagation', () => {
    it('should propagate window creation errors', async () => {
      chromeMock().windows.create.mockRejectedValue(new Error('Window creation denied'));

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Window creation denied');
    });

    it('should propagate debugger attach errors', async () => {
      chromeMock().debugger.attach.mockRejectedValue(
        new Error('Target is already being debugged'),
      );

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('already being debugged');
    });

    it('should propagate Page.enable errors', async () => {
      chromeMock().debugger.sendCommand.mockRejectedValue(new Error('Domain not found'));

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Domain not found');
    });

    it('should include error type in metadata', async () => {
      chromeMock().windows.create.mockRejectedValue(new TypeError('Invalid argument'));

      const result = await tool.execute({ query: 'test' });
      expect(result.success).toBe(false);
      expect(result.metadata?.errorType).toBe('TypeError');
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup When debugger not attached yet
  // -----------------------------------------------------------------------
  describe('Cleanup without debugger attached', () => {
    it('should not attempt debugger detach in catch when attach failed', async () => {
      chromeMock().debugger.attach.mockRejectedValue(new Error('attach failed'));

      await tool.execute({ query: 'test' });

      // Detach should NOT have been called since attach failed
      // (debuggerAttached is false)
      expect(chromeMock().debugger.detach).not.toHaveBeenCalled();
    });

    it('should still clean up window when attach fails', async () => {
      chromeMock().debugger.attach.mockRejectedValue(new Error('attach failed'));

      await tool.execute({ query: 'test' });

      expect(chromeMock().windows.remove).toHaveBeenCalledWith(100);
    });
  });

  // -----------------------------------------------------------------------
  // Cleanup when tab is null
  // -----------------------------------------------------------------------
  describe('Cleanup edge cases for searchTab', () => {
    it('should not detach debugger when searchTab is null in catch', async () => {
      // If window creation returns no tabs, searchTab remains null
      chromeMock().windows.create.mockResolvedValue(makeWindow({}, []));

      await tool.execute({ query: 'test' });

      expect(chromeMock().debugger.detach).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Multiple Searches (isolation)
  // -----------------------------------------------------------------------
  describe('Multiple Searches', () => {
    it('should support multiple sequential searches', async () => {
      const result1 = await tool.execute({ query: 'first search' });
      expect(result1.success).toBe(true);
      expect(result1.data.query).toBe('first search');

      // Reset mocks for a fresh second search
      setupChromeForWebSearch();
      simulateImmediatePageLoad();
      simulateSearchResults([
        { title: 'Different', url: 'https://different.com', snippet: 'Different' },
      ]);

      const result2 = await tool.execute({ query: 'second search' });
      expect(result2.success).toBe(true);
      expect(result2.data.query).toBe('second search');
    });
  });

  // -----------------------------------------------------------------------
  // BaseTool integration (execute wrapper)
  // -----------------------------------------------------------------------
  describe('BaseTool execute wrapper', () => {
    it('should wrap successful result in ToolResult format', async () => {
      const result = await tool.execute({ query: 'test' });

      expect(result).toHaveProperty('success', true);
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('metadata');
      expect(result.error).toBeUndefined();
    });

    it('should wrap errors in ToolResult format', async () => {
      chromeMock().windows.create.mockRejectedValue(new Error('boom'));

      const result = await tool.execute({ query: 'test' });

      expect(result).toHaveProperty('success', false);
      expect(result).toHaveProperty('error');
      expect(result).toHaveProperty('metadata');
      expect(result.data).toBeUndefined();
    });

    it('should pass options metadata through to the result', async () => {
      const result = await tool.execute(
        { query: 'test' },
        { metadata: { requestId: 'req-123' } },
      );

      expect(result.success).toBe(true);
      expect(result.metadata?.requestId).toBe('req-123');
    });
  });

  // -----------------------------------------------------------------------
  // Extraction script content checks
  // -----------------------------------------------------------------------
  describe('Extraction Script', () => {
    it('should pass maxResults into the extraction script', async () => {
      await tool.execute({ query: 'test', maxResults: 7 });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const extractionCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('isAdElement'),
      );
      expect(extractionCall[2].expression).toContain(')(7)');
    });

    it('should use returnByValue: true for extraction', async () => {
      await tool.execute({ query: 'test' });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const extractionCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('isAdElement'),
      );
      expect(extractionCall[2].returnByValue).toBe(true);
    });

    it('should use returnByValue: true for consent dismissal', async () => {
      await tool.execute({ query: 'test' });

      const sendCommand = chromeMock().debugger.sendCommand as Mock;
      const consentCall = sendCommand.mock.calls.find(
        (call: any[]) =>
          call[1] === 'Runtime.evaluate' &&
          call[2]?.expression?.includes('reject all'),
      );
      expect(consentCall[2].returnByValue).toBe(true);
    });
  });
});
