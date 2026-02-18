/**
 * Auto-Start Service
 *
 * Manages OS-level auto-start registration for the desktop application.
 * Uses Tauri's autostart plugin to register/unregister the app to start on OS login.
 *
 * @module desktop/autostart
 */

// @ts-ignore - Tauri plugin, types may not be available in all build modes
import { enable, disable, isEnabled } from '@tauri-apps/plugin-autostart';

/**
 * Sync OS-level autostart state with the desired preference.
 * Only changes OS state when it differs from the desired state.
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
