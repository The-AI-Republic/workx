/**
 * Desktop Entry Point
 *
 * Main entry point for the Tauri desktop application.
 * Initializes the desktop-specific services and renders the UI.
 *
 * @module desktop/main
 */

import { initializeHotkeys } from './hotkeys';
import { initializeTray } from './tray';
import { TauriChannel } from './channels/TauriChannel';
import type { ChannelManager } from '@/core/channels/ChannelManager';

/**
 * Desktop application state
 */
let channelManager: ChannelManager | null = null;
let mainChannel: TauriChannel | null = null;

/**
 * Initialize the desktop application
 */
async function initializeDesktop(): Promise<void> {
  console.log('[Desktop] Initializing BrowserX Desktop...');

  // Initialize system tray
  await initializeTray();

  // Initialize global hotkeys
  await initializeHotkeys();

  // Create and register the main Tauri channel
  mainChannel = new TauriChannel();
  await mainChannel.initialize();

  console.log('[Desktop] BrowserX Desktop initialized');
}

/**
 * Cleanup on application shutdown
 */
async function cleanup(): Promise<void> {
  console.log('[Desktop] Shutting down...');

  if (mainChannel) {
    await mainChannel.close();
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeDesktop);
} else {
  initializeDesktop();
}

// Handle window unload
window.addEventListener('beforeunload', () => {
  cleanup();
});

export { initializeDesktop, cleanup };
