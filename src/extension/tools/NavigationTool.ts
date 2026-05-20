/**
 * Navigation Tool
 *
 * Provides browser navigation capabilities including page navigation, reload, history management,
 * and navigation event handling. Supports waiting for page loads and navigation error handling.
 */

import { BaseTool, createToolDefinition, type BaseToolRequest, type BaseToolOptions, type ToolDefinition } from '../../tools/BaseTool';

/**
 * Navigation tool request interface
 */
export interface NavigationToolRequest extends BaseToolRequest {
  action: 'navigate' | 'reload' | 'goBack' | 'goForward' | 'getHistory' | 'stop' | 'getCurrentUrl' | 'waitForLoad';
  url?: string;
  options?: NavigationOptions;
}

/**
 * Navigation options
 */
export interface NavigationOptions {
  waitForLoad?: boolean;
  timeout?: number;
  referrer?: string;
  bypassCache?: boolean;
  replaceHistory?: boolean;
  validateSSL?: boolean;
  maxRedirects?: number;
  loadEventTimeout?: number;
}

/**
 * Navigation tool response data
 */
export interface NavigationToolResponse {
  url?: string;
  title?: string;
  status?: 'loading' | 'complete' | 'error';
  history?: HistoryEntry[];
  navigationId?: string;
  loadTime?: number;
  redirectChain?: string[];
  error?: NavigationError;
}

/**
 * History entry
 */
export interface HistoryEntry {
  url: string;
  title: string;
  visitTime: number;
  visitId?: string;
  referringVisitId?: string;
  transition?: string;
}

/**
 * Navigation error
 */
export interface NavigationError {
  code: string;
  message: string;
  url?: string;
  timestamp: number;
}

/**
 * Navigation event
 */
export interface NavigationEvent {
  type: 'started' | 'completed' | 'failed' | 'redirected';
  url: string;
  tabId: number;
  timestamp: number;
  details?: any;
}

/**
 * Navigation Tool Implementation
 *
 * Provides comprehensive browser navigation management using Chrome extension APIs.
 */
