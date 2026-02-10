/**
 * CDP Navigation Tool - Desktop Version
 *
 * Desktop-mode implementation of browser_navigation using CDP commands.
 * Mirrors src/tools/NavigationTool.ts but replaces Chrome extension APIs
 * (chrome.tabs, chrome.scripting) with CDP equivalents.
 *
 * @module desktop/tools/CDPNavigationTool
 */

import {
  BaseTool,
  createToolDefinition,
  type BaseToolRequest,
  type BaseToolOptions,
  type ToolDefinition,
} from '@/tools/BaseTool';
import { DesktopTabManager } from './browser/DesktopTabManager';
import type { CDPDebuggerClient } from './browser/CDPDebuggerClient';

// ============================================================================
// Type Definitions
// ============================================================================

interface CDPNavigationRequest extends BaseToolRequest {
  action: 'navigate' | 'reload' | 'goBack' | 'goForward' | 'getCurrentUrl' | 'waitForLoad' | 'stop' | 'getHistory';
  url?: string;
  options?: {
    waitForLoad?: boolean;
    timeout?: number;
    bypassCache?: boolean;
  };
}

interface CDPNavigationResponse {
  url?: string;
  title?: string;
  status?: 'loading' | 'complete' | 'error';
  loadTime?: number;
  error?: {
    code: string;
    message: string;
    url?: string;
    timestamp: number;
  };
}

// ============================================================================
// CDP Navigation Tool
// ============================================================================

/**
 * CDPNavigationTool provides browser navigation on desktop via CDP.
 *
 * Tool name: browser_navigation (same as extension NavigationTool)
 * Platform: desktop only
 */
