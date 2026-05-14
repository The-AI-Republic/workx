/**
 * registerSkillScopedHooks — register a skill's `hooks:` frontmatter into
 * a SessionHookStore for the duration of one skill invocation.
 *
 * Track 03 Phase 4. Pair with `store.clear()` in a `finally` block so hooks
 * are removed whether the skill completes or throws.
 */

import type { SessionHookStore } from '@/core/hooks/loaders/SessionHookStore';
import type { HooksConfig, HookEvent, HookCommand, HookMatcherEntry } from '@/core/hooks/types';

const VALID_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'PermissionRequest',
  'PermissionDenied',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'ConfigChange',
]);

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
  for (const [eventName, matcherEntries] of Object.entries(hooks)) {
    if (!VALID_HOOK_EVENTS.has(eventName as HookEvent)) {
      console.warn(
        `[registerSkillScopedHooks] Skill "${skillName}" declared unknown hook event "${eventName}", skipping`,
      );
      continue;
    }
    const event = eventName as HookEvent;
    for (const entry of matcherEntries as readonly HookMatcherEntry[]) {
      for (const hook of entry.hooks as readonly HookCommand[]) {
        store.add(event, hook, entry.matcher);
        count++;
      }
    }
  }
  return count;
}
