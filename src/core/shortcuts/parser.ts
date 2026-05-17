import type {
  ParsedKeystroke,
  ParsedShortcutBinding,
  ShortcutBindingBlock,
  ShortcutPlatform,
} from './types';

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  pageup: 'pageup',
  pagedown: 'pagedown',
  pgup: 'pageup',
  pgdn: 'pagedown',
  del: 'delete',
  ' ': 'space',
};

function splitKeystroke(input: string): string[] {
  if (input === ' ') return ['space'];
  const trimmed = input.trim();
  if (trimmed.endsWith('++')) {
    return [...trimmed.slice(0, -2).split('+').filter(Boolean), '+'];
  }
  return trimmed.split('+');
}

export function normalizeKeyName(key: string): string {
  const lower = key.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
}

export function parseKeystroke(input: string, platform: ShortcutPlatform = 'linux'): ParsedKeystroke {
  const parts = splitKeystroke(input);
  const result: ParsedKeystroke = {
    key: '',
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  };

  for (const raw of parts) {
    const part = raw.trim().toLowerCase();
    switch (part) {
      case '':
        throw new Error(`Empty key part in "${input}"`);
      case 'ctrl':
      case 'control':
        result.ctrl = true;
        break;
      case 'alt':
      case 'opt':
      case 'option':
        result.alt = true;
        break;
      case 'shift':
        result.shift = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
      case 'super':
      case 'win':
        result.meta = true;
        break;
      case 'mod':
        if (platform === 'macos') {
          result.meta = true;
        } else {
          result.ctrl = true;
        }
        break;
      default:
        if (result.key) {
          throw new Error(`Multiple key values in "${input}"`);
        }
        result.key = normalizeKeyName(part);
        break;
    }
  }

  if (!result.key) {
    throw new Error(`Missing key in "${input}"`);
  }

  return result;
}

export function parseShortcut(input: string, platform: ShortcutPlatform = 'linux'): ParsedKeystroke[] {
  if (input === ' ') return [parseKeystroke('space', platform)];
  return input.trim().split(/\s+/).map((part) => parseKeystroke(part, platform));
}

export function keystrokeEquals(a: ParsedKeystroke, b: ParsedKeystroke): boolean {
  return (
    a.key === b.key &&
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta
  );
}

export function keystrokeToCanonicalString(keystroke: ParsedKeystroke): string {
  const parts: string[] = [];
  if (keystroke.ctrl) parts.push('ctrl');
  if (keystroke.alt) parts.push('alt');
  if (keystroke.shift) parts.push('shift');
  if (keystroke.meta) parts.push('meta');
  parts.push(keystroke.key);
  return parts.join('+');
}

export function shortcutToCanonicalString(shortcut: ParsedKeystroke[]): string {
  return shortcut.map(keystrokeToCanonicalString).join(' ');
}

export function parseBindingBlocks(
  blocks: ShortcutBindingBlock[],
  options: {
    platform?: ShortcutPlatform;
    source?: 'default' | 'user';
    skipInvalid?: boolean;
  } = {},
): ParsedShortcutBinding[] {
  const platform = options.platform ?? 'linux';
  const source = options.source ?? 'default';
  const parsed: ParsedShortcutBinding[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object' || !block.bindings || typeof block.bindings !== 'object') {
      if (!options.skipInvalid) throw new Error('Shortcut binding block must have a bindings object.');
      continue;
    }

    for (const [shortcut, action] of Object.entries(block.bindings)) {
      try {
        parsed.push({
          context: block.context,
          action,
          keystrokes: parseShortcut(shortcut, platform),
          source,
          original: shortcut,
        });
      } catch (error) {
        if (!options.skipInvalid) throw error;
      }
    }
  }

  return parsed;
}