export class CDPNavigationTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'browser_navigation',
    'Navigate browser pages - go to URLs, reload, history navigation, and page load management',
    {
      action: {
        type: 'string',
        description: 'The navigation action to perform',
        enum: ['navigate', 'reload', 'goBack', 'goForward', 'getCurrentUrl', 'waitForLoad', 'stop', 'getHistory'],
      },
      url: {
        type: 'string',
        description: 'URL to navigate to (required for navigate action)',
      },
      options: {
        type: 'object',
        description: 'Navigation options',
        properties: {
          waitForLoad: { type: 'boolean', description: 'Wait for page to fully load', default: true },
          timeout: { type: 'number', description: 'Navigation timeout (ms)', default: 30000 },
          bypassCache: { type: 'boolean', description: 'Bypass browser cache', default: false },
        },
      },
    },
    {
      required: ['action'],
      category: 'navigation',
      version: '1.0.0',
      metadata: {
        capabilities: ['page_navigation', 'history_management', 'load_monitoring'],
        platforms: ['desktop'],
      },
    }
  );

  /**
   * Execute navigation action
   */
  protected async executeImpl(
    request: BaseToolRequest,
    options?: BaseToolOptions
  ): Promise<CDPNavigationResponse> {
    const typedRequest = request as CDPNavigationRequest;
    const tabId = options?.metadata?.tabId;

    if (tabId === undefined || tabId === null || tabId === -1) {
      throw new Error('Target tab ID not provided in execution context');
    }

    const tabManager = DesktopTabManager.getInstance();
    const client = await tabManager.getClient(tabId);

    switch (typedRequest.action) {
      case 'navigate':
        return this.navigateToUrl(client, typedRequest);
      case 'reload':
        return this.reloadPage(client, typedRequest);
      case 'goBack':
        return this.goBack(client, typedRequest);
      case 'goForward':
        return this.goForward(client, typedRequest);
      case 'getCurrentUrl':
        return this.getCurrentUrl(client);
      case 'waitForLoad':
        return this.waitForLoad(client, typedRequest);
      case 'stop':
        return this.stopNavigation(client);
      case 'getHistory':
        return { status: 'complete' }; // History not available via CDP
      default:
        throw new Error(`Unsupported navigation action: ${typedRequest.action}`);
    }
  }

  /**
   * Navigate to a URL via CDP Page.navigate
   */
  private async navigateToUrl(
    client: CDPDebuggerClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    if (!request.url) {
      throw new Error('URL is required for navigate action');
    }

    const startTime = Date.now();
    const validUrl = this.validateAndNormalizeUrl(request.url);

    console.log(`[CDPNavigationTool] Navigating to ${validUrl}`);

    // Ensure Page domain is enabled
    await client.enableDomain('Page');

    // Navigate
    await client.sendCommand('Page.navigate', { url: validUrl });

    // Wait for load if requested (default: true)
    if (request.options?.waitForLoad !== false) {
      const timeout = request.options?.timeout || 30000;
      await this.waitForPageLoadEvent(client, timeout);
    }

    // Get final page state
    const pageInfo = await this.getPageInfo(client);

    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
      loadTime: Date.now() - startTime,
    };
  }

  /**
   * Reload the current page
   */
  private async reloadPage(
    client: CDPDebuggerClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    const startTime = Date.now();

    await client.sendCommand('Page.reload', {
      ignoreCache: request.options?.bypassCache || false,
    });

    if (request.options?.waitForLoad !== false) {
      const timeout = request.options?.timeout || 30000;
      await this.waitForPageLoadEvent(client, timeout);
    }

    const pageInfo = await this.getPageInfo(client);

    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
      loadTime: Date.now() - startTime,
    };
  }

  /**
   * Go back in history
   */
  private async goBack(
    client: CDPDebuggerClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    // Use Page.getNavigationHistory + Page.navigateToHistoryEntry
    const history = await client.sendCommand<any>('Page.getNavigationHistory');
    const currentIndex = history.currentIndex;

    if (currentIndex <= 0) {
      return {
        status: 'complete',
        error: {
          code: 'NO_HISTORY',
          message: 'No previous page in history',
          timestamp: Date.now(),
        },
      };
    }

    const previousEntry = history.entries[currentIndex - 1];
    await client.sendCommand('Page.navigateToHistoryEntry', {
      entryId: previousEntry.id,
    });

    if (request.options?.waitForLoad !== false) {
      await this.waitForPageLoadEvent(client, request.options?.timeout || 10000);
    }

    const pageInfo = await this.getPageInfo(client);
    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
    };
  }

  /**
   * Go forward in history
   */
  private async goForward(
    client: CDPDebuggerClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    const history = await client.sendCommand<any>('Page.getNavigationHistory');
    const currentIndex = history.currentIndex;

    if (currentIndex >= history.entries.length - 1) {
      return {
        status: 'complete',
        error: {
          code: 'NO_HISTORY',
          message: 'No forward page in history',
          timestamp: Date.now(),
        },
      };
    }

    const nextEntry = history.entries[currentIndex + 1];
    await client.sendCommand('Page.navigateToHistoryEntry', {
      entryId: nextEntry.id,
    });

    if (request.options?.waitForLoad !== false) {
      await this.waitForPageLoadEvent(client, request.options?.timeout || 10000);
    }

    const pageInfo = await this.getPageInfo(client);
    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
    };
  }

  /**
   * Get current URL and title
   */
  private async getCurrentUrl(client: CDPDebuggerClient): Promise<CDPNavigationResponse> {
    const pageInfo = await this.getPageInfo(client);
    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
    };
  }

  /**
   * Wait for page to finish loading
   */
  private async waitForLoad(
    client: CDPDebuggerClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    const startTime = Date.now();
    const timeout = request.options?.timeout || 10000;

    await this.waitForPageLoadEvent(client, timeout);

    const pageInfo = await this.getPageInfo(client);
    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
      loadTime: Date.now() - startTime,
    };
  }

  /**
   * Stop current navigation
   */
  private async stopNavigation(client: CDPDebuggerClient): Promise<CDPNavigationResponse> {
    await client.sendCommand('Page.stopLoading');

    const pageInfo = await this.getPageInfo(client);
    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wait for Page.loadEventFired event
   */
  private async waitForPageLoadEvent(
    client: CDPDebuggerClient,
    timeout: number
  ): Promise<void> {
    try {
      await client.waitForEvent('Page.loadEventFired', timeout);
    } catch {
      // Timeout - proceed anyway (page may be interactive even if not fully loaded)
      console.warn(`[CDPNavigationTool] Page load event timeout (${timeout}ms), proceeding`);
    }
  }

  /**
   * Get current page URL and title via Runtime.evaluate
   */
  private async getPageInfo(
    client: CDPDebuggerClient
  ): Promise<{ url: string; title: string }> {
    try {
      const result = await client.sendCommand<any>('Runtime.evaluate', {
        expression: '({ url: window.location.href, title: document.title })',
        returnByValue: true,
      });
      return result.result.value;
    } catch {
      return { url: '', title: '' };
    }
  }

  /**
   * Validate and normalize URL (shared logic with extension NavigationTool)
   */
  private validateAndNormalizeUrl(url: string): string {
    if (
      !url.startsWith('http://') &&
      !url.startsWith('https://') &&
      !url.startsWith('file://') &&
      !url.startsWith('chrome://')
    ) {
      if (url.includes('.') && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }

    try {
      new URL(url);
      return url;
    } catch {
      throw new Error(`Invalid URL format: ${url}`);
    }
  }
}
