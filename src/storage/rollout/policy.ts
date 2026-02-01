/**
 * Persistence policy for RolloutRecorder
 * Determines which RolloutItems should be persisted to IndexedDB
 */

import type { RolloutItem } from './types';

// ============================================================================
// Public API
// ============================================================================

/**
 * Determine if a RolloutItem should be persisted to storage.
 * @param item - The rollout item to evaluate
 * @returns True if item should be persisted
 */
export function isPersistedRolloutItem(item: RolloutItem): boolean {
  switch (item.type) {
    case 'session_meta':
      return true; // Always persist session metadata
    case 'compacted':
      return true; // Always persist compacted summaries
    case 'turn_context':
      return true; // Always persist turn context
    case 'response_item':
      return shouldPersistResponseItem(item.payload);
    case 'event_msg':
      return shouldPersistEventMsg(item.payload);
    default:
      return false;
  }
}

/**
 * Determine if a ResponseItem should be persisted.
 * @param item - The response item to evaluate
 * @returns True if response item should be persisted
 */
export function shouldPersistResponseItem(item: any): boolean {
  if (!item || typeof item !== 'object' || !item.type) {
    return false;
  }

  // Types must match ResponseItem.type from protocol/types.ts (lowercase/snake_case)
  const persistedTypes = new Set([
    'message',
    'reasoning',
    'local_shell_call',
    'function_call',
    'function_call_output',
    'custom_tool_call',
    'custom_tool_call_output',
    'web_search_call',
  ]);

  return persistedTypes.has(item.type);
}

/**
 * Determine if an EventMsg should be persisted.
 * @param event - The event message to evaluate
 * @returns True if event message should be persisted
 */
export function shouldPersistEventMsg(event: any): boolean {
  if (!event || typeof event !== 'object' || !event.type) {
    return false;
  }

  const persistedTypes = new Set([
    'UserMessage',
    'AgentMessage',
    'AgentReasoning',
    'TokenCount',
    'EnteredReviewMode',
    'ExitedReviewMode',
    'TurnAborted',
  ]);

  return persistedTypes.has(event.type);
}

// ============================================================================
// Filter Helpers
// ============================================================================

/**
 * Filter an array of RolloutItems to only include persisted items.
 * @param items - Array of rollout items
 * @returns Filtered array containing only persisted items
 */
export function filterPersistedItems(items: RolloutItem[]): RolloutItem[] {
  return items.filter(isPersistedRolloutItem);
}
