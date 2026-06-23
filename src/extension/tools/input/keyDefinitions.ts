/**
 * US-keyboard key-definition table.
 *
 * Maps a `key` value (as supplied by the agent — e.g. "Enter", "ArrowDown",
 * "a", "1") to the fields CDP's `Input.dispatchKeyEvent` needs: a correct
 * `code`, a `windowsVirtualKeyCode` (so `KeyboardEvent.keyCode`/`which` is
 * populated for legacy handlers), and `text` for printable keys.
 *
 * This replaces the previous `code: \`Key${key.toUpperCase()}\`` defect, which
 * produced invalid codes like `KeyENTER`/`KeyTAB` and sent no virtual key code
 * or text — so many pages ignored synthesized keypresses entirely.
 *
 * Shape ported from Puppeteer's USKeyboardLayout (Apache-2.0).
 *
 * @module extension/tools/input/keyDefinitions
 */

export interface KeyDefinition {
  /** `KeyboardEvent.key` value. */
  key: string;
  /** `KeyboardEvent.code` value (physical key). */
  code: string;
  /** Windows virtual key code → CDP `windowsVirtualKeyCode`. */
  keyCode: number;
  /** Character produced, when printable. Presence marks the key as text-producing. */
  text?: string;
  /** `KeyboardEvent.location` (1 = left modifier, 3 = numpad). */
  location?: number;
}

/** Named / non-printable keys and aliases the agent commonly supplies. */
const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  NumpadEnter: { key: 'Enter', code: 'NumpadEnter', keyCode: 13, text: '\r', location: 3 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
  ' ': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  // Modifiers (left variants).
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
};

/** Friendly aliases → canonical key names. */
const ALIASES: Record<string, string> = {
  Esc: 'Escape',
  Del: 'Delete',
  Space: ' ',
  Spacebar: ' ',
  Up: 'ArrowUp',
  Down: 'ArrowDown',
  Left: 'ArrowLeft',
  Right: 'ArrowRight',
  Ctrl: 'Control',
  Command: 'Meta',
  Cmd: 'Meta',
  Win: 'Meta',
  Return: 'Enter',
};

const A_CODE = 'a'.charCodeAt(0);
const Z_CODE = 'z'.charCodeAt(0);

/** US punctuation → physical `code` + Windows virtual key code. */
const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  '`': { code: 'Backquote', keyCode: 192 }, '~': { code: 'Backquote', keyCode: 192 },
  '-': { code: 'Minus', keyCode: 189 }, '_': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 }, '+': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 }, '{': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 }, '}': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 }, '|': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 }, ':': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 }, '"': { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 }, '<': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 }, '>': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 }, '?': { code: 'Slash', keyCode: 191 },
};

/**
 * Resolve a key string to its CDP definition. Handles named keys, aliases,
 * function keys (F1–F24), single letters/digits, and falls back to treating an
 * unknown single character as printable text.
 */
export function getKeyDefinition(key: string): KeyDefinition {
  const canonical = ALIASES[key] ?? key;
  const named = NAMED_KEYS[canonical];
  if (named) return named;

  // Function keys F1–F24 → keyCode 112–135.
  const fnMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(canonical);
  if (fnMatch) {
    const n = Number(fnMatch[1]);
    return { key: canonical, code: canonical, keyCode: 111 + n };
  }

  if (canonical.length === 1) {
    const ch = canonical;
    const lower = ch.toLowerCase();
    const lc = lower.charCodeAt(0);
    if (lc >= A_CODE && lc <= Z_CODE) {
      const letter = lower.toUpperCase();
      return { key: ch, code: `Key${letter}`, keyCode: lower.toUpperCase().charCodeAt(0), text: ch };
    }
    if (ch >= '0' && ch <= '9') {
      return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
    }
    const punct = PUNCTUATION[ch];
    if (punct) {
      return { key: ch, code: punct.code, keyCode: punct.keyCode, text: ch };
    }
    // Other printable single character: provide text so it inserts. We don't
    // model a physical code for it, and we deliberately emit keyCode:0 rather
    // than a wrong virtual key code derived from the character's ASCII value.
    return { key: ch, code: '', keyCode: 0, text: ch };
  }

  // Unknown multi-char key: pass through with no virtual code.
  return { key: canonical, code: canonical, keyCode: 0 };
}
