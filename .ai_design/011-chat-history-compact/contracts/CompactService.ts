/**
 * CompactService Contract
 *
 * Main orchestration service for chat history compaction.
 * This is the primary entry point for both automatic and manual compaction.
 */

import type { ResponseItem } from '../../../src/protocol/types';

// ============================================================================
// Configuration Types
// ============================================================================

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

// ============================================================================
// Result Types
// ============================================================================

export type CompactionTrigger = 'auto' | 'manual';

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

export interface CompactedHistory {
  /** System instructions and initial context messages */
  initialContext: ResponseItem[];

  /** Recent user messages within token budget */
  preservedUserMessages: ResponseItem[];

  /** LLM-generated summary with prefix */
  summaryMessage: ResponseItem;
}

// ============================================================================
// Service Interface
// ============================================================================

export interface ICompactService {
  /**
   * Check if compaction should be triggered based on current token usage.
   *
   * @param currentTokens - Current total token usage
   * @param contextWindow - Model's context window size
   * @returns true if auto-compaction should trigger
   */
  shouldCompact(currentTokens: number, contextWindow: number): boolean;

  /**
   * Execute compaction on the current conversation history.
   *
   * @param history - Current conversation history
   * @param trigger - What triggered this compaction
   * @returns CompactionResult with success/failure and metrics
   */
  compact(
    history: ResponseItem[],
    trigger: CompactionTrigger
  ): Promise<CompactionResult>;

  /**
   * Build the compacted history structure from compaction result.
   *
   * @param history - Original history (for extracting initial context)
   * @param userMessages - Preserved user messages
   * @param summaryText - Generated summary text
   * @returns CompactedHistory ready to replace original
   */
  buildCompactedHistory(
    history: ResponseItem[],
    userMessages: string[],
    summaryText: string
  ): CompactedHistory;

  /**
   * Get current compaction configuration.
   */
  getConfig(): CompactionConfig;

  /**
   * Update compaction configuration.
   *
   * @param config - Partial config to merge with current
   */
  updateConfig(config: Partial<CompactionConfig>): void;
}

// ============================================================================
// Events
// ============================================================================

export interface CompactionStartedEvent {
  type: 'compaction_started';
  trigger: CompactionTrigger;
  tokensBefore: number;
  contextWindow: number;
}

export interface CompactionCompletedEvent {
  type: 'compaction_completed';
  result: CompactionResult;
}

export interface CompactionErrorEvent {
  type: 'compaction_error';
  error: string;
  retriesRemaining: number;
}

export type CompactionEvent =
  | CompactionStartedEvent
  | CompactionCompletedEvent
  | CompactionErrorEvent;
