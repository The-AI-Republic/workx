/**
 * InputDispatcher — correct CDP input synthesis.
 *
 * Stateless helpers that emit `Input.*` CDP events with the fields real
 * browsers expect: proper `code`/`windowsVirtualKeyCode`/`text` for keys, and a
 * `mouseMoved → mousePressed → mouseReleased` sequence with correct `buttons`
 * bookkeeping for clicks. Takes a `send` function so it works against any
 * target (tab or, later, an OOPIF).
 *
 * @module extension/tools/input/InputDispatcher
 */

import { getKeyDefinition } from './keyDefinitions';

/** Sends a CDP command; satisfied by DomService/CoordinateActionService senders. */
export type CdpSend = <T = unknown>(method: string, params: Record<string, unknown>) => Promise<T>;

/** CDP modifier bitmask. */
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** CDP mouse `buttons` bitmask (held buttons). */
const BUTTON_MASK: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

export type MouseButton = 'left' | 'right' | 'middle';

export interface ModifierFlags {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

export interface DispatchKeyOptions {
  /** CDP modifier bitmask (see {@link encodeModifiers}). */
  modifiers?: number;
}

export interface ClickOptions {
  button?: MouseButton;
  clickCount?: number;
  /** CDP modifier bitmask. */
  modifiers?: number;
}

/** Encode modifier flags to the CDP bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). */
export function encodeModifiers(flags?: ModifierFlags): number {
  if (!flags) return 0;
  let bits = 0;
  if (flags.alt) bits |= MODIFIER_BITS.alt;
  if (flags.ctrl) bits |= MODIFIER_BITS.ctrl;
  if (flags.meta) bits |= MODIFIER_BITS.meta;
  if (flags.shift) bits |= MODIFIER_BITS.shift;
  return bits;
}

/**
 * Dispatch a single key press (keyDown/rawKeyDown + keyUp) with correct
 * `code`, `windowsVirtualKeyCode`, and `text` for printable keys.
 */
export async function dispatchKey(
  send: CdpSend,
  key: string,
  options?: DispatchKeyOptions
): Promise<void> {
  const def = getKeyDefinition(key);
  let modifiers = options?.modifiers ?? 0;

  let text = def.text;
  // With Shift held, a letter produces its uppercase character.
  if (text && modifiers & MODIFIER_BITS.shift && /^[a-z]$/.test(text)) {
    text = text.toUpperCase();
  }
  // An already-uppercase letter implies Shift — encode it so the synthesized
  // KeyboardEvent (event.shiftKey, code+shiftKey reconstruction) matches a real
  // keystroke rather than reporting shiftKey:false for 'A'.
  if (text && /^[A-Z]$/.test(text)) {
    modifiers |= MODIFIER_BITS.shift;
  }
  const isPrintable = text !== undefined;

  const base: Record<string, unknown> = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  if (def.location !== undefined) base.location = def.location;

  await send('Input.dispatchKeyEvent', {
    // Printable keys produce a character event; non-text keys (navigation,
    // modifiers) use rawKeyDown so no spurious text is inserted.
    type: isPrintable ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(isPrintable ? { text } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

/**
 * Dispatch a mouse click as `mouseMoved → mousePressed → mouseReleased`. The
 * leading move lets hover-gated controls (menus, row actions) react, and some
 * frameworks gate `click` on a prior `mousemove`. `buttons` reflects currently
 * held buttons: set on press, cleared on release.
 */
export async function click(send: CdpSend, x: number, y: number, options?: ClickOptions): Promise<void> {
  const button = options?.button ?? 'left';
  const clickCount = Math.max(1, options?.clickCount ?? 1);
  const modifiers = options?.modifiers ?? 0;
  const heldButtons = BUTTON_MASK[button];

  await send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    modifiers,
    pointerType: 'mouse',
  });

  // A double-click is NOT one press/release with clickCount:2 — the renderer
  // derives `dblclick` only after observing successive click cycles with an
  // incrementing clickCount. So emit `clickCount` full press/release cycles
  // (count 1, then 2, …), matching Puppeteer/Playwright.
  for (let n = 1; n <= clickCount; n++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      buttons: heldButtons,
      clickCount: n,
      modifiers,
      pointerType: 'mouse',
    });
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      buttons: 0,
      clickCount: n,
      modifiers,
      pointerType: 'mouse',
    });
  }
}

/** Insert text directly (fast path for bulk typing; not per-key synthesis). */
export async function insertText(send: CdpSend, text: string): Promise<void> {
  await send('Input.insertText', { text });
}
