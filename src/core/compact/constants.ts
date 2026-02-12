/**
 * Constants for chat history compaction
 *
 * Prompt content is managed by PromptComposer and loaded from fragment files.
 * This module re-exports them for backward compatibility.
 */

import type { CompactionConfig } from './types';
import { PromptComposer } from '../../prompts/PromptComposer';

const _composer = new PromptComposer();

/**
 * Prompt sent to LLM for summarization.
 * Designed for LLM-to-LLM handoff context.
 */
export const SUMMARIZATION_PROMPT = _composer.composeCompactPrompt();

/**
 * Prefix prepended to summary when added to history.
 * Used to identify summary messages and prevent re-summarization.
 */
export const SUMMARY_PREFIX = _composer.composeSummaryPrefix();

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
