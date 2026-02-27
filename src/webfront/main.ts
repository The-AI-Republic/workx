/**
 * Side panel main entry point (Chrome Extension)
 *
 * This is the entry point for the Chrome extension sidepanel.
 * It initializes platform-specific services and mounts the app.
 */

import './styles.css';
import App from './App.svelte';
import { initLocale } from './lib/i18n';
import { AgentConfig } from '@/config/AgentConfig';
import { initializeMessaging, ChromeMessageService } from '@/core/messaging';

// Add terminal-mode class to body for terminal styling
document.body.classList.add('terminal-mode');

/**
 * Initialize the extension sidepanel
 */
async function init() {
  console.log('[Extension] Initializing sidepanel...');

  // Initialize messaging service (Chrome-specific)
  try {
    const messageService = new ChromeMessageService();
    await initializeMessaging(messageService);
    console.log('[Extension] Messaging service initialized');
  } catch (error) {
    console.error('[Extension] Failed to initialize messaging service:', error);
    // Continue anyway - the app will show connection error state
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
  const app = new App({
    target: document.getElementById('app')!,
  });

  console.log('[Extension] Sidepanel initialized');
  return app;
}

export default init();
