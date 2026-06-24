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
import { initializeConfigStorage, initializeCredentialStore } from '@/core/storage';

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

  // The side panel has its own JS context, separate from the service worker.
  // AgentConfig writes BYOK keys through this singleton, so initialize it here
  // before settings code creates its local AgentConfig instance.
  try {
    await initializeCredentialStore();
  } catch (error) {
    console.warn('[Extension] Failed to initialize credential storage:', error);
  }

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
