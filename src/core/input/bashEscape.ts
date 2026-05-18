/**
 * Track 13 — funnel Stage 4: `!` shell escape (design §6.6, §7.3).
 *
 * BrowserX has no upstream "input mode" layer (claudy detects `!` in
 * `inputModes.ts` *before* its funnel); the funnel detects it itself.
 *
 * Layer boundary: the funnel's job is input *normalization*, not execution.
 * It detects a leading `!`, gates on the live `hasShellExec` capability, and
 * — when permitted — rewrites the prompt into a machine-recognizable
 * `<bash-input>…</bash-input>` marker (claudy parity). Actually *running* the
 * command and injecting `<bash-stdout>` is the execution layer's concern
 * (kept out of `core/input/` for the same layering reason UI commands stayed
 * in the UI and DOM access stayed behind the adapter). When `hasShellExec`
 * is false the `!` is left as literal text plus a systemNote, so behavior is
 * well-defined on every platform.
 */

export const BASH_INPUT_OPEN = '<bash-input>';
export const BASH_INPUT_CLOSE = '</bash-input>';

/**
 * If `text` is a `!` shell escape, return the command (everything after the
 * leading `!`, trimmed). Returns null for a bare `!` or non-escape input.
 */
export function detectBashEscape(text: string): { command: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('!')) return null;
  const command = trimmed.slice(1).trim();
  if (command === '') return null;
  return { command };
}

/** Wrap a command in the recognizable marker (claudy parity). */
export function buildBashInputMarker(command: string): string {
  return `${BASH_INPUT_OPEN}${command}${BASH_INPUT_CLOSE}`;
}
