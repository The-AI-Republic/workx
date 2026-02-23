/**
 * Constants for chat history compaction
 *
 * Prompt content loaded directly from fragment files via Vite ?raw imports.
 */

import type { CompactionConfig } from './types';
import compactSummarization from '../../prompts/fragments/compact_summarization.md?raw';
import compactSummaryPrefix from '../../prompts/fragments/compact_summary_prefix.md?raw';

/**
 * Prompt sent to LLM for summarization.
 * Designed for LLM-to-LLM handoff context.
 */
export const SUMMARIZATION_PROMPT = compactSummarization;

/**
 * Prefix prepended to summary when added to history.
 * Used to identify summary messages and prevent re-summarization.
 */
export const SUMMARY_PREFIX = compactSummaryPrefix;

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
  triggerThreshold: 0.85, // 85% of context window
  userMessageBudget: 20000, // tokens for user messages
  maxRetries: 3, // retry attempts
  baseBackoffMs: 100, // exponential backoff base
};
