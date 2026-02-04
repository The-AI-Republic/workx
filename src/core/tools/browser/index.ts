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
    const { CDPBrowserController } = await import(
      '@/desktop/tools/browser/CDPBrowserController'
    );
    const controller = new CDPBrowserController();
    await controller.initialize();
    return controller;
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
    const { CDPDebuggerClient } = await import(
      '@/desktop/tools/browser/CDPDebuggerClient'
    );
    return new CDPDebuggerClient();
  }
}
