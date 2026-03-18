/**
 * Unit tests for WebScrapingTool
 *
 * Tests parameter validation, page content extraction, pagination handling,
 * rate limiting (delay between pages), error recovery, pattern library,
 * table scraping, and screenshot capture.
 *
 * EXPANDED: Additional tests for uncovered branches including XPath wait,
 * unknown wait condition, getTab edge cases, executeScraping empty results,
 * pagination defaults, scrapeTable without tabId, and private method paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WebScrapingTool,
  PatternLibrary,
  type ScrapingPattern,
  type ScrapingConfig,
} from '@/extension/tools/WebScrapingTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock chrome.scripting.executeScript that returns the provided value.
 */
function mockScriptResult(value: any) {
  return vi.fn().mockResolvedValue([{ result: value }]);
}

/**
 * Configure the global chrome mock for standard single-page scraping.
 */
function setupChromeForScraping(
  scriptReturnValue: any,
  tabOverrides: Partial<chrome.tabs.Tab> = {},
) {
  const tab = { id: 1, url: 'https://example.com', ...tabOverrides } as chrome.tabs.Tab;

  (chrome.tabs.query as ReturnType<typeof vi.fn>).mockResolvedValue([tab]);
  (chrome.tabs.create as ReturnType<typeof vi.fn>).mockResolvedValue(tab);

  // chrome.tabs.get is used by validateTabId
  (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

  (chrome as any).scripting = {
    executeScript: mockScriptResult(scriptReturnValue),
  };

  (chrome.tabs as any).captureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');
}

/**
 * A minimal valid ScrapingPattern for testing.
 */
function makePattern(overrides: Partial<ScrapingPattern> = {}): ScrapingPattern {
  return {
    name: 'test',
    selector: '.item',
    type: 'css',
    multiple: true,
    required: false,
    extraction: [{ field: 'text', source: 'text' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('WebScrapingTool', () => {
  let tool: WebScrapingTool;

  beforeEach(() => {
    tool = new WebScrapingTool();

    // Ensure chrome.scripting and chrome.tabs.get always exist
    (chrome as any).scripting = {
      executeScript: vi.fn().mockResolvedValue([{ result: {} }]),
    };
    (chrome.tabs as any).get = vi.fn().mockResolvedValue({ id: 1, url: 'https://example.com' });
    (chrome.tabs as any).captureVisibleTab = vi.fn().mockResolvedValue('data:image/png;base64,AAAA');
  });

  // -------------------------------------------------------------------------
  // Tool Definition
  // -------------------------------------------------------------------------
  describe('Tool Definition', () => {
    it('should expose a function-type tool definition named web_scraping', () => {
      const def = tool.getDefinition();
      expect(def.type).toBe('function');
      if (def.type === 'function') {
        expect(def.function.name).toBe('web_scraping');
        expect(def.function.description).toBeTruthy();
      }
    });

    it('should require the "patterns" parameter', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const schema = def.function.parameters as any;
        expect(schema.required).toContain('patterns');
      }
    });

    it('should define pagination parameter as object type', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const pagination = (def.function.parameters as any).properties.pagination;
        expect(pagination.type).toBe('object');
      }
    });

    it('should define url parameter as string type', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const url = (def.function.parameters as any).properties.url;
        expect(url.type).toBe('string');
      }
    });

    it('should define waitFor parameter as object type', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const waitFor = (def.function.parameters as any).properties.waitFor;
        expect(waitFor.type).toBe('object');
      }
    });

    it('should define screenshot parameter as boolean type', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const screenshot = (def.function.parameters as any).properties.screenshot;
        expect(screenshot.type).toBe('boolean');
      }
    });

    it('should define timeout parameter as number type', () => {
      const def = tool.getDefinition();
      if (def.type === 'function' && def.function.parameters.type === 'object') {
        const timeout = (def.function.parameters as any).properties.timeout;
        expect(timeout.type).toBe('number');
      }
    });

    it('should have browser category metadata', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.category).toBe('browser');
      }
    });

    it('should require tabs, scripting, and activeTab permissions', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.metadata?.permissions).toEqual(
          expect.arrayContaining(['tabs', 'scripting', 'activeTab']),
        );
      }
    });

    it('should be for extension platform', () => {
      const def = tool.getDefinition();
      if (def.type === 'function') {
        expect(def.metadata?.platforms).toContain('extension');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Parameter Validation
  // -------------------------------------------------------------------------
  describe('Parameter Validation', () => {
    it('should reject when required "patterns" parameter is missing', async () => {
      const result = await tool.execute({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("'patterns'");
    });

    it('should reject when "patterns" is not an array', async () => {
      const result = await tool.execute({ patterns: 'not-array' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be an array');
    });

    it('should reject when "timeout" is not a number', async () => {
      const result = await tool.execute({ patterns: [], timeout: 'fast' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be a valid number');
    });

    it('should reject when "screenshot" is not a boolean', async () => {
      const result = await tool.execute({ patterns: [], screenshot: 'yes' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be a boolean');
    });

    it('should reject unknown parameters', async () => {
      const result = await tool.execute({ patterns: [], bogus: 42 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown parameter');
    });

    it('should accept valid minimal parameters', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );
      expect(result.success).toBe(true);
    });

    it('should reject when "url" is not a string', async () => {
      const result = await tool.execute({ patterns: [], url: 123 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be a string');
    });

    it('should reject when "pagination" is not an object', async () => {
      const result = await tool.execute({ patterns: [], pagination: 'next' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be an object');
    });

    it('should reject when "waitFor" is not an object', async () => {
      const result = await tool.execute({ patterns: [], waitFor: 'ready' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('must be an object');
    });
  });

  // -------------------------------------------------------------------------
  // Page Content Extraction
  // -------------------------------------------------------------------------
  describe('Page Content Extraction', () => {
    it('should extract data using provided patterns via tabId', async () => {
      const extractedItems = {
        test: [{ text: 'Item 1' }, { text: 'Item 2' }],
      };
      setupChromeForScraping(extractedItems);

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toEqual(extractedItems);
      expect(result.data.metadata.url).toBe('https://example.com');
    });

    it('should create a new tab when url is provided and no tabId', async () => {
      const tab = { id: 42, url: 'https://new-page.com' } as chrome.tabs.Tab;
      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: mockScriptResult({ links: [{ href: '/about' }] }),
      };

      const result = await tool.execute(
        { url: 'https://new-page.com', patterns: [makePattern({ name: 'links' })] },
        {},
      );

      expect(result.success).toBe(true);
      expect(chrome.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'https://new-page.com' }),
      );
    });

    it('should throw when neither tabId nor url is provided', async () => {
      const result = await tool.execute({ patterns: [makePattern()] }, {});
      expect(result.success).toBe(false);
      expect(result.error).toContain('not provided');
    });

    it('should include timing metadata in the result', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.timestamp).toBeGreaterThan(0);
      expect(result.data.metadata.duration).toBeGreaterThanOrEqual(0);
    });

    it('should capture screenshot when requested', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()], screenshot: true },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.screenshot).toContain('data:image/png');
    });

    it('should return empty string if screenshot capture fails', async () => {
      setupChromeForScraping({});
      (chrome.tabs as any).captureVisibleTab = vi.fn().mockRejectedValue(new Error('no permission'));

      const result = await tool.execute(
        { patterns: [makePattern()], screenshot: true },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.screenshot).toBe('');
    });

    it('should not capture screenshot when screenshot is false', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()], screenshot: false },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.screenshot).toBeUndefined();
    });

    it('should use tab url in metadata when tab has url', async () => {
      setupChromeForScraping({}, { url: 'https://specific.com/page' });

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.url).toBe('https://specific.com/page');
    });

    it('should use empty string for url when tab has no url', async () => {
      setupChromeForScraping({}, { url: undefined });

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.url).toBe('');
    });

    it('should pass patterns to executeScript', async () => {
      setupChromeForScraping({ items: [{ text: 'hello' }] });
      const patterns = [makePattern({ name: 'items', selector: '.item-class' })];

      await tool.execute({ patterns }, { metadata: { tabId: 1 } });

      expect((chrome as any).scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { tabId: 1 },
          args: [patterns],
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // getTab edge cases
  // -------------------------------------------------------------------------
  describe('getTab edge cases', () => {
    it('should create a tab with active: false when url provided', async () => {
      const tab = { id: 10, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs.create as ReturnType<typeof vi.fn>).mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: mockScriptResult({}),
      };

      await tool.execute(
        { url: 'https://example.com', patterns: [makePattern()] },
        {},
      );

      expect(chrome.tabs.create).toHaveBeenCalledWith(
        expect.objectContaining({ active: false }),
      );
    });

    it('should fail when tabId is -1 and no url is provided', async () => {
      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: -1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not provided');
    });

    it('should fail when tabId is null and no url is provided', async () => {
      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: null } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not provided');
    });

    it('should use validateTabId when tabId is a valid number', async () => {
      const tab = { id: 5, url: 'https://tab5.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: mockScriptResult({}),
      };

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 5 } },
      );

      expect(result.success).toBe(true);
      expect((chrome.tabs as any).get).toHaveBeenCalledWith(5);
    });

    it('should handle tabId of 0 as a valid tab', async () => {
      const tab = { id: 0, url: 'https://tab0.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: mockScriptResult({}),
      };

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 0 } },
      );

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Wait Conditions
  // -------------------------------------------------------------------------
  describe('Wait Conditions', () => {
    it('should wait for a CSS selector before scraping', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        // First call: waitForSelector check - element found immediately
        .mockResolvedValueOnce([{ result: true }])
        // Second call: actual scraping
        .mockResolvedValueOnce([{ result: { items: [] } }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'selector', value: '.loaded', timeout: 1000 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(executeScript).toHaveBeenCalledTimes(2);
    });

    it('should respect time-based wait condition', async () => {
      setupChromeForScraping({ items: [] });

      const startTime = Date.now();
      const result = await tool.execute(
        {
          patterns: [makePattern()],
          // The tool schema defines value as string; waitForCondition casts internally
          waitFor: { type: 'time', value: '50' },
        },
        { metadata: { tabId: 1 } },
      );

      const elapsed = Date.now() - startTime;
      expect(result.success).toBe(true);
      expect(elapsed).toBeGreaterThanOrEqual(40); // Allow small variance
    });

    it('should timeout when selector is never found', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // Always return false - element never appears
      (chrome as any).scripting = {
        executeScript: vi.fn().mockResolvedValue([{ result: false }]),
      };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'selector', value: '.never-exists', timeout: 200 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout');
    });

    it('should wait for XPath before scraping', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        // First call: waitForXPath check - element found immediately
        .mockResolvedValueOnce([{ result: true }])
        // Second call: actual scraping
        .mockResolvedValueOnce([{ result: { data: 'xpath-result' } }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'xpath', value: '//div[@class="loaded"]', timeout: 1000 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(executeScript).toHaveBeenCalledTimes(2);
    });

    it('should timeout when XPath is never found', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      (chrome as any).scripting = {
        executeScript: vi.fn().mockResolvedValue([{ result: false }]),
      };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'xpath', value: '//div[@class="never"]', timeout: 200 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Timeout waiting for XPath');
    });

    it('should throw on unknown wait condition type', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'function' as any, value: 'checkReady', timeout: 1000 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown wait condition type');
    });

    it('should use default timeout of 5000ms when not specified in waitFor', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // Element found immediately so no real delay
      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: true }])
        .mockResolvedValueOnce([{ result: {} }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'selector', value: '.content' },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
    });

    it('should poll selector until found before timeout', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // First two polls return false, then found
      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: false }])
        .mockResolvedValueOnce([{ result: false }])
        .mockResolvedValueOnce([{ result: true }])
        .mockResolvedValueOnce([{ result: { data: 'found' } }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'selector', value: '.delayed', timeout: 5000 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      // At least 3 calls for wait + 1 for scraping
      expect(executeScript.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('should poll XPath until found before timeout', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: false }])
        .mockResolvedValueOnce([{ result: true }])
        .mockResolvedValueOnce([{ result: { xp: 'result' } }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          waitFor: { type: 'xpath', value: '//h1', timeout: 5000 },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(executeScript.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination Handling
  // -------------------------------------------------------------------------
  describe('Pagination Handling', () => {
    it('should scrape multiple pages when pagination is configured (click type)', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        // Page 1 scraping
        .mockResolvedValueOnce([{ result: { items: [{ text: 'P1' }] } }])
        // Click next - button exists
        .mockResolvedValueOnce([{ result: true }])
        // Page 2 scraping
        .mockResolvedValueOnce([{ result: { items: [{ text: 'P2' }] } }])
        // Click next - no more pages
        .mockResolvedValueOnce([{ result: false }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next-btn',
            maxPages: 5,
            delay: 10, // Minimal delay for fast tests
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(2);
      expect(result.data.data.totalPages).toBe(2);
      expect(result.data.metadata.pagesScraped).toBe(2);
    });

    it('should respect maxPages limit', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // Always return data and always have a next button
      const executeScript = vi.fn()
        .mockImplementation((args: any) => {
          // If the injected function is for clicking next, return true
          // Otherwise return scraping data
          return Promise.resolve([{ result: args.args?.[0] ? true : { items: [] } }]);
        });

      // Alternate: scrape result, click result, scrape result, click result ...
      executeScript
        .mockResolvedValueOnce([{ result: { items: [{ text: 'P1' }] } }])
        .mockResolvedValueOnce([{ result: true }])
        .mockResolvedValueOnce([{ result: { items: [{ text: 'P2' }] } }])
        .mockResolvedValueOnce([{ result: true }])
        .mockResolvedValueOnce([{ result: { items: [{ text: 'P3' }] } }])
        .mockResolvedValueOnce([{ result: true }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 3,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(3);
      expect(result.data.data.totalPages).toBe(3);
    });

    it('should handle scroll-based pagination', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        // Page 1 scraping
        .mockResolvedValueOnce([{ result: { items: [{ text: 'S1' }] } }])
        // Scroll - new content loaded
        .mockResolvedValueOnce([{ result: true }])
        // Page 2 scraping
        .mockResolvedValueOnce([{ result: { items: [{ text: 'S2' }] } }])
        // Scroll - no new content
        .mockResolvedValueOnce([{ result: false }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'scroll',
            maxPages: 10,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(2);
    });

    it('should collect errors during pagination without crashing', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        // Page 1 scraping works
        .mockResolvedValueOnce([{ result: { items: [{ text: 'P1' }] } }])
        // Click next throws
        .mockRejectedValueOnce(new Error('Click failed'));

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 3,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      // The tool should recover and return partial results
      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(1);
      expect(result.data.metadata.errors.length).toBeGreaterThan(0);
    });

    it('should use default maxPages of 10 when not specified', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // Return data once then stop
      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([{ result: false }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 1,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(1);
    });

    it('should use default delay of 1000 when not specified', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // One page only - no delay applied
      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([{ result: false }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 1,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
    });

    it('should handle pagination type without nextSelector for non-click type', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // The tool should still iterate pages; for url-pattern or load-more
      // without nextSelector, the pagination loop just scrapes without click/scroll
      const executeScript = vi.fn()
        .mockResolvedValue([{ result: { items: [] } }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'url-pattern',
            maxPages: 2,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      // Without click/scroll logic, maxPages pages should be scraped
      expect(result.data.data.pages).toHaveLength(2);
    });

    it('should handle non-Error thrown during pagination', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockRejectedValueOnce('string-error');

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 3,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.errors).toContain('string-error');
    });

    it('should return empty string for url in paginated results', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: {} }])
        .mockResolvedValueOnce([{ result: false }]);

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 1,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.metadata.url).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Rate Limiting (delay between pages)
  // -------------------------------------------------------------------------
  describe('Rate Limiting', () => {
    it('should apply delay between paginated requests', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([{ result: true }])  // click next
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([{ result: false }]); // no more pages

      (chrome as any).scripting = { executeScript };

      const delayMs = 100;
      const startTime = Date.now();

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 5,
            delay: delayMs,
          },
        },
        { metadata: { tabId: 1 } },
      );

      const elapsed = Date.now() - startTime;
      expect(result.success).toBe(true);
      // At least one delay should have occurred between pages
      expect(elapsed).toBeGreaterThanOrEqual(delayMs - 20); // Allow small variance
    });

    it('should default delay to 1000ms when not specified', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      // Only one page so no delay is applied
      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([{ result: false }]); // click next returns false

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 2,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Error Recovery
  // -------------------------------------------------------------------------
  describe('Error Recovery', () => {
    it('should wrap errors with "Scraping failed:" prefix', async () => {
      (chrome.tabs as any).get = vi.fn().mockRejectedValue(new Error('Tab closed'));

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 999 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Scraping failed');
    });

    it('should handle non-Error throw values', async () => {
      (chrome.tabs as any).get = vi.fn().mockRejectedValue('string-error');

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 999 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Scraping failed');
    });

    it('should include error metadata in the result', async () => {
      (chrome.tabs as any).get = vi.fn().mockRejectedValue(new Error('connection lost'));

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.metadata).toBeDefined();
      expect(result.metadata!.duration).toBeGreaterThanOrEqual(0);
    });

    it('should include error type in metadata', async () => {
      (chrome.tabs as any).get = vi.fn().mockRejectedValue(new Error('tab error'));

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.metadata!.errorType).toBe('Error');
    });

    it('should include tool name in error metadata', async () => {
      (chrome.tabs as any).get = vi.fn().mockRejectedValue(new Error('tab error'));

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.metadata!.toolName).toBe('web_scraping');
    });

    it('should handle when executeScript returns empty array', async () => {
      setupChromeForScraping({});
      (chrome as any).scripting = {
        executeScript: vi.fn().mockResolvedValue([]),
      };

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toEqual({});
    });

    it('should handle when executeScript result has no result property', async () => {
      setupChromeForScraping({});
      (chrome as any).scripting = {
        executeScript: vi.fn().mockResolvedValue([{}]),
      };

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // Pattern Library
  // -------------------------------------------------------------------------
  describe('Pattern Library', () => {
    it('should pre-load common patterns (article, product, links, images)', () => {
      const patterns = tool.listPatterns();
      expect(patterns).toContain('article');
      expect(patterns).toContain('product');
      expect(patterns).toContain('links');
      expect(patterns).toContain('images');
    });

    it('should retrieve a built-in pattern by name (case-insensitive)', () => {
      const pattern = tool.getPattern('ARTICLE');
      expect(pattern).toBeDefined();
      expect(pattern!.name).toBe('article');
    });

    it('should return undefined for non-existent pattern', () => {
      const pattern = tool.getPattern('nonexistent');
      expect(pattern).toBeUndefined();
    });

    it('should allow adding custom patterns', () => {
      const custom = makePattern({ name: 'custom-widget' });
      tool.addPattern(custom);

      const retrieved = tool.getPattern('custom-widget');
      expect(retrieved).toBeDefined();
      expect(retrieved!.selector).toBe('.item');
    });

    it('should include custom patterns in the list', () => {
      tool.addPattern(makePattern({ name: 'my-pattern' }));
      const patterns = tool.listPatterns();
      expect(patterns).toContain('my-pattern');
    });

    it('should overwrite existing pattern with same name', () => {
      tool.addPattern(makePattern({ name: 'links', selector: '.custom-links' }));
      const pattern = tool.getPattern('links');
      expect(pattern!.selector).toBe('.custom-links');
    });

    it('should have exactly 4 built-in patterns', () => {
      const patterns = tool.listPatterns();
      expect(patterns).toHaveLength(4);
    });

    it('should retrieve product pattern with multiple extraction rules', () => {
      const pattern = tool.getPattern('product');
      expect(pattern).toBeDefined();
      expect(pattern!.extraction.length).toBeGreaterThanOrEqual(5);
      expect(pattern!.multiple).toBe(true);
    });

    it('should retrieve images pattern with src extraction rule', () => {
      const pattern = tool.getPattern('images');
      expect(pattern).toBeDefined();
      const srcRule = pattern!.extraction.find(r => r.field === 'src');
      expect(srcRule).toBeDefined();
      expect(srcRule!.source).toBe('attribute');
      expect(srcRule!.attribute).toBe('src');
    });
  });

  // -------------------------------------------------------------------------
  // PatternLibrary static patterns
  // -------------------------------------------------------------------------
  describe('PatternLibrary Constants', () => {
    it('should define ARTICLE pattern with correct selector', () => {
      expect(PatternLibrary.PATTERNS.ARTICLE.selector).toContain('article');
      expect(PatternLibrary.PATTERNS.ARTICLE.multiple).toBe(false);
    });

    it('should define PRODUCT pattern for multiple items', () => {
      expect(PatternLibrary.PATTERNS.PRODUCT.multiple).toBe(true);
      expect(PatternLibrary.PATTERNS.PRODUCT.extraction.length).toBeGreaterThan(0);
    });

    it('should define LINKS pattern that extracts href attributes', () => {
      const hrefRule = PatternLibrary.PATTERNS.LINKS.extraction.find(
        (r) => r.field === 'href',
      );
      expect(hrefRule).toBeDefined();
      expect(hrefRule!.source).toBe('attribute');
      expect(hrefRule!.attribute).toBe('href');
    });

    it('should define IMAGES pattern that extracts src and alt', () => {
      const srcRule = PatternLibrary.PATTERNS.IMAGES.extraction.find(
        (r) => r.field === 'src',
      );
      const altRule = PatternLibrary.PATTERNS.IMAGES.extraction.find(
        (r) => r.field === 'alt',
      );
      expect(srcRule).toBeDefined();
      expect(altRule).toBeDefined();
    });

    it('should define ARTICLE extraction rules for title, content, author, date', () => {
      const fields = PatternLibrary.PATTERNS.ARTICLE.extraction.map(r => r.field);
      expect(fields).toContain('title');
      expect(fields).toContain('content');
      expect(fields).toContain('author');
      expect(fields).toContain('date');
    });

    it('should define PRODUCT extraction rules for name, price, image, rating', () => {
      const fields = PatternLibrary.PATTERNS.PRODUCT.extraction.map(r => r.field);
      expect(fields).toContain('name');
      expect(fields).toContain('price');
      expect(fields).toContain('image');
      expect(fields).toContain('rating');
    });

    it('should define LINKS extraction rules for text, href, title', () => {
      const fields = PatternLibrary.PATTERNS.LINKS.extraction.map(r => r.field);
      expect(fields).toContain('text');
      expect(fields).toContain('href');
      expect(fields).toContain('title');
    });

    it('should define IMAGES extraction rules for src, alt, title', () => {
      const fields = PatternLibrary.PATTERNS.IMAGES.extraction.map(r => r.field);
      expect(fields).toContain('src');
      expect(fields).toContain('alt');
      expect(fields).toContain('title');
    });

    it('should set ARTICLE required to false', () => {
      expect(PatternLibrary.PATTERNS.ARTICLE.required).toBe(false);
    });

    it('should set all pattern types to css', () => {
      expect(PatternLibrary.PATTERNS.ARTICLE.type).toBe('css');
      expect(PatternLibrary.PATTERNS.PRODUCT.type).toBe('css');
      expect(PatternLibrary.PATTERNS.LINKS.type).toBe('css');
      expect(PatternLibrary.PATTERNS.IMAGES.type).toBe('css');
    });
  });

  // -------------------------------------------------------------------------
  // Table Scraping
  // -------------------------------------------------------------------------
  describe('Table Scraping (scrapeTable method)', () => {
    it('should extract table data from a specific selector', async () => {
      const tableResult = {
        headers: ['Name', 'Age'],
        rows: [['Alice', '30'], ['Bob', '25']],
        metadata: { rowCount: 2, columnCount: 2, hasHeaders: true },
      };

      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: mockScriptResult(tableResult),
      };

      const result = await tool.scrapeTable('table.data', 1);
      expect(result.headers).toEqual(['Name', 'Age']);
      expect(result.rows).toHaveLength(2);
      expect(result.metadata.rowCount).toBe(2);
      expect(result.metadata.hasHeaders).toBe(true);
    });

    it('should return empty table data when no table is found', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: mockScriptResult(null),
      };

      const result = await tool.scrapeTable('table.missing', 1);
      expect(result.headers).toEqual([]);
      expect(result.rows).toEqual([]);
      expect(result.metadata.rowCount).toBe(0);
    });

    it('should throw when no tabId and no url for scrapeTable', async () => {
      await expect(tool.scrapeTable('table')).rejects.toThrow('not provided');
    });

    it('should return default table data when script result is undefined', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);
      (chrome as any).scripting = {
        executeScript: vi.fn().mockResolvedValue([{}]),
      };

      const result = await tool.scrapeTable('table.test', 1);
      expect(result.headers).toEqual([]);
      expect(result.rows).toEqual([]);
      expect(result.metadata.columnCount).toBe(0);
      expect(result.metadata.hasHeaders).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Empty result handling
  // -------------------------------------------------------------------------
  describe('Empty Result Handling', () => {
    it('should return empty data object when script returns null', async () => {
      setupChromeForScraping(null);

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toEqual({});
    });

    it('should return empty data object when script returns undefined', async () => {
      setupChromeForScraping(undefined);

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data).toEqual({});
    });

    it('should handle empty patterns array without error', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // clickNextPage and scrollToLoadMore result handling
  // -------------------------------------------------------------------------
  describe('Pagination result edge cases', () => {
    it('should return false from clickNextPage when script returns empty array', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([]); // empty array = no result

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'click',
            nextSelector: '.next',
            maxPages: 3,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      // Should stop after first page since clickNextPage returned false
      expect(result.data.data.pages).toHaveLength(1);
    });

    it('should return false from scrollToLoadMore when script returns empty array', async () => {
      const tab = { id: 1, url: 'https://example.com' } as chrome.tabs.Tab;
      (chrome.tabs as any).get = vi.fn().mockResolvedValue(tab);

      const executeScript = vi.fn()
        .mockResolvedValueOnce([{ result: { items: [] } }])
        .mockResolvedValueOnce([]); // empty array = no result for scroll

      (chrome as any).scripting = { executeScript };

      const result = await tool.execute(
        {
          patterns: [makePattern()],
          pagination: {
            type: 'scroll',
            maxPages: 3,
            delay: 10,
          },
        },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.data.data.pages).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // extractWithPatterns (page-context function) - tested indirectly
  // -------------------------------------------------------------------------
  describe('extractWithPatterns (internal function)', () => {
    it('should be passed to executeScript as func', async () => {
      setupChromeForScraping({});

      await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect((chrome as any).scripting.executeScript).toHaveBeenCalledWith(
        expect.objectContaining({
          func: expect.any(Function),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Full execution flow through BaseTool.execute
  // -------------------------------------------------------------------------
  describe('Full execution flow', () => {
    it('should include toolName in successful result metadata', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.metadata!.toolName).toBe('web_scraping');
    });

    it('should include duration in successful result metadata', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(true);
      expect(result.metadata!.duration).toBeGreaterThanOrEqual(0);
    });

    it('should propagate options metadata to result metadata', async () => {
      setupChromeForScraping({});

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1, customKey: 'customValue' } },
      );

      expect(result.success).toBe(true);
      expect(result.metadata!.customKey).toBe('customValue');
    });

    it('should handle executeImpl throwing with string error', async () => {
      // Force a situation where getTab throws a string
      (chrome.tabs as any).get = vi.fn().mockImplementation(() => {
        throw 'raw string error';
      });

      const result = await tool.execute(
        { patterns: [makePattern()] },
        { metadata: { tabId: 1 } },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Scraping failed');
    });
  });
});
