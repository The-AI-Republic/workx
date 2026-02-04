/**
 * Desktop UI Entry Point
 *
 * Main entry point for the desktop UI. Reuses the sidepanel App.svelte
 * with desktop-specific styling and initialization.
 *
 * @module desktop/ui/main
 */

import './desktop.css';
import '../../extension/sidepanel/sidepanel.css';
import '../../extension/sidepanel/styles.css';
import App from '../../extension/sidepanel/App.svelte';
import { initializeDesktop } from '../main';

// Add desktop-mode and terminal-mode classes to body
document.body.classList.add('desktop-mode', 'terminal-mode');

/**
 * Initialize the desktop UI
 */
async function init() {
  console.log('[DesktopUI] Initializing...');

  try {
    // Initialize desktop services (tray, hotkeys, channels)
    await initializeDesktop();
  } catch (error) {
    console.warn('[DesktopUI] Failed to initialize desktop services:', error);
  }

  // Mount the main app
  const app = new App({
    target: document.getElementById('app')!,
  });

  console.log('[DesktopUI] App mounted');

  // Listen for focus input events from hotkeys
  window.addEventListener('browserx:focus-input', () => {
    // Dispatch to the app to focus the input field
    const inputElement = document.querySelector('textarea, input[type="text"]');
    if (inputElement instanceof HTMLElement) {
      inputElement.focus();
    }
  });

  // Listen for quick action events from hotkeys
  window.addEventListener('browserx:quick-action', () => {
    // Dispatch to the app to open quick action menu
    // This could trigger a command palette or similar UI
    console.log('[DesktopUI] Quick action requested');
  });

  return app;
}

export default init();
