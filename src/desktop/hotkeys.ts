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
import { AgentConfig } from '@/config/AgentConfig';
import {
  detectShortcutPlatform,
  getEffectiveBindingsForContext,
  getEffectiveShortcutBindings,
  toTauriAccelerator,
  type ShortcutAction,
} from '@/core/shortcuts';

/**
 * Currently registered hotkeys
 */
const registeredHotkeys = new Set<string>();

/**
 * Hotkey handlers
 */
const hotkeyHandlers: Map<string, () => void | Promise<void>> = new Map();

export interface DesktopHotkeyDiagnostics {
  registered: string[];
  skipped: Array<{ shortcut: string; reason: string }>;
  failures: Array<{ shortcut: string; error: string }>;
}

const diagnostics: DesktopHotkeyDiagnostics = {
  registered: [],
  skipped: [],
  failures: [],
};

async function showAndFocusWindow(): Promise<void> {
  const appWindow = getCurrentWindow();
  const visible = await appWindow.isVisible();
  if (!visible) {
    await appWindow.show();
  }
  await appWindow.setFocus();
}

const DESKTOP_SHORTCUT_HANDLERS: Partial<Record<ShortcutAction, () => void | Promise<void>>> = {
  'app:toggleWindow': async () => {
    console.log('[Hotkeys] Toggle window triggered');
    await toggleWindow();
  },
  'app:focusInput': async () => {
    console.log('[Hotkeys] Focus input triggered');
    await showAndFocusWindow();
    window.dispatchEvent(new CustomEvent('workx:focus-input'));
  },
  'app:quickAction': async () => {
    console.log('[Hotkeys] Quick action triggered');
    await showAndFocusWindow();
    window.dispatchEvent(new CustomEvent('workx:quick-action'));
  },
};

/**
 * Initialize global hotkeys
 */
export async function initializeHotkeys(): Promise<void> {
  console.log('[Hotkeys] Initializing global hotkeys...');

  diagnostics.registered = [];
  diagnostics.skipped = [];
  diagnostics.failures = [];

  const config = await AgentConfig.getInstance();
  const { bindings } = getEffectiveShortcutBindings(config.getConfig().preferences?.shortcuts, {
    platform: detectShortcutPlatform(),
  });
  const desktopBindings = getEffectiveBindingsForContext('DesktopGlobal', bindings)
    .filter((binding) => binding.action);

  for (const binding of desktopBindings) {
    const shortcut = toTauriAccelerator(binding, detectShortcutPlatform());
    const action = binding.action;
    if (!shortcut || !action) {
      diagnostics.skipped.push({ shortcut: binding.original, reason: 'Unsupported desktop accelerator' });
      continue;
    }

    const handler = DESKTOP_SHORTCUT_HANDLERS[action];
    if (!handler) {
      diagnostics.skipped.push({ shortcut, reason: `No desktop handler for ${action}` });
      continue;
    }

    const registered = await registerHotkey(shortcut, handler);
    if (registered) {
      diagnostics.registered.push(shortcut);
    }
  }

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
      diagnostics.failures.push({ shortcut, error: 'Shortcut already registered' });
      return false;
    }

    await register(shortcut, handler);
    registeredHotkeys.add(shortcut);
    hotkeyHandlers.set(shortcut, handler);

    console.log(`[Hotkeys] Registered: ${shortcut}`);
    return true;
  } catch (error) {
    console.error(`[Hotkeys] Failed to register ${shortcut}:`, error);
    diagnostics.failures.push({
      shortcut,
      error: error instanceof Error ? error.message : String(error),
    });
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

export function getHotkeyDiagnostics(): DesktopHotkeyDiagnostics {
  return {
    registered: [...diagnostics.registered],
    skipped: [...diagnostics.skipped],
    failures: [...diagnostics.failures],
  };
}
