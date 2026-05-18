/**
 * Desktop Entry Point
 *
 * Initializes desktop-specific services (tray, hotkeys).
 * Note: The agent and channel setup is handled by DesktopAgentBootstrap
 * which is initialized from desktop/ui/main.ts.
 *
 * @module desktop/main
 */

import { initializeHotkeys } from './hotkeys';
import { initializeTray } from './tray';
import { initializeAutoStart } from './autostart';
import { initializeUpdater } from './updater';
import { AgentConfig } from '@/config/AgentConfig';
import { isDesktopRuntimeRelayEnabled } from '@/desktop-runtime/featureFlag';
import { invoke } from '@tauri-apps/api/core';

/**
 * Initialize the desktop-specific services
 *
 * This is called from desktop/ui/main.ts after the agent bootstrap is initialized.
 * It sets up native features like system tray and global hotkeys.
 */
async function initializeDesktop(): Promise<void> {
  console.log('[Desktop] Initializing desktop services...');

  // Initialize system tray (non-critical, catch errors)
  try {
    await initializeTray();
    console.log('[Desktop] System tray initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize system tray (continuing):', error);
  }

  // Initialize global hotkeys (non-critical, catch errors)
  try {
    await initializeHotkeys();
    console.log('[Desktop] Global hotkeys initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize global hotkeys (continuing):', error);
  }

  // Initialize auto-start (non-critical, catch errors)
  try {
    const config = await AgentConfig.getInstance();
    const autoStartEnabled = config.getConfig().preferences?.autoStartEnabled ?? false;
    await initializeAutoStart(autoStartEnabled);
    console.log('[Desktop] Auto-start initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize auto-start (continuing):', error);
  }

  // Initialize auto-updater (non-critical, catch errors)
  try {
    await initializeUpdater();
    console.log('[Desktop] Auto-updater initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize auto-updater (continuing):', error);
  }

  console.log('[Desktop] Desktop services initialization complete');
}

/**
 * Cleanup on application shutdown
 */
async function cleanup(): Promise<void> {
  console.log('[Desktop] Shutting down...');

  // Shutdown the agent bootstrap
  try {
    if (isDesktopRuntimeRelayEnabled()) {
      await invoke('runtime_shutdown');
    } else {
      const { getDesktopAgentBootstrap } = await import('./agent/DesktopAgentBootstrap');
      const bootstrap = getDesktopAgentBootstrap();
      await bootstrap.shutdown();
    }
  } catch (error) {
    console.error('[Desktop] Failed to shutdown agent bootstrap:', error);
  }
}

// Handle window unload
window.addEventListener('beforeunload', () => {
  cleanup();
});

export { initializeDesktop, cleanup };
