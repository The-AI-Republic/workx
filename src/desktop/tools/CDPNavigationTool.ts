/**
 * CDP Navigation Tool - Desktop Version
 *
 * Desktop-mode implementation of browser_navigation using chrome-devtools-mcp
 * via MCP tool calls. Replaces direct CDP commands with MCP equivalents.
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
import { ChromeDevToolsMCPClient } from './browser/ChromeDevToolsMCPClient';

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
 * CDPNavigationTool provides browser navigation on desktop via chrome-devtools-mcp.
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
   * Execute navigation action via chrome-devtools-mcp
   */
  protected async executeImpl(
    request: BaseToolRequest,
    _options?: BaseToolOptions
  ): Promise<CDPNavigationResponse> {
    const typedRequest = request as CDPNavigationRequest;
    const mcpClient = ChromeDevToolsMCPClient.getInstance();

    switch (typedRequest.action) {
      case 'navigate':
        return this.navigateToUrl(mcpClient, typedRequest);
      case 'reload':
        return this.reloadPage(mcpClient, typedRequest);
      case 'goBack':
        return this.goBack(mcpClient);
      case 'goForward':
        return this.goForward(mcpClient);
      case 'getCurrentUrl':
        return this.getCurrentUrl(mcpClient);
      case 'waitForLoad':
        return this.waitForLoad(mcpClient, typedRequest);
      case 'stop':
        return this.stopNavigation(mcpClient);
      case 'getHistory':
        return { status: 'complete' };
      default:
        throw new Error(`Unsupported navigation action: ${typedRequest.action}`);
    }
  }

  /**
   * Navigate to a URL via MCP navigate_page
   */
  private async navigateToUrl(
    mcpClient: ChromeDevToolsMCPClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    if (!request.url) {
      throw new Error('URL is required for navigate action');
    }

    const startTime = Date.now();
    const validUrl = this.validateAndNormalizeUrl(request.url);

    console.log(`[CDPNavigationTool] Navigating to ${validUrl}`);

    const timeout = request.options?.timeout || 30000;
    const result = await mcpClient.callTool('navigate_page', {
      type: 'url',
      url: validUrl,
      timeout,
    });

    if (result.isError) {
      return {
        status: 'error',
        error: {
          code: 'NAVIGATION_FAILED',
          message: ChromeDevToolsMCPClient.getTextContent(result),
          url: validUrl,
          timestamp: Date.now(),
        },
      };
    }

    // Get page info after navigation
    const pageInfo = await this.getPageInfo(mcpClient);

    return {
      url: pageInfo.url || validUrl,
      title: pageInfo.title,
      status: 'complete',
      loadTime: Date.now() - startTime,
    };
  }

  /**
   * Reload the current page
   */
  private async reloadPage(
    mcpClient: ChromeDevToolsMCPClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    const startTime = Date.now();

    await mcpClient.callTool('navigate_page', {
      type: 'reload',
      ignoreCache: request.options?.bypassCache || false,
    });

    const pageInfo = await this.getPageInfo(mcpClient);

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
    mcpClient: ChromeDevToolsMCPClient
  ): Promise<CDPNavigationResponse> {
    await mcpClient.callTool('navigate_page', { type: 'back' });

    const pageInfo = await this.getPageInfo(mcpClient);

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
    mcpClient: ChromeDevToolsMCPClient
  ): Promise<CDPNavigationResponse> {
    await mcpClient.callTool('navigate_page', { type: 'forward' });

    const pageInfo = await this.getPageInfo(mcpClient);

    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
    };
  }

  /**
   * Get current URL and title
   */
  private async getCurrentUrl(
    mcpClient: ChromeDevToolsMCPClient
  ): Promise<CDPNavigationResponse> {
    const pageInfo = await this.getPageInfo(mcpClient);
    return {
      url: pageInfo.url,
      title: pageInfo.title,
      status: 'complete',
    };
  }

  /**
   * Wait for specific text to appear on the page
   */
  private async waitForLoad(
    mcpClient: ChromeDevToolsMCPClient,
    request: CDPNavigationRequest
  ): Promise<CDPNavigationResponse> {
    const startTime = Date.now();
    const timeout = request.options?.timeout || 10000;

    // wait_for expects text to wait for on the page.
    // For a generic "wait for load", we check for document readiness.
    const result = await mcpClient.callTool('evaluate_script', {
      function: `() => new Promise((resolve) => {
        if (document.readyState === 'complete') return resolve('loaded');
        window.addEventListener('load', () => resolve('loaded'), { once: true });
        setTimeout(() => resolve('timeout'), ${timeout});
      })`,
    });

    if (result.isError) {
      console.warn(`[CDPNavigationTool] Wait for load warning: ${ChromeDevToolsMCPClient.getTextContent(result)}`);
    }

    const pageInfo = await this.getPageInfo(mcpClient);
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
  private async stopNavigation(
    mcpClient: ChromeDevToolsMCPClient
  ): Promise<CDPNavigationResponse> {
    await mcpClient.callTool('evaluate_script', {
      function: '() => window.stop()',
    });

    const pageInfo = await this.getPageInfo(mcpClient);
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
   * Get current page URL and title via evaluate_script
   */
  private async getPageInfo(
    mcpClient: ChromeDevToolsMCPClient
  ): Promise<{ url: string; title: string }> {
    try {
      const result = await mcpClient.callTool('evaluate_script', {
        function: '() => JSON.stringify({ url: window.location.href, title: document.title })',
      });
      const text = ChromeDevToolsMCPClient.getTextContent(result);
      return JSON.parse(text);
    } catch {
      return { url: '', title: '' };
    }
  }

  /**
   * Validate and normalize URL
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
