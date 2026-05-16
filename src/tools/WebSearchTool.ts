/**
 * Web Search Tool
 *
 * Provides web search capabilities using Chrome DevTools Protocol (CDP) to perform
 * Google searches in a hidden tab without any visible UI flash.
 * Filters out ads and sponsored content to return only organic results.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from './BaseTool';
import type { ToolConcurrencyProfile } from './runtimeMetadata';

/**
 * Shared concurrency profile for web_search, used by every platform
 * registrar (extension / desktop / server) so the three cannot drift.
 *
 * web_search is a pure external search GET: no DOM/navigation/storage
 * mutation and no shared browser state. It is therefore both
 * concurrency-safe AND read-only. The read-only bit is load-bearing for
 * Track 14 Plan Review — without it, web search (core to read-only
 * exploration) fail-closes to "frozen" during a plan. (Previously each
 * registrar passed a bare risk assessor with no concurrency profile.)
 */
export const WEB_SEARCH_CONCURRENCY: ToolConcurrencyProfile = {
  isConcurrencySafe: () => true,
  isReadOnly: () => true,
  isDestructive: () => false,
};

/**
 * Search result interface
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Web search tool request interface
 */
export interface WebSearchToolRequest extends BaseToolRequest {
  query: string;
  maxResults?: number;
  debug?: boolean; // Keep tab open for debugging
}

/**
 * Web search tool response interface
 */
export interface WebSearchToolResponse {
  query: string;
  results: SearchResult[];
}

/**
 * Web Search Tool Implementation
 *
 * Uses Chrome DevTools Protocol (CDP) to perform searches in a completely hidden tab.
 * CDP allows JavaScript execution and DOM access even on inactive/background tabs.
 */
