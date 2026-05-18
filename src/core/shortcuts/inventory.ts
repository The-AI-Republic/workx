import { SHORTCUT_ACTION_META } from './catalog';
import { getEffectiveShortcutBindings } from './merge';
import type { ShortcutPlatform } from './types';

export function getShortcutInventory(userValue: unknown, platform: ShortcutPlatform = 'linux') {
  const { bindings, warnings } = getEffectiveShortcutBindings(userValue, { platform });
  return {
    actions: Object.values(SHORTCUT_ACTION_META),
    bindings,
    warnings,
  };
}
