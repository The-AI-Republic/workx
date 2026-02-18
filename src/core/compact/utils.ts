/**
 * Utility functions for chat history compaction
 */

import { SUMMARY_PREFIX, TRUNCATION_MARKER } from './constants';
import type { ResponseItem } from '../protocol/types';

/**
 * Approximate token count using word count heuristic.
 * Uses 1.3 multiplier which is average for GPT models.
 *
 * @param text - Text to count tokens for
 * @returns Approximate token count
 */
export function approxTokenCount(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Count words by splitting on whitespace
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;

  // Count punctuation (roughly 0.5 tokens each)
  const punctuation = (text.match(/[.!?;:,'"()\[\]{}]/g) || []).length;

  // Apply multiplier (1.3 is average for GPT tokenizers)
  const multiplier = 1.3;

  return Math.ceil((words + punctuation * 0.5) * multiplier);
}

/**
 * Truncate text to fit within a token budget.
 * Adds truncation marker to indicate incomplete text.
 *
 * @param text - Text to truncate
 * @param maxTokens - Maximum tokens allowed
 * @returns Truncated text with marker, or original if within budget
 */
export function truncateText(text: string, maxTokens: number): string {
  const currentTokens = approxTokenCount(text);

  if (currentTokens <= maxTokens) {
    return text;
  }

  // Calculate approximate characters per token (inverse of token ratio)
  const charsPerToken = text.length / currentTokens;

  // Reserve tokens for the truncation marker
  const markerTokens = approxTokenCount(TRUNCATION_MARKER);
  const availableTokens = Math.max(0, maxTokens - markerTokens);

  // Calculate target character count
  const targetChars = Math.floor(availableTokens * charsPerToken);

  if (targetChars <= 0) {
    return TRUNCATION_MARKER;
  }

  // Truncate at word boundary if possible
  let truncated = text.substring(0, targetChars);

  // Find last space to avoid cutting words
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > targetChars * 0.8) {
    truncated = truncated.substring(0, lastSpace);
  }

  return truncated.trimEnd() + TRUNCATION_MARKER;
}

/**
 * Check if a message is a summary message (starts with prefix).
 *
 * @param text - Message text to check
 * @returns true if message is a summary
 */
export function isSummaryMessage(text: string): boolean {
  if (!text) {
    return false;
  }
  return text.startsWith(SUMMARY_PREFIX);
}

/**
 * Calculate exponential backoff delay.
 *
 * @param retryCount - Current retry attempt (1-based)
 * @param baseDelayMs - Base delay in milliseconds
 * @returns Delay in milliseconds
 */
export function calculateBackoff(retryCount: number, baseDelayMs: number = 100): number {
  // Exponential backoff: baseDelay * 2^(retryCount-1)
  // retryCount 1 -> baseDelay
  // retryCount 2 -> baseDelay * 2
  // retryCount 3 -> baseDelay * 4
  const delay = baseDelayMs * Math.pow(2, retryCount - 1);

  // Cap at 10 seconds
  return Math.min(delay, 10000);
}

/**
 * Sleep for a specified duration.
 *
 * @param ms - Duration in milliseconds
 * @returns Promise that resolves after the duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract text content from a message content array.
 *
 * @param content - Array of content items
 * @returns Joined text content
 */
export function extractTextFromContent(
  content: Array<{ type: string; text?: string }>
): string {
  const pieces: string[] = [];

  for (const item of content) {
    if (
      (item.type === 'input_text' || item.type === 'output_text' || item.type === 'text') &&
      item.text
    ) {
      pieces.push(item.text);
    }
  }

  return pieces.join('\n');
}

/**
 * Estimate total token count for a set of ResponseItems plus optional
 * instruction text and tool schema overhead.
 *
 * Uses 1 token ≈ 4 characters heuristic (consistent with CompactService.estimateTokens).
 *
 * @param items - Conversation history + new input items
 * @param instructionsLength - Character length of base + user instructions (optional)
 * @param toolCount - Number of tool definitions to account for (optional, ~500 tokens each)
 * @returns Estimated token count (always >= 0)
 */
export function estimateRequestTokens(
  items: ResponseItem[],
  instructionsLength?: number,
  toolCount?: number
): number {
  let totalChars = 0;

  for (const item of items) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const contentItem of item.content) {
        if (
          (contentItem.type === 'input_text' ||
            contentItem.type === 'output_text' ||
            contentItem.type === 'text') &&
          contentItem.text
        ) {
          totalChars += contentItem.text.length;
        }
      }
    }
  }

  let estimate = Math.ceil(totalChars / 4);
  estimate += Math.ceil((instructionsLength ?? 0) / 4);
  estimate += (toolCount ?? 0) * 500;

  return estimate;
}
