/**
 * Types for chat history compaction
 */

import type { ResponseItem } from '../../protocol/types';

/**
 * What triggered the compaction
 */
export type CompactionTrigger = 'auto' | 'manual';

/**
 * Configuration for compaction behavior
 */
export interface CompactionConfig {
  /**
   * Percentage of context window that triggers automatic compaction.
   * Range: 0.5 - 0.99
   * @default 0.9
   */
  triggerThreshold: number;

  /**
   * Maximum tokens to allocate for preserved user messages.
   * Must be positive and less than model context window.
   * @default 20000
   */
  userMessageBudget: number;

  /**
   * Maximum retry attempts for transient errors.
   * Range: 1 - 10
   * @default 3
   */
  maxRetries: number;

  /**
   * Base delay for exponential backoff in milliseconds.
   * Range: 50 - 1000
   * @default 100
   */
  baseBackoffMs: number;
}

/**
 * Result of a compaction operation
 */
export interface CompactionResult {
  /** Whether compaction completed successfully */
  success: boolean;

  /** Total tokens before compaction */
  tokensBefore: number;

  /** Total tokens after compaction */
  tokensAfter: number;

  /** Number of history items trimmed during overflow handling */
  itemsTrimmed: number;

  /** Generated summary text (only if success=true) */
  summaryText?: string;

  /** Error message (only if success=false) */
  error?: string;

  /** Number of retries used before success/failure */
  retriesUsed: number;

  /** What triggered the compaction */
  triggerReason: CompactionTrigger;
}

/**
 * The reconstructed conversation history after compaction
 */
export interface CompactedHistory {
  /** System instructions and initial context messages */
  initialContext: ResponseItem[];

  /** Recent user messages within token budget */
  preservedUserMessages: ResponseItem[];

  /** LLM-generated summary with prefix */
  summaryMessage: ResponseItem;
}

/**
 * User message selection result
 */
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

/**
 * Summary generation request
 */
export interface SummaryRequest {
  /** Conversation history to summarize */
  history: ResponseItem[];

  /** Model to use for summary generation */
  model: string;

  /** Maximum tokens for the generated summary */
  maxSummaryTokens?: number;
}

/**
 * Summary generation response
 */
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
