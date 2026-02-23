/**
 * Welcome page main entry point
 */

import './welcome.css';
import Welcome from './Welcome.svelte';
import { initLocale } from '../webfront/lib/i18n';
import { AgentConfig } from '../config/AgentConfig';

// Initialize locale before mounting app
async function init() {
  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    initLocale(agentConfig.preferences?.language);
  } catch (error) {
    console.warn('[welcome] Failed to load locale, using default:', error);
    initLocale();
  }

  // Mount app after locale is initialized
  const app = new Welcome({
    target: document.getElementById('app')!,
  });

  return app;
}

export default init();
