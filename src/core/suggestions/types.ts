/**
 * Types for the next-prompt suggestion service (Track 24.3).
 */

export interface PromptSuggestionConfig {
  /** Retries on model failure (background source). */
  maxRetries: number;
  /** Base backoff for exponential retry. */
  baseBackoffMs: number;
  /** Hard max length of an accepted suggestion (chars). */
  maxLength: number;
  /** Number of trailing conversation turns to pack as context. */
  maxTurns: number;
  /** Per-turn truncation cap (chars). */
  maxCharsPerTurn: number;
  /** Whole-context hard cap (chars). */
  maxContextChars: number;
}

export interface PromptSuggestionResult {
  success: boolean;
  /** Undefined when no usable suggestion (rejected / model said NONE). */
  suggestion?: string;
  error?: string;
}
