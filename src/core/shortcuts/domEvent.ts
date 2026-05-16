import { CONTEXT_PRIORITY } from './catalog';
import { normalizeKeyName } from './parser';
import type { ParsedKeystroke, ShortcutContext } from './types';

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

export function keyboardEventToKeystroke(event: KeyboardEvent): ParsedKeystroke | null {
  if (event.isComposing || MODIFIER_KEYS.has(event.key)) {
    return null;
  }

  let key = event.key;
  if (key === ' ') key = 'space';
  if (key.length === 1) key = key.toLowerCase();

  return {
    key: normalizeKeyName(key),
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  if (tag === 'textarea') return true;
  if (tag !== 'input') return false;
  const input = target as HTMLInputElement;
  const type = (input.type || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'color', 'range'].includes(type);
}

function hasSpecificContext(activeContexts: ShortcutContext[]): boolean {
  return activeContexts.some((context) => context !== 'Global' && CONTEXT_PRIORITY[context] > 0);
}

export function shouldResolveInAppShortcut(
  event: KeyboardEvent,
  activeContexts: ShortcutContext[],
): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (!isEditableElement(event.target)) return true;

  if (hasSpecificContext(activeContexts)) return true;
  return event.ctrlKey || event.metaKey || event.altKey;
}
