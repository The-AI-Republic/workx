/**
 * Platform-Agnostic Messaging
 *
 * Central export for the messaging module. Provides a unified API
 * for UI components to communicate with the backend via UIChannelClient.
 *
 * Usage:
 *    ```typescript
 *    import { getInitializedUIClient } from '@/core/messaging';
 *    const client = await getInitializedUIClient();
 *    const servers = await client.serviceRequest('mcp.getServers');
 *    ```
 *
 * @module core/messaging
 */

// UIChannelClient (message_routing_v2)
import { UIChannelClient } from './UIChannelClient';
import { ChromeExtensionTransport } from './transports/ChromeExtensionTransport';
import { TauriTransport } from './transports/TauriTransport';
export { UIChannelClient };
export type { UIChannelTransport } from './transports/types';
export { ChromeExtensionTransport };
export { TauriTransport };
export { WebSocketTransport } from './transports/WebSocketTransport';

// ---------------------------------------------------------------------------
// UIChannelClient singleton
// ---------------------------------------------------------------------------

let _uiClient: UIChannelClient | null = null;
let _uiClientInitPromise: Promise<void> | null = null;

/**
 * Get or create the UIChannelClient singleton.
 * The transport is selected based on the runtime environment.
 */
export function getUIClient(): UIChannelClient {
  if (_uiClient) return _uiClient;

  let transport: import('./transports/types').UIChannelTransport;

  // Check Tauri first — in desktop mode the chromePolyfill also provides
  // chrome.runtime.sendMessage, so we must prefer TauriTransport.
  if (typeof (globalThis as any).__TAURI__ !== 'undefined') {
    console.log('[messaging] Selected TauriTransport (desktop mode)');
    transport = new TauriTransport();
  } else if (typeof chrome !== 'undefined' && typeof chrome?.runtime?.sendMessage === 'function') {
    console.log('[messaging] Selected ChromeExtensionTransport (extension mode)');
    transport = new ChromeExtensionTransport();
  } else {
    throw new Error('No suitable transport found for UIChannelClient');
  }

  _uiClient = new UIChannelClient(transport);
  return _uiClient;
}

/**
 * Get the UIChannelClient singleton, ensuring it is initialized.
 * Lazily creates and initializes the client on first call.
 */
export async function getInitializedUIClient(): Promise<UIChannelClient> {
  const client = getUIClient();

  if (!_uiClientInitPromise) {
    _uiClientInitPromise = client.initialize().catch((err) => {
      _uiClientInitPromise = null;
      throw err;
    });
  }

  await _uiClientInitPromise;
  return client;
}
