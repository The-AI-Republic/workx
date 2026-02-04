/**
 * SummaryGenerator - generates LLM-based summaries of conversation history
 */

import type { ResponseItem } from '../protocol/types';
import { SUMMARY_PREFIX, NO_SUMMARY_PLACEHOLDER } from './constants';
import { isSummaryMessage, extractTextFromContent } from './utils';

/**
 * Generates LLM summaries for conversation compaction
 */
export class SummaryGenerator {
  /**
   * Collect user messages from history, filtering out summary messages.
   *
   * @param history - Conversation history
   * @returns Array of user message strings (excluding summaries)
   */
  collectUserMessages(history: ResponseItem[]): string[] {
    const userMessages: string[] = [];

    for (const item of history) {
      // Check if this is a user message
      if (this.isUserMessage(item)) {
        const text = this.extractMessageText(item);

        // Skip summary messages and system context
        if (text && !isSummaryMessage(text) && !this.isSystemContext(text)) {
          userMessages.push(text);
        }
      }
    }

    return userMessages;
  }

  /**
   * Format summary text with the prefix for insertion into history.
   *
   * @param summaryText - Raw summary text from LLM
   * @returns Formatted summary with prefix
   */
  formatSummaryWithPrefix(summaryText: string): string {
    if (!summaryText || summaryText.trim().length === 0) {
      return `${SUMMARY_PREFIX}\n${NO_SUMMARY_PLACEHOLDER}`;
    }
    return `${SUMMARY_PREFIX}\n${summaryText}`;
  }

  /**
   * Check if a message is a summary message.
   *
   * @param text - Message text to check
   * @returns true if message is a summary
   */
  isSummaryMessage(text: string): boolean {
    return isSummaryMessage(text);
  }

  /**
   * Check if an item is a user message.
   */
  private isUserMessage(item: ResponseItem): boolean {
    if ('type' in item && item.type === 'message') {
      return (item as { role?: string }).role === 'user';
    }
    return false;
  }

  /**
   * Extract text content from a response item.
   */
  private extractMessageText(item: ResponseItem): string | null {
    if ('content' in item && Array.isArray(item.content)) {
      return extractTextFromContent(item.content as Array<{ type: string; text?: string }>);
    }
    return null;
  }

  /**
   * Check if text is system context (instructions, environment, etc.).
   */
  private isSystemContext(text: string): boolean {
    // Check for common system context patterns
    const systemPatterns = [
      '<user_instructions>',
      '</user_instructions>',
      '<environment_context>',
      '</environment_context>',
      '# AGENTS.md instructions',
      '<INSTRUCTIONS>',
      '</INSTRUCTIONS>',
      '<ENVIRONMENT_CONTEXT>',
      '</ENVIRONMENT_CONTEXT>',
    ];

    return systemPatterns.some((pattern) => text.includes(pattern));
  }
}
