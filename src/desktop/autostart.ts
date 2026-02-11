/**
 * Auto-Start Service
 *
 * Manages OS-level auto-start registration for the desktop application.
 * Uses Tauri's autostart plugin to register/unregister the app to start on OS login.
 *
 * @module desktop/autostart
 */

import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

/**
 * Initialize auto-start based on user preference.
 * Syncs the OS-level autostart state with the stored preference.
 *
 * @param shouldBeEnabled - Whether autostart should be enabled (from user preferences)
 */
export async function initializeAutoStart(shouldBeEnabled: boolean): Promise<void> {
  try {
    const currentlyEnabled = await isEnabled();

    if (shouldBeEnabled && !currentlyEnabled) {
      await enable();
      console.log('[AutoStart] Enabled auto-start on login');
    } else if (!shouldBeEnabled && currentlyEnabled) {
      await disable();
      console.log('[AutoStart] Disabled auto-start on login');
    } else {
      console.log(`[AutoStart] Auto-start already ${currentlyEnabled ? 'enabled' : 'disabled'}`);
    }
  } catch (error) {
    console.error('[AutoStart] Failed to initialize auto-start:', error);
  }
}

/**
 * Enable auto-start on OS login
 */
export async function enableAutoStart(): Promise<void> {
  try {
    await enable();
    console.log('[AutoStart] Enabled auto-start on login');
  } catch (error) {
    console.error('[AutoStart] Failed to enable auto-start:', error);
  }
}

/**
 * Disable auto-start on OS login
 */
export async function disableAutoStart(): Promise<void> {
  try {
    await disable();
    console.log('[AutoStart] Disabled auto-start on login');
  } catch (error) {
    console.error('[AutoStart] Failed to disable auto-start:', error);
  }
}
