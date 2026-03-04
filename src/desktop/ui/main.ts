/**
 * Desktop UI Entry Point (Tauri)
 *
 * Main entry point for the Tauri desktop UI. Reuses the sidepanel App.svelte
 * with desktop-specific styling and initialization.
 *
 * Architecture:
 * 1. Initialize agent bootstrap (RepublicAgent + TauriChannel + ChannelManager)
 * 2. Initialize messaging service (TauriMessageService for UI communication)
 * 3. Initialize desktop services (tray, hotkeys)
 * 4. Mount the UI app
 *
 * @module desktop/ui/main
 */

// IMPORTANT: Install polyfills FIRST before any other imports
// Chrome polyfill: compatibility for components that use chrome.* directly
// Fetch proxy: routes external HTTP through Rust to bypass CORS
import { installChromePolyfill } from '../polyfills/chromePolyfill';
import { installFetchProxy } from '../polyfills/fetchProxy';
installChromePolyfill();
installFetchProxy();

import './desktop.css';
import '../../webfront/styles.css';
import { mount } from 'svelte';
import App from '../../webfront/App.svelte';
import { initializeDesktop } from '../main';
import { initializeMessaging, TauriMessageService } from '@/core/messaging';
import { initializeDesktopAgent } from '../agent/DesktopAgentBootstrap';
import { initLocale } from '../../webfront/lib/i18n';
import { AgentConfig } from '@/config/AgentConfig';
import { initializeConfigStorage, initializeCredentialStore } from '@/core/storage';
import { zoomStore } from '../../webfront/stores/zoomStore';

// Add desktop-mode and terminal-mode classes to body
document.body.classList.add('desktop-mode', 'terminal-mode');

/**
 * Initialize the desktop UI
 */
async function init() {
  console.log('[Desktop] Initializing...');

  // 0. Initialize config storage first (before anything else needs it)
  try {
    await initializeConfigStorage();
    console.log('[Desktop] Config storage initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize config storage:', error);
    // Continue - will fall back to in-memory storage
  }

  // 0.5. Initialize credential store (for secure API key storage)
  try {
    await initializeCredentialStore();
    console.log('[Desktop] Credential store initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize credential store:', error);
  }

  // 1. Initialize the agent bootstrap first
  // This creates RepublicAgent + TauriChannel + ChannelManager
  try {
    await initializeDesktopAgent();
    console.log('[Desktop] Agent bootstrap initialized');
  } catch (error) {
    console.error('[Desktop] Failed to initialize agent bootstrap:', error);
    // Continue anyway - the app will show error state
  }

  // 2. Initialize messaging service (Tauri-specific)
  // This provides the UI-side abstraction for sending messages to the agent
  try {
    const messageService = new TauriMessageService();
    await initializeMessaging(messageService);
    console.log('[Desktop] Messaging service initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize messaging service:', error);
    // Continue anyway - the app will show connection error state
  }

  // 3. Initialize desktop services (tray, hotkeys)
  try {
    await initializeDesktop();
    console.log('[Desktop] Desktop services initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize desktop services:', error);
  }

  // 4. Initialize locale and zoom
  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    initLocale(agentConfig.preferences?.language);
    zoomStore.initialize(agentConfig.preferences?.zoomLevel);
  } catch (error) {
    console.warn('[Desktop] Failed to load locale/zoom, using defaults:', error);
    initLocale();
  }

  // 5. Mount the main app
  const app = mount(App, {
    target: document.getElementById('app')!,
  });

  console.log('[Desktop] App mounted');

  // Listen for focus input events from hotkeys
  window.addEventListener('applepi:focus-input', () => {
    const inputElement = document.querySelector('textarea, input[type="text"]');
    if (inputElement instanceof HTMLElement) {
      inputElement.focus();
    }
  });

  // Listen for quick action events from hotkeys
  window.addEventListener('applepi:quick-action', () => {
    console.log('[Desktop] Quick action requested');
  });

  return app;
}

export default init();
