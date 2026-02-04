/**
 * System Tray Management
 *
 * Manages the system tray icon and menu for the desktop application.
 * Tray menu items are defined in Rust (tauri/src/main.rs), this module
 * handles the frontend interaction with the tray.
 *
 * @module desktop/tray
 */

import { invoke } from '@tauri-apps/api/tauri';
import { appWindow } from '@tauri-apps/api/window';

/**
 * Tray state
 */
let isMinimizedToTray = false;

/**
 * Initialize system tray behavior
 *
 * Sets up event handlers for tray-related actions.
 */
export async function initializeTray(): Promise<void> {
  console.log('[Tray] Initializing system tray...');

  // Handle window close to minimize to tray instead
  appWindow.onCloseRequested(async (event) => {
    // Prevent default close, minimize to tray instead
    event.preventDefault();
    await minimizeToTray();
  });

  console.log('[Tray] System tray initialized');
}

/**
 * Minimize the window to the system tray
 */
export async function minimizeToTray(): Promise<void> {
  console.log('[Tray] Minimizing to tray...');
  await appWindow.hide();
  isMinimizedToTray = true;
}

/**
 * Restore the window from the system tray
 */
export async function restoreFromTray(): Promise<void> {
  console.log('[Tray] Restoring from tray...');
  await appWindow.show();
  await appWindow.setFocus();
  isMinimizedToTray = false;
}

/**
 * Toggle window visibility
 */
export async function toggleWindow(): Promise<void> {
  const visible = await appWindow.isVisible();
  if (visible) {
    await minimizeToTray();
  } else {
    await restoreFromTray();
  }
}

/**
 * Check if the window is minimized to tray
 */
export function isInTray(): boolean {
  return isMinimizedToTray;
}

/**
 * Update tray tooltip
 *
 * @param status - Status message to show in tooltip
 */
export async function updateTrayTooltip(status: string): Promise<void> {
  // Note: Tray tooltip updates require Rust-side implementation
  // This is a placeholder for future enhancement
  console.log('[Tray] Status:', status);
}

/**
 * Show a notification from the tray
 *
 * @param title - Notification title
 * @param body - Notification body
 */
export async function showTrayNotification(title: string, body: string): Promise<void> {
  // Use the Tauri notification API if available
  try {
    const { sendNotification, isPermissionGranted, requestPermission } =
      await import('@tauri-apps/api/notification');

    let permissionGranted = await isPermissionGranted();
    if (!permissionGranted) {
      const permission = await requestPermission();
      permissionGranted = permission === 'granted';
    }

    if (permissionGranted) {
      sendNotification({ title, body });
    }
  } catch (error) {
    console.warn('[Tray] Notifications not available:', error);
  }
}
