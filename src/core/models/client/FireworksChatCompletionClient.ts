/**
 * Fireworks AI Chat Completion API client implementation for browserx-chrome
 * Extends OpenAIChatCompletionClient for Fireworks-specific behavior
 *
 * Key Fireworks Features:
 * - OpenAI-compatible Chat Completions API
 * - Supports Kimi K2 Thinking model with reasoning capabilities
 * - Model identifier: accounts/fireworks/models/kimi-k2-thinking
 */

import type { RetryConfig } from '../ModelClient';
import { OpenAIChatCompletionClient, type OpenAIChatCompletionConfig } from './OpenAIChatCompletionClient';

/**
 * Fireworks AI Chat Completion API client
 * Uses Chat Completions API (recommended by Fireworks)
 */
export class FireworksChatCompletionClient extends OpenAIChatCompletionClient {
  constructor(config: OpenAIChatCompletionConfig, retryConfig?: Partial<RetryConfig>) {
    super(config, retryConfig);

    // Validate that this is actually a Fireworks provider
    if (config.provider.name !== 'Fireworks AI') {
      console.warn(`[FireworksChatCompletionClient] Warning: FireworksChatCompletionClient instantiated with non-Fireworks provider: ${config.provider.name}`);
    }
  }
}
