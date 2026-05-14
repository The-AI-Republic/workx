/**
 * Source precedence for the typed command surface.
 *
 * Lower index wins on name collisions (first-match-wins, matching claudy
 * `commands.ts:451-470`). When BrowserX wants override-by-source semantics
 * (e.g. user skill overriding a builtin), reverse the load order before
 * `dedupeByName`.
 */

import type { CommandLoadedFrom } from './types';

export const SOURCE_PRECEDENCE: readonly CommandLoadedFrom[] = ['builtin', 'skill', 'plugin'] as const;

/** Lower number = higher precedence (wins dedupe). */
export function precedenceOf(source: CommandLoadedFrom): number {
  const idx = SOURCE_PRECEDENCE.indexOf(source);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}
