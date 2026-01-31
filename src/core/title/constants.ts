/**
 * Constants for TitleGenerator service
 */

import type { TitleGenerationConfig } from './types';

/**
 * Default configuration for title generation
 */
export const DEFAULT_TITLE_CONFIG: TitleGenerationConfig = {
  maxRetries: 2,
  baseBackoffMs: 1000,
  maxTitleLength: 60,
};

/**
 * Prompt for generating conversation titles
 * Uses only user messages to generate a concise title
 */
export const TITLE_GENERATION_PROMPT = `You are helping to generate chat conversation titles. Based on the user messages, generate a concise title ( words max) for this conversation.

Requirements:
- Focus on the user's main goal or request
- Be specific and descriptive
- Do not include quotes or special formatting
- Do not start with "Title:" or similar prefixes
- Just output the title text directly

Title:`;

/**
 * Generate placeholder title with datetime
 * Format: "MM-DD_HH-mm_chat"
 */
export function generatePlaceholderTitle(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');

  return `${month}-${day}_${hours}-${minutes}_chat`;
}
