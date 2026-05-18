/**
 * Track 13 — bridge-safe slash gate.
 *
 * BrowserX analog of claudy's `isBridgeSafeCommand` (commands.ts:674-678).
 * When input arrives over an untrusted channel (connector / remote relay),
 * a leading `/command` must not be forwarded raw to the model (it would leak
 * `/config`-style intent) nor be treated as an executable UI command (the UI
 * command surface does not exist server-side).
 *
 * Classification:
 *   - `safe`         → an explicitly allowlisted, side-effect-free command
 *                       (e.g. /help). The funnel may let it through.
 *   - `unsafe-known` → a recognized command that is UI-only or sensitive
 *                       (e.g. /settings). The funnel short-circuits with a
 *                       systemNote and never forwards it to the model.
 *   - `unknown`      → not recognized. The funnel treats the text literally
 *                       (claudy parity: unknown `/foo` falls through to a
 *                       plain prompt; the model just sees the text).
 *
 * Phase 1 uses a conservative static policy with no registry dependency, so
 * it works identically on the server (which has no UI command registry). A
 * later phase may consult Track 03's command loader to mark `loadedFrom:
 * 'skill'` (prompt-expanding) commands as `safe`.
 */

import type { InputOrigin } from './types';

export type BridgeSafety = 'safe' | 'unsafe-known' | 'unknown';

/**
 * Side-effect-free, non-sensitive commands that are fine to honor over an
 * untrusted bridge. Kept intentionally small — add only after review.
 */
const BRIDGE_SAFE_NAMES = new Set<string>(['help']);

/**
 * Recognized commands that are UI-only or sensitive — never honor or forward
 * these over an untrusted bridge.
 */
const KNOWN_UNSAFE_NAMES = new Set<string>([
  'settings',
  'doctor',
  'config',
  'new',
  'clear',
  'reset',
  'login',
  'logout',
  'auth',
  'key',
  'apikey',
]);

/**
 * Whether the bridge-safe gate applies for this origin at all. Trusted on-host
 * input (`local`) skips the gate entirely (claudy: only `bridgeOrigin` input
 * is gated).
 */
export function originRequiresGate(origin: InputOrigin): boolean {
  return origin.channel !== 'local';
}

/**
 * Operator-trusted origins: on-host UI/WS chat (`local`) and operator-authored
 * scheduled jobs (`scheduler`). External, untrusted users come in via
 * `connector`/`remote`. Used to gate privileged input affordances such as the
 * `!` shell escape (a connector message must not synthesize shell intent).
 */
export function isOperatorTrustedOrigin(origin: InputOrigin): boolean {
  return origin.channel === 'local' || origin.channel === 'scheduler';
}

/**
 * Classify a slash command name for an untrusted origin.
 * Callers should only invoke this when {@link originRequiresGate} is true.
 */
export function classifyForOrigin(commandName: string): BridgeSafety {
  const name = commandName.toLowerCase().trim();
  if (BRIDGE_SAFE_NAMES.has(name)) return 'safe';
  if (KNOWN_UNSAFE_NAMES.has(name)) return 'unsafe-known';
  return 'unknown';
}
