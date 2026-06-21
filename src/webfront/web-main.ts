/**
 * Web UI Entry Point (Server Mode)
 *
 * Entry point for the web-served SPA that connects to the
 * WorkX Server via WebSocket.
 *
 * @module webfront/web-main
 */

import './styles.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { initLocale } from './lib/i18n';
import { AgentConfig } from '@/config/AgentConfig';
import { initializeConfigStorage } from '@/core/storage';

document.body.classList.add('terminal-mode');

async function init() {
  console.log('[Web] Initializing...');

  try {
    await initializeConfigStorage();
  } catch (error) {
    console.warn('[Web] Failed to initialize config storage:', error);
  }

  try {
    const config = await AgentConfig.getInstance();
    const agentConfig = config.getConfig();
    initLocale(agentConfig.preferences?.language);
  } catch (error) {
    console.warn('[Web] Failed to load locale, using default:', error);
    initLocale();
  }

  const app = mount(App, {
    target: document.getElementById('app')!,
  });

  console.log('[Web] App mounted');
  return app;
}

export default init();
