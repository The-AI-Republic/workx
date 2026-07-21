/**
 * Side panel main entry point (Chrome Extension)
 *
 * This is the entry point for the Chrome extension sidepanel.
 * It initializes platform-specific services and mounts the app.
 */

import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initLocale } from './lib/i18n';
import { AgentConfig } from '@/config/AgentConfig';
import { initializeConfigStorage, setCredentialStore } from '@/core/storage';
import { RuntimeRelayCredentialStore } from './credentials/RuntimeRelayCredentialStore';

// Add terminal-mode class to body for terminal styling
document.body.classList.add('terminal-mode');

/**
 * Initialize the extension sidepanel
 */
async function init() {
  console.log('[Extension] Initializing sidepanel...');

  // Initialize config storage (needed for components that call getConfigStorage())
  try {
    await initializeConfigStorage();
  } catch (error) {
    console.warn('[Extension] Failed to initialize config storage:', error);
  }

  // Credentials are background-owned. The rendered side panel can relay only
  // the model-provider namespace allowed by credentials.* services.
  setCredentialStore(new RuntimeRelayCredentialStore());

  // Initialize locale
  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    initLocale(agentConfig.preferences?.language);
  } catch (error) {
    console.warn('[Extension] Failed to load locale, using default:', error);
    initLocale();
  }

  // Mount app after services are initialized
  const app = mount(App, {
    target: document.getElementById('app')!,
  });

  console.log('[Extension] Sidepanel initialized');
  return app;
}

export default init();
