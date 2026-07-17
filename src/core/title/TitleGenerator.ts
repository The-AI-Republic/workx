/**
 * TitleGenerator - Service for generating conversation titles using LLM
 *
 * Generates titles based on the first 3 user messages in a conversation.
 */

import type { ResponseItem } from '../protocol/types';
import type { TitleGenerationConfig, TitleGenerationResult } from './types';
import { DEFAULT_TITLE_CONFIG, TITLE_GENERATION_PROMPT } from './constants';
import type { ModelClient } from '../models/ModelClient';
import { withModelRetry } from '../models/resilience/withRetry';
import { queryEfficientLLM } from '../models/efficientQuery';

/**
 * Service for generating conversation titles using LLM
 */
export class TitleGenerator {
  private config: TitleGenerationConfig;

  constructor(config: Partial<TitleGenerationConfig> = {}) {
    this.config = { ...DEFAULT_TITLE_CONFIG, ...config };
  }

  /**
   * Generate a title from user messages
   *
   * @param userMessages - Array of user message strings (first 3 messages)
   * @param modelClient - Model client for LLM calls
   * @returns TitleGenerationResult with success status and title
   */
  async generateTitle(
    userMessages: string[],
    modelClient: ModelClient
  ): Promise<TitleGenerationResult> {
    if (userMessages.length === 0) {
      return {
        success: false,
        error: 'No user messages provided',
      };
    }

    // Track 12: route through the single retry orchestrator as a
    // 'background' source — title generation is non-user-blocking, so it
    // fast-bails on provider overload instead of amplifying a capacity
    // cascade. Exponential-backoff parity is preserved via computeBackoffMs.
    try {
      const cleanedTitle = await withModelRetry(
        async () => {
          const title = await this.callModelForTitle(userMessages, modelClient);
          const cleaned = this.cleanTitle(title);
          if (cleaned.length === 0) {
            throw new Error('Generated title is empty');
          }
          return cleaned;
        },
        {
          maxRetries: this.config.maxRetries,
          unattended: false,
          source: 'background',
          sleep: (ms) => this.sleep(ms),
          computeBackoffMs: (attempt) =>
            this.config.baseBackoffMs * Math.pow(2, attempt - 1),
        }
      );

      return {
        success: true,
        title: cleanedTitle,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error('[TitleGenerator] Failed after max retries:', errorMessage);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Extract user message texts from ResponseItems
   *
   * @param history - Conversation history
   * @param maxMessages - Maximum number of user messages to extract (default: 3)
   * @returns Array of user message strings
   */
  extractUserMessages(history: ResponseItem[], maxMessages: number = 3): string[] {
    const userMessages: string[] = [];

    for (const item of history) {
      if (userMessages.length >= maxMessages) {
        break;
      }

      // Check if this is a user message
      if (item.type === 'message' && item.role === 'user') {
        const content = item.content;

        if (Array.isArray(content)) {
          // Extract text from content array
          for (const contentItem of content) {
            if (contentItem.type === 'input_text' && contentItem.text) {
              userMessages.push(contentItem.text);
              break; // Only take first text content from each message
            }
          }
        } else if (typeof content === 'string') {
          userMessages.push(content);
        }
      }
    }

    return userMessages;
  }

  /**
   * Count user messages in history
   *
   * @param history - Conversation history
   * @returns Number of user messages
   */
  countUserMessages(history: ResponseItem[]): number {
    return history.filter(
      (item) => item.type === 'message' && item.role === 'user'
    ).length;
  }

  /**
   * Call the model to generate a title.
   * Routed through the shared efficient-LLM utility layer — the caller passes
   * the efficient model's client (falling back to the task model's client).
   */
  private async callModelForTitle(
    userMessages: string[],
    modelClient: ModelClient
  ): Promise<string> {
    // Build the request with user messages and title prompt
    const messagesText = userMessages
      .map((msg, i) => `User message ${i + 1}: ${msg}`)
      .join('\n\n');

    return queryEfficientLLM(modelClient, {
      instruction: TITLE_GENERATION_PROMPT,
      input: messagesText,
    });
  }

  /**
   * Clean and truncate the generated title
   */
  private cleanTitle(title: string): string {
    let cleaned = title.trim();

    // Remove common prefixes
    const prefixes = ['Title:', 'title:', 'TITLE:'];
    for (const prefix of prefixes) {
      if (cleaned.startsWith(prefix)) {
        cleaned = cleaned.slice(prefix.length).trim();
      }
    }

    // Remove surrounding quotes
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
      cleaned = cleaned.slice(1, -1);
    }

    // Truncate to max length
    if (cleaned.length > this.config.maxTitleLength) {
      cleaned = cleaned.slice(0, this.config.maxTitleLength - 3) + '...';
    }

    return cleaned;
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
