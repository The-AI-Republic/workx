/**
 * Unit tests for NavigationTool
 *
 * Covers: parameter validation, URL navigation, wait conditions,
 * back/forward/reload, timeout handling, history, stop, getCurrentUrl,
 * waitForLoad, navigateAndWaitFor, checkUrlAccessibility, and listener management.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NavigationTool } from '@/extension/tools/NavigationTool';
import type { BaseToolOptions } from '@/tools/BaseTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand to build options with a tabId in metadata */
function withTab(tabId: number): BaseToolOptions {
  return { metadata: { tabId } };
}

/** Creates a minimal chrome.tabs.Tab stub */
function makeTab(overrides: Partial<chrome.tabs.Tab> = {}): chrome.tabs.Tab {
  return {
    id: 1,
    index: 0,
    pinned: false,
    highlighted: false,
    windowId: 1,
    active: true,
    incognito: false,
    selected: false,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    url: 'https://example.com',
    title: 'Example',
    status: 'complete',
    ...overrides,
  } as chrome.tabs.Tab;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('NavigationTool', () => {
  let tool: NavigationTool;

  /**
   * The global `chrome` object is installed by the shared setup file
   * (src/__test-utils__/setup.ts) as a non-configurable property.
   * We extend it in-place here with the additional APIs that NavigationTool
   * requires (permissions, scripting, history, webNavigation, tabs.get, tabs.reload).
   */
  beforeEach(() => {
    const g = globalThis as any;
    const c = g.chrome;

    // Extend tabs with missing methods the setup file does not provide
    c.tabs.get = vi.fn().mockResolvedValue(makeTab());
    c.tabs.reload = vi.fn().mockResolvedValue(undefined);

    // Add permissions API
    c.permissions = {
      contains: vi.fn().mockResolvedValue(true),
    };

    // Add scripting API
    c.scripting = {
      executeScript: vi.fn().mockResolvedValue([{ result: undefined }]),
    };

    // Add history API
    c.history = {
      search: vi.fn().mockResolvedValue([]),
    };

    // Add webNavigation API
    c.webNavigation = {
      onBeforeNavigate: { addListener: vi.fn() },
      onCompleted: { addListener: vi.fn() },
      onErrorOccurred: { addListener: vi.fn() },
    };

    tool = new NavigationTool();
  });

  /** Convenience accessor for the chrome mock */
  function chromeMock() {
    return (globalThis as any).chrome;
  }

  // -----------------------------------------------------------------------
  // Tool Definition
  // -----------------------------------------------------------------------
  describe('Tool Definition', () => {
    it('should expose a function-type tool definition', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
    });

    it('should be named browser_navigation', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.function.name).toBe('browser_navigation');
      }
    });

    it('should declare action as a required parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        expect(def.function.parameters.required).toContain('action');
      }
    });

    it('should include navigation category metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect((def as any).category).toBe('navigation');
      }
    });

    it('should list expected capabilities in metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        const meta = (def as any).metadata;
        expect(meta.capabilities).toEqual(
          expect.arrayContaining(['page_navigation', 'history_management', 'load_monitoring'])
        );
      }
    });
  });

  // -----------------------------------------------------------------------
  // Parameter Validation (handled by BaseTool.execute -> validateParameters)
  // -----------------------------------------------------------------------
  describe('Parameter Validation', () => {
    it('should fail when required action parameter is missing', async () => {
      const result = await tool.execute({} as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('should fail when action is null', async () => {
      const result = await tool.execute({ action: null } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('should fail when action has wrong type (number)', async () => {
      const result = await tool.execute({ action: 123 } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should fail when url has wrong type (number)', async () => {
      const result = await tool.execute({ action: 'navigate', url: 999 } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('string');
    });

    it('should fail when options has wrong type (string)', async () => {
      const result = await tool.execute({ action: 'reload', options: 'bad' } as any, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('object');
    });

    it('should pass validation for a well-formed navigate request', async () => {
      const result = await tool.execute(
        { action: 'navigate', url: 'https://example.com' },
        withTab(1)
      );
      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Tab ID Validation
  // -----------------------------------------------------------------------
  describe('Tab ID Validation', () => {
    it('should fail when tabId is missing from options metadata', async () => {
      const result = await tool.execute({ action: 'getCurrentUrl' }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab ID not provided');
    });

    it('should fail when tabId is -1', async () => {
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(-1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Target tab cannot be found');
    });

    it('should fail when chrome.tabs.get rejects (tab does not exist)', async () => {
      chromeMock().tabs.get.mockRejectedValueOnce(new Error('No tab with id'));
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(999));
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found or inaccessible');
    });
  });

  // -----------------------------------------------------------------------
  // Navigate Action
  // -----------------------------------------------------------------------
  describe('navigate action', () => {
    it('should require a URL', async () => {
      const result = await tool.execute({ action: 'navigate' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('URL is required');
    });

    it('should call chrome.tabs.update with the provided URL', async () => {
      await tool.execute(
        { action: 'navigate', url: 'https://example.com/page' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.com/page' });
    });

    it('should prepend https:// when protocol is missing and input looks like a domain', async () => {
      await tool.execute(
        { action: 'navigate', url: 'example.com' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.com' });
    });

    it('should treat text without dots/protocol as a Google search query', async () => {
      await tool.execute(
        { action: 'navigate', url: 'funny cats' },
        withTab(1)
      );
      const calledUrl = chromeMock().tabs.update.mock.calls[0][1].url;
      expect(calledUrl).toContain('google.com/search');
      expect(calledUrl).toContain(encodeURIComponent('funny cats'));
    });

    it('should pass through chrome:// URLs unchanged', async () => {
      await tool.execute(
        { action: 'navigate', url: 'chrome://settings' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'chrome://settings' });
    });

    it('should pass through file:// URLs unchanged', async () => {
      await tool.execute(
        { action: 'navigate', url: 'file:///tmp/test.html' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'file:///tmp/test.html' });
    });

    it('should return a navigationId in the response', async () => {
      const result = await tool.execute(
        { action: 'navigate', url: 'https://example.com' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.navigationId).toMatch(/^nav_/);
    });

    it('should return status complete after waiting for load by default', async () => {
      const result = await tool.execute(
        { action: 'navigate', url: 'https://example.com' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.url).toBe('https://example.com');
      expect(result.data.title).toBe('Example');
    });

    it('should return status loading when waitForLoad is false', async () => {
      const result = await tool.execute(
        { action: 'navigate', url: 'https://example.com', options: { waitForLoad: false } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('loading');
    });

    it('should include loadTime when waitForLoad completes', async () => {
      const result = await tool.execute(
        { action: 'navigate', url: 'https://example.com' },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(typeof result.data.loadTime).toBe('number');
      expect(result.data.loadTime).toBeGreaterThanOrEqual(0);
    });

    it('should fail when chrome.tabs.update rejects', async () => {
      chromeMock().tabs.update.mockRejectedValueOnce(new Error('update failed'));
      const result = await tool.execute(
        { action: 'navigate', url: 'https://example.com' },
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Navigation failed');
    });
  });

  // -----------------------------------------------------------------------
  // Reload Action
  // -----------------------------------------------------------------------
  describe('reload action', () => {
    it('should call chrome.tabs.reload with the correct tabId', async () => {
      await tool.execute({ action: 'reload' }, withTab(1));
      expect(chromeMock().tabs.reload).toHaveBeenCalledWith(1, { bypassCache: false });
    });

    it('should pass bypassCache option to chrome.tabs.reload', async () => {
      await tool.execute(
        { action: 'reload', options: { bypassCache: true } },
        withTab(1)
      );
      expect(chromeMock().tabs.reload).toHaveBeenCalledWith(1, { bypassCache: true });
    });

    it('should return complete status after reload with waitForLoad (default)', async () => {
      const result = await tool.execute({ action: 'reload' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(typeof result.data.loadTime).toBe('number');
    });

    it('should return loading status when waitForLoad is false', async () => {
      const result = await tool.execute(
        { action: 'reload', options: { waitForLoad: false } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('loading');
    });

    it('should fail when chrome.tabs.reload rejects', async () => {
      chromeMock().tabs.reload.mockRejectedValueOnce(new Error('reload failed'));
      const result = await tool.execute({ action: 'reload' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Page reload failed');
    });
  });

  // -----------------------------------------------------------------------
  // goBack Action
  // -----------------------------------------------------------------------
  describe('goBack action', () => {
    it('should call chrome.scripting.executeScript to go back', async () => {
      await tool.execute({ action: 'goBack' }, withTab(1));
      expect(chromeMock().scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: 1 } })
      );
    });

    it('should return complete status and tab info when waiting for load', async () => {
      chromeMock().tabs.get.mockResolvedValue(
        makeTab({ url: 'https://previous.com', title: 'Previous' })
      );
      const result = await tool.execute({ action: 'goBack' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.url).toBe('https://previous.com');
      expect(result.data.title).toBe('Previous');
    });

    it('should return status complete without url/title when waitForLoad is false', async () => {
      const result = await tool.execute(
        { action: 'goBack', options: { waitForLoad: false } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      // When waitForLoad is false, url and title are not returned
      expect(result.data.url).toBeUndefined();
    });

    it('should fail when scripting.executeScript rejects', async () => {
      chromeMock().scripting.executeScript.mockRejectedValueOnce(new Error('cannot script'));
      const result = await tool.execute({ action: 'goBack' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Go back navigation failed');
    });
  });

  // -----------------------------------------------------------------------
  // goForward Action
  // -----------------------------------------------------------------------
  describe('goForward action', () => {
    it('should call chrome.scripting.executeScript to go forward', async () => {
      await tool.execute({ action: 'goForward' }, withTab(1));
      expect(chromeMock().scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: 1 } })
      );
    });

    it('should return complete status with url/title when waiting for load', async () => {
      chromeMock().tabs.get.mockResolvedValue(
        makeTab({ url: 'https://next.com', title: 'Next Page' })
      );
      const result = await tool.execute({ action: 'goForward' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.url).toBe('https://next.com');
      expect(result.data.title).toBe('Next Page');
    });

    it('should return status complete without url/title when waitForLoad is false', async () => {
      const result = await tool.execute(
        { action: 'goForward', options: { waitForLoad: false } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(result.data.url).toBeUndefined();
    });

    it('should fail when scripting.executeScript rejects', async () => {
      chromeMock().scripting.executeScript.mockRejectedValueOnce(new Error('no forward'));
      const result = await tool.execute({ action: 'goForward' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Go forward navigation failed');
    });
  });

  // -----------------------------------------------------------------------
  // getHistory Action
  // -----------------------------------------------------------------------
  describe('getHistory action', () => {
    it('should call chrome.history.search and return mapped entries', async () => {
      chromeMock().history.search.mockResolvedValueOnce([
        { url: 'https://a.com', title: 'A', lastVisitTime: 1000, id: '1' },
        { url: 'https://b.com', title: 'B', lastVisitTime: 2000, id: '2' },
      ]);

      const result = await tool.execute({ action: 'getHistory' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.history).toHaveLength(2);
      expect(result.data.history[0]).toEqual({
        url: 'https://a.com',
        title: 'A',
        visitTime: 1000,
        visitId: '1',
      });
      expect(result.data.history[1]).toEqual({
        url: 'https://b.com',
        title: 'B',
        visitTime: 2000,
        visitId: '2',
      });
    });

    it('should return empty history array when no items', async () => {
      chromeMock().history.search.mockResolvedValueOnce([]);
      const result = await tool.execute({ action: 'getHistory' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.history).toEqual([]);
    });

    it('should handle missing url/title in history items gracefully', async () => {
      chromeMock().history.search.mockResolvedValueOnce([
        { id: '1' }, // no url, title, lastVisitTime
      ]);
      const result = await tool.execute({ action: 'getHistory' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.history[0]).toEqual({
        url: '',
        title: '',
        visitTime: 0,
        visitId: '1',
      });
    });

    it('should fail when chrome.history.search rejects', async () => {
      chromeMock().history.search.mockRejectedValueOnce(new Error('no history permission'));
      const result = await tool.execute({ action: 'getHistory' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to get history');
    });

    it('should validate history permission', async () => {
      // First call for tabs permission succeeds; second for history fails.
      chromeMock().permissions.contains
        .mockResolvedValueOnce(true)   // tabs
        .mockResolvedValueOnce(false); // history
      const result = await tool.execute({ action: 'getHistory' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required permissions');
    });
  });

  // -----------------------------------------------------------------------
  // stop Action
  // -----------------------------------------------------------------------
  describe('stop action', () => {
    it('should call scripting.executeScript to stop navigation', async () => {
      const result = await tool.execute({ action: 'stop' }, withTab(1));
      expect(result.success).toBe(true);
      expect(chromeMock().scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({ target: { tabId: 1 } })
      );
    });

    it('should return url, title, and complete status', async () => {
      chromeMock().tabs.get.mockResolvedValue(
        makeTab({ url: 'https://stopped.com', title: 'Stopped' })
      );
      const result = await tool.execute({ action: 'stop' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.url).toBe('https://stopped.com');
      expect(result.data.title).toBe('Stopped');
      expect(result.data.status).toBe('complete');
    });

    it('should fail when scripting.executeScript rejects', async () => {
      chromeMock().scripting.executeScript.mockRejectedValueOnce(new Error('stop failed'));
      const result = await tool.execute({ action: 'stop' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to stop navigation');
    });
  });

  // -----------------------------------------------------------------------
  // getCurrentUrl Action
  // -----------------------------------------------------------------------
  describe('getCurrentUrl action', () => {
    it('should return url, title, and status from the tab', async () => {
      chromeMock().tabs.get.mockResolvedValue(
        makeTab({ url: 'https://current.com', title: 'Current Page', status: 'complete' })
      );
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.url).toBe('https://current.com');
      expect(result.data.title).toBe('Current Page');
      expect(result.data.status).toBe('complete');
    });

    it('should return loading status when tab is loading', async () => {
      chromeMock().tabs.get.mockResolvedValue(makeTab({ status: 'loading' }));
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('loading');
    });

    it('should default to empty strings when tab has no url/title', async () => {
      chromeMock().tabs.get.mockResolvedValue(
        makeTab({ url: undefined, title: undefined })
      );
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.url).toBe('');
      expect(result.data.title).toBe('');
    });

    it('should fail when chrome.tabs.get rejects inside getCurrentUrl', async () => {
      // First call succeeds (tab validation in executeImpl), second fails inside getCurrentUrl
      chromeMock().tabs.get
        .mockResolvedValueOnce(makeTab()) // validation
        .mockRejectedValueOnce(new Error('tab gone'));
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to get current URL');
    });
  });

  // -----------------------------------------------------------------------
  // waitForLoad Action
  // -----------------------------------------------------------------------
  describe('waitForLoad action', () => {
    it('should return complete status when tab is already loaded', async () => {
      const result = await tool.execute({ action: 'waitForLoad' }, withTab(1));
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
      expect(typeof result.data.loadTime).toBe('number');
    });

    it('should use loadEventTimeout from options', async () => {
      // Tab is already complete, so this should return immediately regardless of timeout
      const result = await tool.execute(
        { action: 'waitForLoad', options: { loadEventTimeout: 500 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
    });

    it('should poll until tab status becomes complete', async () => {
      // First call is tab validation in executeImpl, remaining are in waitForTabToLoad + final get
      chromeMock().tabs.get
        .mockResolvedValueOnce(makeTab())                       // validation
        .mockResolvedValueOnce(makeTab({ status: 'loading' }))  // poll 1
        .mockResolvedValueOnce(makeTab({ status: 'loading' }))  // poll 2
        .mockResolvedValueOnce(makeTab({ status: 'complete' })) // poll 3 - exits loop
        .mockResolvedValue(makeTab({ status: 'complete' }));    // final get

      const result = await tool.execute(
        { action: 'waitForLoad', options: { loadEventTimeout: 5000 } },
        withTab(1)
      );
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('complete');
    });
  });

  // -----------------------------------------------------------------------
  // Timeout Handling
  // -----------------------------------------------------------------------
  describe('Timeout Handling', () => {
    it('should return error status with NAVIGATION_TIMEOUT when navigation times out', async () => {
      // Tab never finishes loading (except the initial validation call)
      chromeMock().tabs.get
        .mockResolvedValueOnce(makeTab())                       // validation in executeImpl
        .mockResolvedValue(makeTab({ status: 'loading' }));     // all subsequent polls

      const result = await tool.execute(
        { action: 'navigate', url: 'https://slow.com', options: { timeout: 200 } },
        withTab(1)
      );

      // waitForNavigationComplete catches the timeout and returns error status
      // rather than throwing, so execute still wraps it as success: true
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('error');
      expect(result.data.error).toBeDefined();
      expect(result.data.error.code).toBe('NAVIGATION_TIMEOUT');
      expect(result.data.error.message).toContain('timed out');
      expect(result.data.error.url).toBe('https://slow.com');
    });

    it('should fail waitForLoad when tab never completes loading within timeout', async () => {
      // Validation succeeds, but all subsequent polls return loading
      chromeMock().tabs.get
        .mockResolvedValueOnce(makeTab())                   // validation
        .mockResolvedValue(makeTab({ status: 'loading' })); // polls in waitForTabToLoad

      const result = await tool.execute(
        { action: 'waitForLoad', options: { loadEventTimeout: 200 } },
        withTab(1)
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Wait for load failed');
    });

    it('should fail reload when tab never finishes loading within timeout', async () => {
      // All gets return loading so waitForNavigationComplete times out
      chromeMock().tabs.get.mockResolvedValue(makeTab({ status: 'loading' }));

      const result = await tool.execute(
        { action: 'reload', options: { timeout: 200 } },
        withTab(1)
      );

      // reloadPage's waitForNavigationComplete catches the timeout internally
      // and returns error status instead of throwing
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('error');
      expect(result.data.error.code).toBe('NAVIGATION_TIMEOUT');
    });
  });

  // -----------------------------------------------------------------------
  // Unsupported Action
  // -----------------------------------------------------------------------
  describe('Unsupported Action', () => {
    it('should fail for an unknown action string', async () => {
      const result = await tool.execute(
        { action: 'flyToMoon' } as any,
        withTab(1)
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported navigation action');
    });
  });

  // -----------------------------------------------------------------------
  // URL Validation & Normalization
  // -----------------------------------------------------------------------
  describe('URL Validation and Normalization', () => {
    it('should keep http:// URLs as-is', async () => {
      await tool.execute(
        { action: 'navigate', url: 'http://insecure.com' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'http://insecure.com' });
    });

    it('should keep https:// URLs as-is', async () => {
      await tool.execute(
        { action: 'navigate', url: 'https://secure.com/path?q=1' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'https://secure.com/path?q=1' });
    });

    it('should add https:// to bare domains', async () => {
      await tool.execute(
        { action: 'navigate', url: 'www.example.org' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'https://www.example.org' });
    });

    it('should convert plain text without dots to a Google search', async () => {
      await tool.execute(
        { action: 'navigate', url: 'vitest tutorial' },
        withTab(1)
      );
      const url = chromeMock().tabs.update.mock.calls[0][1].url;
      expect(url).toContain('google.com/search');
      expect(url).toContain(encodeURIComponent('vitest tutorial'));
    });

    it('should convert text with spaces (even with dots) to a Google search', async () => {
      await tool.execute(
        { action: 'navigate', url: 'how to use file.txt' },
        withTab(1)
      );
      const url = chromeMock().tabs.update.mock.calls[0][1].url;
      expect(url).toContain('google.com/search');
    });

    it('should handle domain with path correctly', async () => {
      await tool.execute(
        { action: 'navigate', url: 'example.com/path/to/page' },
        withTab(1)
      );
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.com/path/to/page' });
    });
  });

  // -----------------------------------------------------------------------
  // Navigation Listeners
  // -----------------------------------------------------------------------
  describe('Navigation Listener Management', () => {
    it('should register a navigation listener for a tab', () => {
      const callback = vi.fn();
      tool.addNavigationListener(42, callback);
      // No error thrown; callback is not called until an event fires
      expect(callback).not.toHaveBeenCalled();
    });

    it('should remove a navigation listener', () => {
      const callback = vi.fn();
      tool.addNavigationListener(42, callback);
      tool.removeNavigationListener(42);
      expect(callback).not.toHaveBeenCalled();
    });

    it('should setup webNavigation listeners during construction', () => {
      expect(chromeMock().webNavigation.onBeforeNavigate.addListener).toHaveBeenCalledTimes(1);
      expect(chromeMock().webNavigation.onCompleted.addListener).toHaveBeenCalledTimes(1);
      expect(chromeMock().webNavigation.onErrorOccurred.addListener).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // navigateAndWaitFor (public method)
  // -----------------------------------------------------------------------
  describe('navigateAndWaitFor', () => {
    it('should navigate and resolve when condition becomes true', async () => {
      let callCount = 0;
      chromeMock().tabs.get.mockImplementation(async () => {
        callCount++;
        if (callCount >= 2) {
          return makeTab({ url: 'https://dest.com', title: 'Destination', status: 'complete' });
        }
        return makeTab({ status: 'loading' });
      });

      const condition = (tab: chrome.tabs.Tab) => tab.status === 'complete';
      const result = await tool.navigateAndWaitFor(1, 'https://dest.com', condition, 5000);
      expect(result.status).toBe('complete');
      expect(result.url).toBe('https://dest.com');
      expect(typeof result.loadTime).toBe('number');
      expect(chromeMock().tabs.update).toHaveBeenCalledWith(1, { url: 'https://dest.com' });
    });

    it('should throw when condition is never met within timeout', async () => {
      chromeMock().tabs.get.mockResolvedValue(makeTab({ status: 'loading' }));
      const neverTrue = () => false;

      await expect(
        tool.navigateAndWaitFor(1, 'https://dest.com', neverTrue, 300)
      ).rejects.toThrow('Navigation condition not met within 300ms');
    });
  });

  // -----------------------------------------------------------------------
  // checkUrlAccessibility (public method)
  // -----------------------------------------------------------------------
  describe('checkUrlAccessibility', () => {
    it('should return accessible: true for a 200 OK response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        status: 200,
      });

      const result = await tool.checkUrlAccessibility('https://example.com');
      expect(result.accessible).toBe(true);
      expect(result.status).toBe(200);
      expect(result.error).toBeUndefined();
    });

    it('should return accessible: false for a 404 response', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await tool.checkUrlAccessibility('https://example.com/missing');
      expect(result.accessible).toBe(false);
      expect(result.status).toBe(404);
    });

    it('should return accessible: false with error message on fetch failure', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DNS lookup failed'));

      const result = await tool.checkUrlAccessibility('https://doesnotexist.invalid');
      expect(result.accessible).toBe(false);
      expect(result.error).toBe('DNS lookup failed');
      expect(result.status).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getNavigationMetrics (public method)
  // -----------------------------------------------------------------------
  describe('getNavigationMetrics', () => {
    it('should return the result from scripting.executeScript', async () => {
      const metrics = {
        loadTime: 100,
        domContentLoaded: 50,
        responseTime: 30,
        redirectCount: 0,
        type: 'navigate',
      };
      chromeMock().scripting.executeScript.mockResolvedValueOnce([{ result: metrics }]);

      const result = await tool.getNavigationMetrics(1);
      expect(result).toEqual(metrics);
    });

    it('should return null when scripting.executeScript fails', async () => {
      chromeMock().scripting.executeScript.mockRejectedValueOnce(new Error('no access'));

      const result = await tool.getNavigationMetrics(1);
      expect(result).toBeNull();
    });

    it('should return undefined when script result array is empty', async () => {
      chromeMock().scripting.executeScript.mockResolvedValueOnce([]);

      const result = await tool.getNavigationMetrics(1);
      expect(result).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Permissions Validation
  // -----------------------------------------------------------------------
  describe('Permissions Validation', () => {
    it('should fail when tabs permission is not granted', async () => {
      chromeMock().permissions.contains.mockResolvedValueOnce(false);
      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(1));
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required permissions');
    });

    it('should proceed when chrome.permissions is undefined (no permission API)', async () => {
      // Remove the permissions API entirely
      delete (globalThis as any).chrome.permissions;

      const result = await tool.execute({ action: 'getCurrentUrl' }, withTab(1));
      expect(result.success).toBe(true);
    });
  });
});
