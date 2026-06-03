/**
 * Browser Control Factory
 *
 * Creates the appropriate BrowserController based on build mode.
 *
 * @module core/tools/browser
 */

import type { BrowserController } from './BrowserController';
import type { DebuggerClient } from './DebuggerClient';

export type { BrowserController } from './BrowserController';
export type { DebuggerClient, DebuggerTarget, CDPEventCallback, CDPDomain } from './DebuggerClient';
export * from './types';

/**
 * Create the appropriate BrowserController for the current build mode.
 *
 * @param tabId - Tab ID (required for extension mode)
 * @returns BrowserController instance
 *
 * @example
 * ```typescript
 * const controller = await createBrowserController(tabId);
 * await controller.navigate('https://example.com');
 * ```
 */
export async function createBrowserController(tabId?: number): Promise<BrowserController> {
  if (__BUILD_MODE__ === 'extension') {
    if (tabId === undefined) {
      throw new Error('tabId is required for extension mode');
    }
    const { ExtensionBrowserController } = await import(
      '@/extension/tools/browser/ExtensionBrowserController'
    );
    return new ExtensionBrowserController(tabId);
  } else {
    // Track 43: native CDP browser control was removed; the desktop
    // builtin MCP server (chrome-devtools-mcp) is the only browser
    // automation surface now. Calling this factory in desktop mode is a
    // bug — the agent should route through MCP tools instead.
    throw new Error(
      'Desktop native browser controller is removed; use the MCP browser server tools instead.',
    );
  }
}

/**
 * Create the appropriate DebuggerClient for the current build mode.
 *
 * @returns DebuggerClient instance
 *
 * @example
 * ```typescript
 * const client = await createDebuggerClient();
 * await client.attach({ tabId: 123 });
 * const result = await client.sendCommand('DOM.getDocument');
 * ```
 */
export async function createDebuggerClient(): Promise<DebuggerClient> {
  if (__BUILD_MODE__ === 'extension') {
    const { ChromeDebuggerClient } = await import(
      '@/extension/tools/browser/ChromeDebuggerClient'
    );
    return new ChromeDebuggerClient();
  } else {
    throw new Error(
      'Desktop CDP debugger client is removed; the runtime sidecar drives the chrome-devtools-mcp MCP server instead.',
    );
  }
}
