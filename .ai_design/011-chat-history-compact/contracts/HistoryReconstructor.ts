/**
 * HistoryReconstructor Contract
 *
 * Responsible for building the compacted history from components:
 * initial context + preserved user messages + summary message.
 */

import type { ResponseItem } from '../../../src/protocol/types';
import type { CompactedHistory, CompactionConfig } from './CompactService';

// ============================================================================
// Types
// ============================================================================

export interface UserMessageSelection {
  /** Selected user messages to preserve */
  messages: string[];

  /** Total tokens used by selected messages */
  totalTokens: number;

  /** Number of messages that were truncated */
  truncatedCount: number;

  /** Number of messages that were fully omitted */
  omittedCount: number;
}

export interface InitialContextExtraction {
  /** Initial context items (system messages, instructions) */
  items: ResponseItem[];

  /** Total tokens in initial context */
  totalTokens: number;
}

// ============================================================================
// Service Interface
// ============================================================================

export interface IHistoryReconstructor {
  /**
   * Extract initial context from conversation history.
   * Initial context includes system messages and initial instructions
   * that should always be preserved at the start of the conversation.
   *
   * @param history - Full conversation history
   * @returns Initial context items with token count
   */
  extractInitialContext(history: ResponseItem[]): InitialContextExtraction;

  /**
   * Select user messages to preserve within token budget.
   * Prioritizes most recent messages.
   *
   * @param userMessages - All user messages from history
   * @param config - Compaction config with userMessageBudget
   * @returns Selected messages with metrics
   */
  selectUserMessages(
    userMessages: string[],
    config: CompactionConfig
  ): UserMessageSelection;

  /**
   * Truncate a message to fit within token limit.
   * Appends truncation marker to indicate incomplete message.
   *
   * @param message - Original message text
   * @param maxTokens - Maximum tokens allowed
   * @returns Truncated message with marker
   */
  truncateMessage(message: string, maxTokens: number): string;

  /**
   * Build the final compacted history array.
   *
   * @param initialContext - Initial context items
   * @param userMessages - Selected user messages
   * @param summaryText - Formatted summary with prefix
   * @returns CompactedHistory structure
   */
  buildHistory(
    initialContext: ResponseItem[],
    userMessages: string[],
    summaryText: string
  ): CompactedHistory;

  /**
   * Convert CompactedHistory to flat ResponseItem array
   * ready to replace the original history.
   *
   * @param compacted - CompactedHistory structure
   * @returns Flat array of ResponseItems
   */
  toResponseItems(compacted: CompactedHistory): ResponseItem[];
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Marker appended to truncated messages.
 */
export const TRUNCATION_MARKER = '\n[...tokens truncated]';

/**
 * Default maximum tokens for user message preservation.
 */
export const DEFAULT_USER_MESSAGE_BUDGET = 20000;
