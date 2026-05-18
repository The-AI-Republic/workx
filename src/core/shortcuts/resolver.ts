import { keystrokeEquals, keystrokeToCanonicalString } from './parser';
import type { ParsedKeystroke, ParsedShortcutBinding, ShortcutAction, ShortcutContext } from './types';

export type ShortcutResolveResult =
  | { type: 'match'; action: ShortcutAction; binding: ParsedShortcutBinding }
  | { type: 'unbound'; binding: ParsedShortcutBinding }
  | { type: 'none' };

export function resolveShortcut(
  key: ParsedKeystroke,
  activeContexts: ShortcutContext[],
  bindings: ParsedShortcutBinding[],
): ShortcutResolveResult {
  for (const context of activeContexts) {
    let winner: ParsedShortcutBinding | null = null;
    for (const binding of bindings) {
      if (binding.context !== context || binding.keystrokes.length !== 1) continue;
      const first = binding.keystrokes[0];
      if (first && keystrokeEquals(first, key)) {
        winner = binding;
      }
    }
    if (!winner) continue;
    if (winner.action === null) {
      return { type: 'unbound', binding: winner };
    }
    return { type: 'match', action: winner.action, binding: winner };
  }

  return { type: 'none' };
}

export function getBindingForAction(
  action: ShortcutAction,
  context: ShortcutContext,
  bindings: ParsedShortcutBinding[],
): ParsedShortcutBinding | undefined {
  // Mirror resolveShortcut: for a single-keystroke binding the last entry in
  // array order wins, so a later `null` (unbind) or rebind supersedes an
  // earlier default. Build the effective per-keystroke binding first, then
  // report the keystroke that still maps to `action`.
  const effective = getEffectiveBindingsForContext(context, bindings);

  let result: ParsedShortcutBinding | undefined;
  for (const binding of effective.values()) {
    if (binding.action === action) {
      result = binding;
    }
  }
  return result;
}

export function getEffectiveBindingsForContext(
  context: ShortcutContext,
  bindings: ParsedShortcutBinding[],
): ParsedShortcutBinding[] {
  const effective = new Map<string, ParsedShortcutBinding>();
  for (const binding of bindings) {
    if (binding.context !== context || binding.keystrokes.length !== 1) continue;
    const first = binding.keystrokes[0];
    if (!first) continue;
    effective.set(keystrokeToCanonicalString(first), binding);
  }
  return Array.from(effective.values());
}
