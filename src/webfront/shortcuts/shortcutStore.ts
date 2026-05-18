import { writable } from 'svelte/store';
import { AgentConfig } from '@/config/AgentConfig';
import {
  detectShortcutPlatform,
  getEffectiveShortcutBindings,
  type ParsedShortcutBinding,
  type ShortcutPlatform,
  type ShortcutValidationIssue,
} from '@/core/shortcuts';

export interface ShortcutStoreState {
  bindings: ParsedShortcutBinding[];
  warnings: ShortcutValidationIssue[];
  platform: ShortcutPlatform;
  loaded: boolean;
}

function loadFromPreferences(value: unknown): ShortcutStoreState {
  const platform = detectShortcutPlatform();
  const { bindings, warnings } = getEffectiveShortcutBindings(value, { platform });
  return { bindings, warnings, platform, loaded: true };
}

export const shortcutStore = writable<ShortcutStoreState>(loadFromPreferences(undefined));

export async function reloadShortcutStore(): Promise<void> {
  try {
    const config = await AgentConfig.getInstance();
    const shortcuts = config.getConfig().preferences?.shortcuts;
    shortcutStore.set(loadFromPreferences(shortcuts));
  } catch (error) {
    console.warn('[Shortcuts] Failed to load shortcut preferences:', error);
    shortcutStore.set(loadFromPreferences(undefined));
  }
}
