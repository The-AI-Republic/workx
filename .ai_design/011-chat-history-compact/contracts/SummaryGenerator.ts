/**
 * SummaryGenerator Contract
 *
 * Responsible for generating LLM-based summaries of conversation history.
 * Uses the same model as the main conversation for consistency.
 */

import type { ResponseItem } from '../../../src/protocol/types';

// ============================================================================
// Types
// ============================================================================

export interface SummaryRequest {
  /** Conversation history to summarize */
  history: ResponseItem[];

  /** Model to use for summary generation */
  model: string;

  /** Maximum tokens for the generated summary */
  maxSummaryTokens?: number;
}

export interface SummaryResponse {
  /** Whether summary generation succeeded */
  success: boolean;

  /** Generated summary text (without prefix) */
  summaryText?: string;

  /** Error message if failed */
  error?: string;

  /** Tokens used for the summary request */
  tokensUsed?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Prompt sent to LLM for summarization.
 */
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

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

// ============================================================================
// Service Interface
// ============================================================================

export interface ISummaryGenerator {
  /**
   * Generate a summary of the conversation history.
   *
   * @param request - Summary request with history and model info
   * @returns SummaryResponse with generated summary or error
   */
  generateSummary(request: SummaryRequest): Promise<SummaryResponse>;

  /**
   * Check if a message is a summary message (starts with prefix).
   *
   * @param text - Message text to check
   * @returns true if message is a summary
   */
  isSummaryMessage(text: string): boolean;

  /**
   * Format summary text with the prefix for insertion into history.
   *
   * @param summaryText - Raw summary text from LLM
   * @returns Formatted summary with prefix
   */
  formatSummaryWithPrefix(summaryText: string): string;

  /**
   * Extract user messages from history, filtering out summary messages.
   *
   * @param history - Conversation history
   * @returns Array of user message strings (excluding summaries)
   */
  collectUserMessages(history: ResponseItem[]): string[];
}
