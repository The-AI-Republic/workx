import { formatShortcut } from './display';
import type { ParsedShortcutBinding, ShortcutPlatform } from './types';

export function detectShortcutPlatform(): ShortcutPlatform {
  if (typeof navigator === 'undefined') return 'linux';
  const platform = navigator.platform.toLowerCase();
  if (platform.includes('mac')) return 'macos';
  if (platform.includes('win')) return 'windows';
  return 'linux';
}

export function toTauriAccelerator(binding: ParsedShortcutBinding, platform: ShortcutPlatform = 'linux'): string | null {
  if (binding.keystrokes.length !== 1) return null;
  const key = binding.keystrokes[0];
  if (!key) return null;
  const parts: string[] = [];
  if (key.ctrl && key.meta) return null;
  if (key.ctrl || key.meta) {
    parts.push(key.meta && platform === 'macos' ? 'Command' : 'CommandOrControl');
  }
  if (key.alt) parts.push('Alt');
  if (key.shift) parts.push('Shift');
  parts.push(key.key.length === 1 ? key.key.toUpperCase() : key.key);
  return parts.join('+');
}

export function formatChromeShortcut(binding: ParsedShortcutBinding, platform: ShortcutPlatform = 'linux'): string {
  return formatShortcut(binding.keystrokes, platform);
}
