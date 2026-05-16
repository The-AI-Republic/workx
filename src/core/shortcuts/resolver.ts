import { keystrokeEquals } from './parser';
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
  for (let index = bindings.length - 1; index >= 0; index--) {
    const binding = bindings[index];
    if (binding.context === context && binding.action === action) {
      return binding;
    }
  }
  return undefined;
}
