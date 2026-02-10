/**
 * HistoryReconstructor - builds compacted history from components
 */

import type { ResponseItem } from '../protocol/types';
import type { CompactedHistory, CompactionConfig, UserMessageSelection } from './types';
import { SUMMARY_PREFIX, DEFAULT_COMPACTION_CONFIG, TRUNCATION_MARKER } from './constants';
import { approxTokenCount, truncateText } from './utils';

/**
 * Reconstructs conversation history after compaction
 */
export class HistoryReconstructor {
  /**
   * Extract initial context from conversation history.
   * Initial context includes system messages and initial instructions
   * that should always be preserved at the start of the conversation.
   *
   * @param history - Full conversation history
   * @returns Initial context items
   */
  extractInitialContext(history: ResponseItem[]): ResponseItem[] {
    const initialContext: ResponseItem[] = [];

    for (const item of history) {
      // Check if this is a system message or initial context
      if (this.isInitialContextItem(item)) {
        initialContext.push(item);
      } else {
        // Stop at first non-initial-context item
        break;
      }
    }

    return initialContext;
  }

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
    config: CompactionConfig = DEFAULT_COMPACTION_CONFIG
  ): UserMessageSelection {
    const selected: string[] = [];
    let remaining = config.userMessageBudget;
    let truncatedCount = 0;
    let omittedCount = 0;

    // Iterate in reverse (most recent first)
    for (let i = userMessages.length - 1; i >= 0; i--) {
      const message = userMessages[i];

      if (remaining <= 0) {
        omittedCount++;
        continue;
      }

      const tokens = approxTokenCount(message);

      if (tokens <= remaining) {
        // Message fits entirely
        selected.push(message);
        remaining -= tokens;
      } else if (remaining > 0) {
        // Truncate message to fit
        const truncated = truncateText(message, remaining);
        selected.push(truncated);
        truncatedCount++;
        remaining = 0;
      } else {
        omittedCount++;
      }
    }

    // Restore chronological order
    selected.reverse();

    return {
      messages: selected,
      totalTokens: config.userMessageBudget - remaining,
      truncatedCount,
      omittedCount,
    };
  }

  /**
   * Truncate a message to fit within token limit.
   *
   * @param message - Original message text
   * @param maxTokens - Maximum tokens allowed
   * @returns Truncated message with marker
   */
  truncateMessage(message: string, maxTokens: number): string {
    return truncateText(message, maxTokens);
  }

  /**
   * Build the compacted history structure.
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
  ): CompactedHistory {
    // Convert user messages to ResponseItem format
    const preservedUserMessages: ResponseItem[] = userMessages.map((text) => ({
      type: 'message' as const,
      role: 'user',
      content: [{ type: 'input_text' as const, text }],
    }));

    // Create summary message
    const summaryMessage: ResponseItem = {
      type: 'message' as const,
      role: 'user',
      content: [{ type: 'input_text' as const, text: summaryText }],
    };

    return {
      initialContext,
      preservedUserMessages,
      summaryMessage,
    };
  }

  /**
   * Convert CompactedHistory to flat ResponseItem array
   * ready to replace the original history.
   *
   * @param compacted - CompactedHistory structure
   * @returns Flat array of ResponseItems
   */
  toResponseItems(compacted: CompactedHistory): ResponseItem[] {
    return [
      ...compacted.initialContext,
      ...compacted.preservedUserMessages,
      compacted.summaryMessage,
    ];
  }

  /**
   * Check if an item is part of initial context.
   */
  private isInitialContextItem(item: ResponseItem): boolean {
    // System messages are always initial context
    if ('type' in item && item.type === 'message') {
      const role = (item as { role?: string }).role;
      if (role === 'system') {
        return true;
      }

      // Check for system context markers in user messages
      if (role === 'user' && 'content' in item && Array.isArray(item.content)) {
        const text = this.extractText(item.content as Array<{ type: string; text?: string }>);
        return this.isSystemContextText(text);
      }
    }

    return false;
  }

  /**
   * Extract text from content array.
   */
  private extractText(content: Array<{ type: string; text?: string }>): string {
    return content
      .filter((c) => c.type === 'input_text' || c.type === 'output_text' || c.type === 'text')
      .map((c) => c.text || '')
      .join('\n');
  }

  /**
   * Check if text contains system context markers.
   */
  private isSystemContextText(text: string): boolean {
    const systemPatterns = [
      '<user_instructions>',
      '<environment_context>',
      '# AGENTS.md instructions',
      '<INSTRUCTIONS>',
      '<ENVIRONMENT_CONTEXT>',
    ];

    return systemPatterns.some((pattern) => text.includes(pattern));
  }
}
