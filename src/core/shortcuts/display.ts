import { getBindingForAction } from './resolver';
import type { ParsedKeystroke, ParsedShortcutBinding, ShortcutAction, ShortcutContext, ShortcutPlatform } from './types';

const DISPLAY_KEYS: Record<string, string> = {
  escape: 'Esc',
  enter: 'Enter',
  space: 'Space',
  tab: 'Tab',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  backspace: 'Backspace',
  delete: 'Delete',
  home: 'Home',
  end: 'End',
};

export function formatKeystroke(keystroke: ParsedKeystroke, platform: ShortcutPlatform = 'linux'): string {
  const parts: string[] = [];
  if (keystroke.ctrl) parts.push(platform === 'macos' ? 'Control' : 'Ctrl');
  if (keystroke.alt) parts.push(platform === 'macos' ? 'Option' : 'Alt');
  if (keystroke.shift) parts.push('Shift');
  if (keystroke.meta) parts.push(platform === 'macos' ? 'Command' : 'Meta');
  parts.push(DISPLAY_KEYS[keystroke.key] ?? keystroke.key.toUpperCase());
  return parts.join('+');
}

export function formatShortcut(
  shortcut: ParsedKeystroke[],
  platform: ShortcutPlatform = 'linux',
): string {
  return shortcut.map((keystroke) => formatKeystroke(keystroke, platform)).join(' ');
}

export function formatBinding(
  binding: ParsedShortcutBinding | undefined,
  platform: ShortcutPlatform = 'linux',
): string | undefined {
  return binding ? formatShortcut(binding.keystrokes, platform) : undefined;
}

export function getShortcutDisplay(
  action: ShortcutAction,
  context: ShortcutContext,
  bindings: ParsedShortcutBinding[],
  platform: ShortcutPlatform = 'linux',
  fallback?: string,
): string {
  return formatBinding(getBindingForAction(action, context, bindings), platform) ?? fallback ?? '';
}
