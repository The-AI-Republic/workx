/**
 * registerSkillScopedHooks — register a skill's `hooks:` frontmatter into
 * a SessionHookStore for the duration of one skill invocation.
 *
 * Track 03 Phase 4. Pair with `store.clear()` in a `finally` block so hooks
 * are removed whether the skill completes or throws.
 */

import type { SessionHookStore } from '@/core/hooks/loaders/SessionHookStore';
import { VALID_HOOK_EVENTS } from '@/core/hooks/HookRegistry';
import type { HooksConfig, HookEvent, HookCommand, HookMatcherEntry } from '@/core/hooks/types';

/**
 * Cap on hooks registered per single skill invocation. Defends against a
 * malicious or runaway skill declaring thousands of hooks and DoS-ing the
 * registry. Excess hooks are dropped with a warning.
 */
export const MAX_HOOKS_PER_SKILL = 100;

/**
 * Walk every event/matcher/hook in `hooks` and register through `store`.
 * Returns the number of hooks registered (useful for tests).
 *
 * `skillName` is currently informational — used for log/debug attribution.
 * If hook attribution is needed in observability events, plumb through
 * the registration metadata in HookRegistry.
 */
export function registerSkillScopedHooks(
  store: SessionHookStore,
  hooks: HooksConfig,
  skillName: string,
): number {
  let count = 0;
  let truncated = false;
  outer: for (const [eventName, matcherEntries] of Object.entries(hooks)) {
    if (!VALID_HOOK_EVENTS.has(eventName as HookEvent)) {
      console.warn(
        `[registerSkillScopedHooks] Skill "${skillName}" declared unknown hook event "${eventName}", skipping`,
      );
      continue;
    }
    const event = eventName as HookEvent;
    for (const entry of matcherEntries as readonly HookMatcherEntry[]) {
      for (const hook of entry.hooks as readonly HookCommand[]) {
        if (count >= MAX_HOOKS_PER_SKILL) {
          truncated = true;
          break outer;
        }
        store.add(event, hook, entry.matcher);
        count++;
      }
    }
  }
  if (truncated) {
    console.warn(
      `[registerSkillScopedHooks] Skill "${skillName}" exceeded MAX_HOOKS_PER_SKILL (${MAX_HOOKS_PER_SKILL}); excess hooks dropped`,
    );
  }
  return count;
}