export class NavigationTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'browser_navigation',
    'Navigate browser pages - go to URLs, reload, history navigation, and page load management',
    {
      action: {
        type: 'string',
        description: 'The navigation action to perform',
        enum: ['navigate', 'reload', 'goBack', 'goForward', 'getHistory', 'stop', 'getCurrentUrl', 'waitForLoad'],
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (required for navigate action)',
      },
      options: {
        type: 'object',
        description: 'Navigation options and settings',
        properties: {
          waitForLoad: { type: 'boolean', description: 'Wait for page to fully load', default: true },
          timeout: { type: 'number', description: 'Navigation timeout (ms)', default: 30000 },
          referrer: { type: 'string', description: 'Referrer URL for navigation' },
          bypassCache: { type: 'boolean', description: 'Bypass browser cache', default: false },
          replaceHistory: { type: 'boolean', description: 'Replace current history entry', default: false },
          validateSSL: { type: 'boolean', description: 'Validate SSL certificates', default: true },
          maxRedirects: { type: 'number', description: 'Maximum allowed redirects', default: 10 },
          loadEventTimeout: { type: 'number', description: 'Timeout for load event (ms)', default: 10000 },
        },
      },
    },
    {
      required: ['action'],
      category: 'navigation',
      version: '1.0.0',
      metadata: {
        capabilities: ['page_navigation', 'history_management', 'load_monitoring'],
        permissions: ['tabs', 'history', 'webNavigation'],
        platforms: ['extension'],
      },
    }
  );

  private navigationListeners: Map<number, (event: NavigationEvent) => void> = new Map();
  private pendingNavigations: Map<string, { resolve: (value: any) => void; reject: (error: any) => void }> = new Map();

  constructor() {
    super();
    this.setupNavigationListeners();
  }

  /**
   * Execute navigation tool action
   */
  protected async executeImpl(request: NavigationToolRequest, options?: BaseToolOptions): Promise<NavigationToolResponse> {
    // Validate Chrome context
    this.validateChromeContext();

    // Validate required permissions
    await this.validatePermissions(['tabs']);

    this.log('debug', `Executing navigation action: ${request.action}`, request);

    // Get tabId from metadata (passed internally, not from LLM)
    const tabId = options?.metadata?.tabId;

    // Check if tabId is valid
    if (tabId === undefined || tabId === null) {
      throw new Error('Target tab ID not provided in execution context');
    }

    if (tabId === -1) {
      throw new Error('Target tab cannot be found. Please ensure a tab is bound to the current session.');
    }

    // Validate tab exists
    let targetTab: chrome.tabs.Tab;
    try {
      targetTab = await chrome.tabs.get(tabId);
    } catch (error) {
      throw new Error(`Target tab ${tabId} not found or inaccessible`);
    }

    this.emitNavigationProgress(options, request, 'loading', targetTab.url);

    try {
      let result: NavigationToolResponse;
      switch (request.action) {
        case 'navigate':
          result = await this.navigateToUrl(targetTab.id!, request);
          break;

        case 'reload':
          result = await this.reloadPage(targetTab.id!, request);
          break;

        case 'goBack':
          result = await this.goBack(targetTab.id!, request);
          break;

        case 'goForward':
          result = await this.goForward(targetTab.id!, request);
          break;

        case 'getHistory':
          result = await this.getHistory(request);
          break;

        case 'stop':
          result = await this.stopNavigation(targetTab.id!, request);
          break;

        case 'getCurrentUrl':
          result = await this.getCurrentUrl(targetTab.id!, request);
          break;

        case 'waitForLoad':
          result = await this.waitForLoad(targetTab.id!, request);
          break;

        default:
          throw new Error(`Unsupported navigation action: ${request.action}`);
      }

      this.emitNavigationProgress(options, request, 'loaded', result.url || targetTab.url);
      return result;
    } catch (error) {
      this.emitNavigationProgress(options, request, 'failed', request.url || targetTab.url);
      throw error;
    }
  }

  private emitNavigationProgress(
    options: BaseToolOptions | undefined,
    request: NavigationToolRequest,
    status: 'loading' | 'loaded' | 'failed',
    url?: string,
  ): void {
    options?.onProgress?.({
      toolUseID: options.callId ?? 'browser_navigation',
      data: {
        type: 'navigation_progress',
        url: url || request.url || '',
        status,
      },
    });
  }

  /**
   * Navigate to a URL
   */
  private async navigateToUrl(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    if (!request.url) {
      throw new Error('URL is required for navigate action');
    }

    const startTime = Date.now();
    const navigationId = this.generateNavigationId();

    try {
      // Validate URL format
      const validUrl = this.validateAndNormalizeUrl(request.url);

      this.log('info', `Navigating to ${validUrl} in tab ${tabId}`);

      // Update tab URL
      const updatedTab = await chrome.tabs.update(tabId, { url: validUrl });

      let navigationResult: NavigationToolResponse = {
        url: validUrl,
        navigationId,
        status: 'loading',
      };

      // Wait for navigation to complete if requested
      if (request.options?.waitForLoad !== false) {
        const loadResult = await this.waitForNavigationComplete(
          tabId,
          validUrl,
          request.options?.timeout || 30000
        );

        navigationResult = {
          ...navigationResult,
          ...loadResult,
          loadTime: Date.now() - startTime,
        };
      }

      return navigationResult;

    } catch (error) {
      throw new Error(`Navigation failed: ${error}`);
    }
  }

  /**
   * Reload the current page
   */
  private async reloadPage(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    const startTime = Date.now();

    try {
      const currentTab = await chrome.tabs.get(tabId);

      // Reload the tab
      await chrome.tabs.reload(tabId, {
        bypassCache: request.options?.bypassCache || false,
      });

      let navigationResult: NavigationToolResponse = {
        url: currentTab.url || '',
        status: 'loading',
      };

      // Wait for reload to complete if requested
      if (request.options?.waitForLoad !== false) {
        const loadResult = await this.waitForNavigationComplete(
          tabId,
          currentTab.url!,
          request.options?.timeout || 30000
        );

        navigationResult = {
          ...navigationResult,
          ...loadResult,
          loadTime: Date.now() - startTime,
        };
      }

      this.log('info', `Reloaded page in tab ${tabId}`);

      return navigationResult;

    } catch (error) {
      throw new Error(`Page reload failed: ${error}`);
    }
  }

  /**
   * Go back in history
   */
  private async goBack(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    try {
      // Use chrome.scripting.executeScript (Manifest V3 API)
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { history.back(); }
      });

      // Wait for navigation if requested
      if (request.options?.waitForLoad !== false) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Brief wait for navigation to start

        await this.waitForTabToLoad(tabId, request.options?.timeout || 10000);

        // Get tab info AFTER navigation completes
        const tab = await chrome.tabs.get(tabId);

        return {
          url: tab.url || '',
          title: tab.title || '',
          status: 'complete',
        };
      }

      this.log('info', `Navigated back in tab ${tabId}`);

      return { status: 'complete' };

    } catch (error) {
      throw new Error(`Go back navigation failed: ${error}`);
    }
  }

  /**
   * Go forward in history
   */
  private async goForward(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    try {
      // Use chrome.scripting.executeScript (Manifest V3 API)
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { history.forward(); }
      });

      // Wait for navigation if requested
      if (request.options?.waitForLoad !== false) {
        await new Promise(resolve => setTimeout(resolve, 500)); // Brief wait for navigation to start

        await this.waitForTabToLoad(tabId, request.options?.timeout || 10000);

        // Get tab info AFTER navigation completes
        const tab = await chrome.tabs.get(tabId);

        return {
          url: tab.url || '',
          title: tab.title || '',
          status: 'complete',
        };
      }

      this.log('info', `Navigated forward in tab ${tabId}`);

      return { status: 'complete' };

    } catch (error) {
      throw new Error(`Go forward navigation failed: ${error}`);
    }
  }

  /**
   * Get browser history
   */
  private async getHistory(request: NavigationToolRequest): Promise<NavigationToolResponse> {
    try {
      // Validate history permission
      await this.validatePermissions(['history']);

      const searchOptions: chrome.history.HistoryQuery = {
        text: '',
        maxResults: 100,
      };

      if (request.options?.timeout) {
        searchOptions.endTime = Date.now();
        searchOptions.startTime = Date.now() - (7 * 24 * 60 * 60 * 1000); // Last 7 days
      }

      const historyItems = await chrome.history.search(searchOptions);

      const history: HistoryEntry[] = historyItems.map(item => ({
        url: item.url || '',
        title: item.title || '',
        visitTime: item.lastVisitTime || 0,
        visitId: item.id,
      }));

      this.log('info', `Retrieved ${history.length} history entries`);

      return { history };

    } catch (error) {
      throw new Error(`Failed to get history: ${error}`);
    }
  }

  /**
   * Stop current navigation
   */
  private async stopNavigation(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    try {
      // Stop tab loading using chrome.scripting.executeScript (Manifest V3 API)
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => { window.stop(); }
      });

      const tab = await chrome.tabs.get(tabId);

      this.log('info', `Stopped navigation in tab ${tabId}`);

      return {
        url: tab.url || '',
        title: tab.title || '',
        status: 'complete',
      };

    } catch (error) {
      throw new Error(`Failed to stop navigation: ${error}`);
    }
  }

  /**
   * Get current URL
   */
  private async getCurrentUrl(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    try {
      const tab = await chrome.tabs.get(tabId);

      return {
        url: tab.url || '',
        title: tab.title || '',
        status: tab.status as 'loading' | 'complete' || 'complete',
      };

    } catch (error) {
      throw new Error(`Failed to get current URL: ${error}`);
    }
  }

  /**
   * Wait for page to load
   */
  private async waitForLoad(tabId: number, request: NavigationToolRequest): Promise<NavigationToolResponse> {
    try {
      const startTime = Date.now();
      const timeout = request.options?.loadEventTimeout || 10000;

      await this.waitForTabToLoad(tabId, timeout);

      const tab = await chrome.tabs.get(tabId);

      return {
        url: tab.url || '',
        title: tab.title || '',
        status: 'complete',
        loadTime: Date.now() - startTime,
      };

    } catch (error) {
      throw new Error(`Wait for load failed: ${error}`);
    }
  }

  /**
   * Wait for navigation to complete
   */
  private async waitForNavigationComplete(
    tabId: number,
    expectedUrl: string,
    timeout: number = 30000
  ): Promise<Partial<NavigationToolResponse>> {
    const startTime = Date.now();

    try {
      // Wait for tab to stop loading
      await this.waitForTabToLoad(tabId, timeout);

      // Get final tab state
      const tab = await chrome.tabs.get(tabId);

      return {
        url: tab.url || '',
        title: tab.title || '',
        status: 'complete',
      };

    } catch (error) {
      return {
        status: 'error',
        error: {
          code: 'NAVIGATION_TIMEOUT',
          message: `Navigation timed out after ${timeout}ms`,
          url: expectedUrl,
          timestamp: Date.now(),
        },
      };
    }
  }

  /**
   * Wait for tab to finish loading
   */
  private async waitForTabToLoad(tabId: number, timeoutMs: number = 10000): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const tab = await chrome.tabs.get(tabId);

      if (tab.status === 'complete') {
        return;
      }

      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    throw new Error(`Tab ${tabId} did not finish loading within ${timeoutMs}ms`);
  }

  /**
   * Validate and normalize URL.
   *
   * Security: the LLM controls this string. Only http(s) navigation is allowed.
   * `javascript:`, `data:`, `vbscript:`, `file://`, `chrome://`,
   * `chrome-extension://`, `about:`, and `view-source:` are explicitly
   * rejected — they either execute arbitrary code in the page context, read
   * the local filesystem, or reach into the extension's own privileged origin.
   */
  private validateAndNormalizeUrl(url: string): string {
    const trimmed = url.trim();
    const lower = trimmed.toLowerCase();
    const BLOCKED_PREFIXES = [
      'javascript:',
      'data:',
      'vbscript:',
      'file:',
      'chrome:',
      'chrome-extension:',
      'about:',
      'view-source:',
    ];
    for (const prefix of BLOCKED_PREFIXES) {
      if (lower.startsWith(prefix)) {
        throw new Error(`Blocked URL scheme: ${prefix}`);
      }
    }

    let normalized = trimmed;
    if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
      if (normalized.includes('.') && !normalized.includes(' ')) {
        normalized = 'https://' + normalized;
      } else {
        // Treat as search query
        normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(normalized);
    } catch {
      throw new Error(`Invalid URL format: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
    }
    // Return the pre-`new URL()` form so we don't add a trailing slash to
    // path-less inputs like `https://example.com` (which `URL.toString()`
    // would normalize to `https://example.com/`). Callers — and existing
    // tests — expect the value as supplied.
    return normalized;
  }

  /**
   * Setup navigation event listeners
   */
  private setupNavigationListeners(): void {
    if (chrome.webNavigation) {
      chrome.webNavigation.onBeforeNavigate.addListener((details) => {
        if (details.frameId === 0) { // Only main frame
          this.emitNavigationEvent({
            type: 'started',
            url: details.url,
            tabId: details.tabId,
            timestamp: details.timeStamp,
            details,
          });
        }
      });

      chrome.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId === 0) { // Only main frame
          this.emitNavigationEvent({
            type: 'completed',
            url: details.url,
            tabId: details.tabId,
            timestamp: details.timeStamp,
            details,
          });
        }
      });

      chrome.webNavigation.onErrorOccurred.addListener((details) => {
        if (details.frameId === 0) { // Only main frame
          this.emitNavigationEvent({
            type: 'failed',
            url: details.url,
            tabId: details.tabId,
            timestamp: details.timeStamp,
            details,
          });
        }
      });
    }
  }

  /**
   * Emit navigation event
   */
  private emitNavigationEvent(event: NavigationEvent): void {
    const listener = this.navigationListeners.get(event.tabId);
    if (listener) {
      listener(event);
    }

    this.log('debug', `Navigation event: ${event.type}`, event);
  }

  /**
   * Generate unique navigation ID
   */
  private generateNavigationId(): string {
    return `nav_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Add navigation event listener
   */
  addNavigationListener(tabId: number, callback: (event: NavigationEvent) => void): void {
    this.navigationListeners.set(tabId, callback);
  }

  /**
   * Remove navigation event listener
   */
  removeNavigationListener(tabId: number): void {
    this.navigationListeners.delete(tabId);
  }

  /**
   * Navigate and wait for specific condition
   */
  async navigateAndWaitFor(
    tabId: number,
    url: string,
    condition: (tab: chrome.tabs.Tab) => boolean,
    timeout: number = 30000
  ): Promise<NavigationToolResponse> {
    const startTime = Date.now();

    // Start navigation
    await chrome.tabs.update(tabId, { url });

    // Wait for condition
    while (Date.now() - startTime < timeout) {
      const tab = await chrome.tabs.get(tabId);

      if (condition(tab)) {
        return {
          url: tab.url || '',
          title: tab.title || '',
          status: 'complete',
          loadTime: Date.now() - startTime,
        };
      }

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    throw new Error(`Navigation condition not met within ${timeout}ms`);
  }

  /**
   * Get navigation performance metrics
   */
  async getNavigationMetrics(tabId: number): Promise<any> {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
          return {
            loadTime: navigation.loadEventEnd - navigation.loadEventStart,
            domContentLoaded: navigation.domContentLoadedEventEnd - navigation.domContentLoadedEventStart,
            responseTime: navigation.responseEnd - navigation.requestStart,
            redirectCount: navigation.redirectCount,
            type: navigation.type
          };
        }
      });

      return results[0]?.result;
    } catch (error) {
      this.log('warn', `Could not get navigation metrics: ${error}`);
      return null;
    }
  }

  /**
   * Check if URL is accessible
   */
  async checkUrlAccessibility(url: string): Promise<{ accessible: boolean; status?: number; error?: string }> {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      return {
        accessible: response.ok,
        status: response.status,
      };
    } catch (error) {
      return {
        accessible: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
