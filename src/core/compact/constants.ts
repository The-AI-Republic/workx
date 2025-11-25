/**
 * Constants for chat history compaction
 */

import type { CompactionConfig } from './types';

/**
 * Prompt sent to LLM for summarization.
 * Designed for LLM-to-LLM handoff context.
 */
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

CRITICAL - Cache Storage Keys:
If cache_storage_tool was used during this conversation, you MUST preserve ALL storageKey values and their descriptions exactly as returned from write/update actions. These keys are required to retrieve cached data later. Format as:
  - storageKey: "<exact_key>" - <description>
Without these keys, cached data becomes permanently inaccessible.

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/**
 * Prefix prepended to summary when added to history.
 * Used to identify summary messages and prevent re-summarization.
 */
export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:`;

/**
 * Placeholder when no meaningful summary can be generated.
 */
export const NO_SUMMARY_PLACEHOLDER = '(no summary available)';

/**
 * Marker appended to truncated messages.
 */
export const TRUNCATION_MARKER = '\n[...tokens truncated]';

/**
 * Default compaction configuration.
 */
export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  triggerThreshold: 0.9, // 90% of context window
  userMessageBudget: 20000, // tokens for user messages
  maxRetries: 3, // retry attempts
  baseBackoffMs: 100, // exponential backoff base
};