export class WebSearchTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'web_search',
    'Search the web for information using Google. Returns organic search results with titles, URLs, and snippets.',
    {
      query: {
        type: 'string',
        description: 'The search query to execute',
      },
      maxResults: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10, max: 20)',
      },
    },
    {
      required: ['query'],
      category: 'search',
      version: '1.0.0',
      metadata: {
        capabilities: ['web_search', 'information_retrieval'],
        permissions: ['tabs', 'scripting', 'debugger'],
        platforms: ['extension', 'desktop'],
      },
    }
  );

  /**
   * Execute web search using CDP
   */
  protected async executeImpl(request: WebSearchToolRequest, options?: BaseToolOptions): Promise<WebSearchToolResponse> {
    this.validateChromeContext();

    const query = request.query;
    const maxResults = Math.min(request.maxResults || 10, 20);
    const debugMode = request.debug || false;

    if (!query || query.trim().length === 0) {
      throw new Error('Search query cannot be empty');
    }

    this.log('info', `Executing web search for: "${query}" using CDP`);

    let searchTab: chrome.tabs.Tab | null = null;
    let debuggerAttached = false;

    let searchWindow: chrome.windows.Window | null = null;

    try {
      // Create a tiny popup window and immediately minimize it
      searchWindow = (await chrome.windows.create({
        url: 'about:blank',
        type: 'popup',
        width: 100,
        height: 100,
        focused: false,
      })) ?? null;

      // Immediately minimize the window to hide it
      if (searchWindow?.id) {
        await chrome.windows.update(searchWindow.id, { state: 'minimized' });
      }

      if (!searchWindow?.tabs?.[0]?.id) {
        throw new Error('Failed to create search window/tab');
      }

      searchTab = searchWindow.tabs[0];
      const tabId = searchTab.id!;

      // Attach debugger to the tab
      await chrome.debugger.attach({ tabId }, '1.3');
      debuggerAttached = true;

      // Enable required CDP domains
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable', {});

      // Navigate to Google search
      const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url: searchUrl });

      // Wait for page to load using CDP
      await this.waitForPageLoad(tabId);

      // Try to dismiss consent dialogs
      await this.dismissConsentDialogs(tabId);

      // Wait a bit for any dynamic content
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Extract search results using CDP Runtime.evaluate
      const searchResults = await this.extractResultsWithCDP(tabId, maxResults);

      // Detach debugger before closing tab
      if (debuggerAttached) {
        try {
          await chrome.debugger.detach({ tabId });
          debuggerAttached = false;
        } catch {
          // Ignore detach errors
        }
      }

      // Close the search window (unless in debug mode)
      if (!debugMode && searchWindow?.id) {
        await chrome.windows.remove(searchWindow.id);
        searchWindow = null;
        searchTab = null;
      } else if (debugMode && searchWindow?.id) {
        this.log('info', `Debug mode: keeping search window open (windowId: ${searchWindow.id})`);
        await chrome.windows.update(searchWindow.id, { state: 'normal', focused: true });
      }

      this.log('info', `Found ${searchResults.length} results for: "${query}"`);

      return {
        query,
        results: searchResults,
      };
    } catch (error) {
      // Clean up debugger
      if (debuggerAttached && searchTab?.id) {
        try {
          await chrome.debugger.detach({ tabId: searchTab.id });
        } catch {
          // Ignore detach errors
        }
      }

      // Clean up window (unless in debug mode)
      if (searchWindow?.id && !debugMode) {
        try {
          await chrome.windows.remove(searchWindow.id);
        } catch {
          // Ignore cleanup errors
        }
      } else if (debugMode && searchWindow?.id) {
        this.log('info', `Debug mode: keeping search window open on error (windowId: ${searchWindow.id})`);
        await chrome.windows.update(searchWindow.id, { state: 'normal', focused: true });
      }
      throw error;
    }
  }

  /**
   * Wait for page to fully load using CDP Page.loadEventFired
   */
  private async waitForPageLoad(tabId: number, timeoutMs: number = 15000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        chrome.debugger.onEvent.removeListener(listener);
        reject(new Error(`Page load timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const listener = (source: chrome.debugger.Debuggee, method: string) => {
        if (source.tabId === tabId && method === 'Page.loadEventFired') {
          clearTimeout(timeout);
          chrome.debugger.onEvent.removeListener(listener);
          resolve();
        }
      };

      chrome.debugger.onEvent.addListener(listener);
    });
  }

  /**
   * Dismiss consent dialogs using CDP
   */
  private async dismissConsentDialogs(tabId: number): Promise<void> {
    const script = `
      (function() {
        const consentButtons = document.querySelectorAll('button');
        consentButtons.forEach((btn) => {
          const text = btn.textContent?.toLowerCase() || '';
          if (text.includes('reject all') || text.includes('accept all') ||
              text.includes('i agree') || text.includes('agree')) {
            btn.click();
          }
        });
      })();
    `;

    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      });
    } catch {
      // Ignore errors - consent dialog might not exist
    }
  }

  /**
   * Extract search results using CDP Runtime.evaluate
   */
  private async extractResultsWithCDP(tabId: number, maxResults: number): Promise<SearchResult[]> {
    const extractionScript = `
      (function(maxResultsParam) {
        const results = [];

        // Helper function to check if an element is an ad
        const isAdElement = (element) => {
          const adIndicators = [
            element.closest('[data-text-ad]'),
            element.closest('[data-ad-preview]'),
            element.closest('.ads-ad'),
            element.closest('.commercial-unit-desktop-top'),
            element.closest('.commercial-unit-mobile-top'),
            element.closest('#tads'),
            element.closest('#tadsb'),
            element.closest('#bottomads'),
            element.closest('[aria-label="Ads"]'),
            element.querySelector('[aria-label="Ad"]'),
            element.querySelector('[data-dtld]'),
          ];

          if (adIndicators.some(indicator => indicator !== null)) {
            return true;
          }

          const elementText = element.textContent || '';
          const adTextPatterns = ['Sponsored', 'Ad ·', '· Ad'];
          if (adTextPatterns.some(pattern => elementText.includes(pattern))) {
            return true;
          }

          const linkElement = element.querySelector('a[href]');
          if (linkElement?.href) {
            const url = linkElement.href;
            if (url.includes('googleadservices.com') ||
                url.includes('/aclk?') ||
                url.includes('google.com/aclk')) {
              return true;
            }
          }

          return false;
        };

        // Try multiple selectors
        let searchResultElements = document.querySelectorAll('div.g');

        if (searchResultElements.length === 0) {
          searchResultElements = document.querySelectorAll('div.MjjYud > div');
        }

        let resultCount = 0;

        searchResultElements.forEach((element) => {
          if (resultCount >= maxResultsParam) return;

          if (isAdElement(element)) {
            return;
          }

          const titleElement = element.querySelector('h3');
          const linkElement = element.querySelector('a[href]');
          const snippetElement = element.querySelector('div[data-sncf], div.VwiC3b, span.aCOpRe');

          if (titleElement && linkElement) {
            const url = linkElement.href;
            if (url && !url.startsWith('https://www.google.com') && !url.startsWith('https://accounts.google.com')) {
              results.push({
                title: titleElement.textContent?.trim() || '',
                url: url,
                snippet: snippetElement?.textContent?.trim() || '',
              });
              resultCount++;
            }
          }
        });

        return results;
      })(${maxResults});
    `;

    try {
      const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: extractionScript,
        returnByValue: true,
      }) as { result: { value: SearchResult[] } };

      return result.result?.value || [];
    } catch (error) {
      this.log('error', `Failed to extract results: ${error}`);
      return [];
    }
  }
}
