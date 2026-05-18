import type { ShortcutAction } from './types';

export const EXTENSION_COMMAND_ACTIONS: Record<string, ShortcutAction> = {
  'toggle-sidepanel': 'app:toggleWindow',
  'quick-action': 'app:quickAction',
};

export const EXTENSION_COMMAND_DEFAULTS: Record<string, string> = {
  'toggle-sidepanel': 'Alt+Shift+C',
  'quick-action': 'Alt+Shift+Q',
};

export function getActionForExtensionCommand(commandName: string): ShortcutAction | undefined {
  return EXTENSION_COMMAND_ACTIONS[commandName];
}
