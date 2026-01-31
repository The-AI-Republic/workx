/**
 * Side panel main entry point
 */

import './sidepanel.css';
import './styles.css';
import App from './App.svelte';
import { initLocale } from './lib/i18n';
import { AgentConfig } from '../../open_source/src/config/AgentConfig';

// Add terminal-mode class to body for terminal styling
document.body.classList.add('terminal-mode');

// Initialize locale before mounting app
async function init() {
  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    initLocale(agentConfig.preferences?.language);
  } catch (error) {
    console.warn('[main] Failed to load locale, using default:', error);
    initLocale();
  }

  // Mount app after locale is initialized
  const app = new App({
    target: document.getElementById('app')!,
  });

  return app;
}

export default init();
