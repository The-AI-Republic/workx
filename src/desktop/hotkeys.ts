/**
 * Global Hotkey Support
 *
 * Manages global keyboard shortcuts for the desktop application.
 * Uses Tauri's globalShortcut plugin to register system-wide hotkeys.
 *
 * @module desktop/hotkeys
 */

import { register, unregister, isRegistered } from '@tauri-apps/plugin-global-shortcut';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toggleWindow } from './tray';

/**
 * Default hotkey bindings
 */
const DEFAULT_HOTKEYS = {
  /** Toggle main window visibility */
  toggleWindow: 'CommandOrControl+Shift+B',
  /** Focus input (when window visible) */
  focusInput: 'CommandOrControl+Shift+I',
  /** Quick action menu */
  quickAction: 'CommandOrControl+Shift+K',
} as const;

/**
 * Currently registered hotkeys
 */
const registeredHotkeys = new Set<string>();

/**
 * Hotkey handlers
 */
const hotkeyHandlers: Map<string, () => void | Promise<void>> = new Map();

/**
 * Initialize global hotkeys
 */
export async function initializeHotkeys(): Promise<void> {
  console.log('[Hotkeys] Initializing global hotkeys...');

  const appWindow = getCurrentWindow();

  // Register toggle window hotkey
  await registerHotkey(DEFAULT_HOTKEYS.toggleWindow, async () => {
    console.log('[Hotkeys] Toggle window triggered');
    await toggleWindow();
  });

  // Register focus input hotkey
  await registerHotkey(DEFAULT_HOTKEYS.focusInput, async () => {
    console.log('[Hotkeys] Focus input triggered');
    const visible = await appWindow.isVisible();
    if (!visible) {
      await appWindow.show();
      await appWindow.setFocus();
    }
    // Emit an event to focus the input field
    window.dispatchEvent(new CustomEvent('pi:focus-input'));
  });

  // Register quick action hotkey
  await registerHotkey(DEFAULT_HOTKEYS.quickAction, async () => {
    console.log('[Hotkeys] Quick action triggered');
    const visible = await appWindow.isVisible();
    if (!visible) {
      await appWindow.show();
      await appWindow.setFocus();
    }
    // Emit an event to open quick action menu
    window.dispatchEvent(new CustomEvent('pi:quick-action'));
  });

  console.log('[Hotkeys] Global hotkeys initialized');
}

/**
 * Register a global hotkey
 *
 * @param shortcut - Key combination (e.g., 'CommandOrControl+Shift+B')
 * @param handler - Function to call when hotkey is pressed
 */
export async function registerHotkey(
  shortcut: string,
  handler: () => void | Promise<void>
): Promise<boolean> {
  try {
    // Check if already registered
    const alreadyRegistered = await isRegistered(shortcut);
    if (alreadyRegistered) {
      console.warn(`[Hotkeys] Shortcut ${shortcut} already registered`);
      return false;
    }

    await register(shortcut, handler);
    registeredHotkeys.add(shortcut);
    hotkeyHandlers.set(shortcut, handler);

    console.log(`[Hotkeys] Registered: ${shortcut}`);
    return true;
  } catch (error) {
    console.error(`[Hotkeys] Failed to register ${shortcut}:`, error);
    return false;
  }
}

/**
 * Unregister a global hotkey
 *
 * @param shortcut - Key combination to unregister
 */
export async function unregisterHotkey(shortcut: string): Promise<boolean> {
  try {
    if (!registeredHotkeys.has(shortcut)) {
      return false;
    }

    await unregister(shortcut);
    registeredHotkeys.delete(shortcut);
    hotkeyHandlers.delete(shortcut);

    console.log(`[Hotkeys] Unregistered: ${shortcut}`);
    return true;
  } catch (error) {
    console.error(`[Hotkeys] Failed to unregister ${shortcut}:`, error);
    return false;
  }
}

/**
 * Unregister all hotkeys
 */
export async function unregisterAllHotkeys(): Promise<void> {
  for (const shortcut of registeredHotkeys) {
    try {
      await unregister(shortcut);
    } catch (error) {
      console.error(`[Hotkeys] Failed to unregister ${shortcut}:`, error);
    }
  }

  registeredHotkeys.clear();
  hotkeyHandlers.clear();

  console.log('[Hotkeys] All hotkeys unregistered');
}

/**
 * Get list of registered hotkeys
 */
export function getRegisteredHotkeys(): string[] {
  return Array.from(registeredHotkeys);
}

/**
 * Check if a hotkey is registered
 *
 * @param shortcut - Key combination to check
 */
export function isHotkeyRegistered(shortcut: string): boolean {
  return registeredHotkeys.has(shortcut);
}
