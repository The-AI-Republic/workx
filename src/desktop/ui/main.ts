/**
 * Desktop UI Entry Point (Tauri)
 *
 * Main entry point for the Tauri desktop UI. Reuses the sidepanel App.svelte
 * with desktop-specific styling and initialization.
 *
 * Architecture:
 * 1. Start the Rust-supervised desktop runtime sidecar through the relay transport
 * 2. Initialize desktop services (tray, hotkeys)
 * 3. Mount the UI app
 *
 * @module desktop/ui/main
 */

// IMPORTANT: Install polyfills FIRST before any other imports
// Chrome polyfill: compatibility for components that use chrome.* directly
import { installChromePolyfill } from '../polyfills/chromePolyfill';
installChromePolyfill();

import './desktop.css';
import '../../webfront/styles.css';
import { mount } from 'svelte';
import { initializeDesktop } from '../main';
import { getInitializedUIClient } from '@/core/messaging';
import { initLocale } from '../../webfront/lib/i18n';
import { AgentConfig } from '@/config/AgentConfig';
import { setModelCatalogLoader, type ModelCatalog } from '@/config/modelCatalog';
import { initializeConfigStorage, setCredentialStore } from '@/core/storage';
import { RuntimeRelayCredentialStore } from '@/webfront/credentials/RuntimeRelayCredentialStore';
import { markDesktopWelcomeCompleted, shouldShowDesktopWelcome } from './desktopWelcome';

// Add desktop-mode and terminal-mode classes to body
document.body.classList.add('desktop-mode', 'terminal-mode');

/**
 * Initialize the desktop UI
 */
async function init() {
  console.log('[Desktop] Initializing...');
  let showDesktopWelcome = false;

  // 0. Initialize config storage first (before anything else needs it)
  try {
    await initializeConfigStorage();
    console.log('[Desktop] Config storage initialized');
    showDesktopWelcome = await shouldShowDesktopWelcome();
  } catch (error) {
    console.warn('[Desktop] Failed to initialize config storage:', error);
    // Continue - will fall back to in-memory storage
  }

  // 0b. Install the credential store. The OS keychain lives in the sidecar, so
  // the webview relays credential ops over the runtime channel. Without this,
  // AgentConfig.getCredentials() is null and BYOK API keys are silently dropped.
  setCredentialStore(new RuntimeRelayCredentialStore());

  // 1. Subscribe to runtime lifecycle events before starting the sidecar so
  // the very first `runtime:ready` / `runtime:reconnecting` event flips the
  // UI status indicator (no race with relay startup).
  try {
    const { initializeRuntimeStatusStore } = await import('@/webfront/stores/runtimeStatusStore');
    await initializeRuntimeStatusStore();
  } catch (error) {
    console.warn('[Desktop] Runtime status store not initialized:', error);
  }

  // 1a. Start the sidecar runtime relay. The relay transport asks Rust to
  // supervise the Node runtime and routes all agent/channel traffic through it.
  try {
    const client = await getInitializedUIClient();
    setModelCatalogLoader(() =>
      client.serviceRequest<ModelCatalog>('models.getCatalog')
    );
    console.log('[Desktop] Sidecar runtime relay initialized');
  } catch (error) {
    console.error('[Desktop] Failed to initialize sidecar runtime relay:', error);
    // Continue anyway - the app will show connection/error state
  }

  // 1b. Route deeplinks from Rust to runtime services. The Rust supervisor
  // emits every `workx://...` URL as an `workx-deeplink` event; the WebView
  // is the only listener — it parses and routes by path.
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const maxConsumedSchedulerDeeplinks = 128;
    const consumedSchedulerDeeplinks = new Set<string>();
    await listen<string>('workx-deeplink', async (event) => {
      try {
        const url = new URL(event.payload);
        if (url.host === 'scheduler' && url.pathname === '/trigger') {
          const dedupeKey = url.toString();
          if (consumedSchedulerDeeplinks.has(dedupeKey)) return;
          consumedSchedulerDeeplinks.add(dedupeKey);
          if (consumedSchedulerDeeplinks.size > maxConsumedSchedulerDeeplinks) {
            const oldest = consumedSchedulerDeeplinks.values().next().value;
            if (oldest) consumedSchedulerDeeplinks.delete(oldest);
          }
          const jobId = url.searchParams.get('jobId');
          if (!jobId) {
            console.warn('[Desktop] Scheduler deeplink missing jobId:', event.payload);
            return;
          }
          const client = await getInitializedUIClient();
          await client.serviceRequest('scheduler.trigger', { jobId });
          console.log(`[Desktop] Scheduler deeplink routed to runtime for job ${jobId}`);
        }
      } catch (err) {
        console.warn('[Desktop] Failed to route deeplink:', err);
      }
    });
  } catch (error) {
    console.warn('[Desktop] Deeplink router not registered:', error);
  }

  // 2. Initialize desktop services (tray, hotkeys)
  try {
    await initializeDesktop();
    console.log('[Desktop] Desktop services initialized');
  } catch (error) {
    console.warn('[Desktop] Failed to initialize desktop services:', error);
  }

  // 4. Initialize locale
  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    initLocale(agentConfig.preferences?.language);
  } catch (error) {
    console.warn('[Desktop] Failed to load locale, using default:', error);
    initLocale();
  }

  // 5. Mount the main app
  // Import after platform adapters are installed. Some app modules initialize
  // AgentConfig as soon as their module graph is evaluated.
  const { default: App } = await import('../../webfront/App.svelte');
  const app = mount(App, {
    target: document.getElementById('app')!,
    props: {
      showDesktopWelcome,
      onDesktopWelcomeComplete: markDesktopWelcomeCompleted,
    },
  });

  console.log('[Desktop] App mounted');

  // Listen for focus input events from hotkeys
  window.addEventListener('workx:focus-input', () => {
    const inputElement = document.querySelector('textarea, input[type="text"]');
    if (inputElement instanceof HTMLElement) {
      inputElement.focus();
    }
  });

  // Listen for quick action events from hotkeys
  window.addEventListener('workx:quick-action', () => {
    console.log('[Desktop] Quick action requested');
  });

  return app;
}

export default init();
