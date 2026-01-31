/**
 * Type definitions for TitleGenerator service
 */

/**
 * Result of title generation
 */
export interface TitleGenerationResult {
  /** Whether generation succeeded */
  success: boolean;
  /** Generated title (if success) */
  title?: string;
  /** Error message (if failed) */
  error?: string;
}

/**
 * Configuration for title generation
 */
export interface TitleGenerationConfig {
  /** Maximum retries on failure */
  maxRetries: number;
  /** Base backoff delay in milliseconds */
  baseBackoffMs: number;
  /** Maximum title length in characters */
  maxTitleLength: number;
}
