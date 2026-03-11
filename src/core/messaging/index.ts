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
import { WebSocketTransport } from './transports/WebSocketTransport';
export { UIChannelClient };
export type { UIChannelTransport } from './transports/types';
export { ChromeExtensionTransport };
export { TauriTransport };
export { WebSocketTransport };

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

  // Use compile-time __BUILD_MODE__ for transport selection.
  // Runtime checks like __TAURI__ are unreliable because the chromePolyfill
  // installs chrome.runtime.sendMessage before __TAURI__ may be available.
  if (__BUILD_MODE__ === 'desktop') {
    console.log('[messaging] Selected TauriTransport (desktop mode)');
    transport = new TauriTransport();
  } else if (__BUILD_MODE__ === 'extension') {
    console.log('[messaging] Selected ChromeExtensionTransport (extension mode)');
    transport = new ChromeExtensionTransport();
  } else if (__BUILD_MODE__ === 'web') {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}`;
    console.log('[messaging] Selected WebSocketTransport (web mode)', url);
    transport = new WebSocketTransport({ url });
  } else {
    throw new Error(`No suitable transport for build mode: ${__BUILD_MODE__}`);
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

/**
 * Destroy the UIChannelClient singleton and reset state.
 * Useful for cleanup during hot-reload or shutdown.
 */
export async function destroyUIClient(): Promise<void> {
  if (_uiClient) {
    await _uiClient.destroy();
    _uiClient = null;
    _uiClientInitPromise = null;
  }
}
