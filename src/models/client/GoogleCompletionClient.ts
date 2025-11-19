/**
 * Google AI Studio (Gemini) Chat Completion API client implementation
 * Extends OpenAIChatCompletionClient with Gemini-specific thought signature handling
 *
 * Thought signatures are encrypted representations of Gemini's internal thought process
 * that must be preserved and passed back in multi-turn conversations with function calls.
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */

import { GeminiLogger } from '../../utils/logger';
import type { ResponseEvent, Prompt } from '../types/ResponsesAPI';
import {
  OpenAIChatCompletionClient,
  type OpenAIChatCompletionConfig,
} from './OpenAIChatCompletionClient';
import type { RetryConfig } from '../ModelClient';

/**
 * Google AI Studio (Gemini) client with thought signature support
 * Extends OpenAIChatCompletionClient to handle Gemini-specific requirements
 */
export class GoogleCompletionClient extends OpenAIChatCompletionClient {
  constructor(config: OpenAIChatCompletionConfig, retryConfig?: Partial<RetryConfig>) {
    super(config, retryConfig);
  }

  /**
   * Override to capture Gemini thought signatures from tool call responses
   *
   * Thought signatures appear in functionCall parts and must be preserved
   * to maintain reasoning context across multi-turn conversations.
   */
  protected convertChatCompletionEventToResponseEvent(chatEvent: any): ResponseEvent | null {
    const choice = chatEvent.choices?.[0];
    if (!choice) {
      return super.convertChatCompletionEventToResponseEvent(chatEvent);
    }

    const delta = choice.delta;

    // Intercept tool call deltas to capture thought signatures
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index ?? 0;

        // Let parent handle the basic accumulation first
        // We need to access the accumulated tool call after parent processes it
        const result = super.convertChatCompletionEventToResponseEvent(chatEvent);

        // Now capture thought signature if present
        // Check both direct field and OpenAI-compatible nested format
        const thoughtSig = toolCallDelta.thoughtSignature
          || toolCallDelta.extra_content?.google?.thought_signature;

        if (thoughtSig) {
          // Access parent's accumulated tool calls via any cast
          const accumulated = (this as any).chatCompletionToolCalls.get(index);
          if (accumulated) {
            accumulated.thoughtSignature = thoughtSig;
            GeminiLogger.debug('Captured thought signature for tool call', {
              index,
              functionName: accumulated.function.name,
              signatureLength: thoughtSig.length
            });
          }
        }

        return result;
      }
    }

    // For non-tool-call events, use parent implementation
    return super.convertChatCompletionEventToResponseEvent(chatEvent);
  }

  /**
   * Override to include thought signatures when sending conversation history
   *
   * Thought signatures must be passed back exactly as received in subsequent turns
   * to maintain Gemini's reasoning context.
   */
  protected async makeChatCompletionsRequest(prompt: Prompt): Promise<AsyncIterable<any>> {
    // Transform prompt to include thought signatures in tool_calls
    const transformedPrompt = this.transformPromptWithThoughtSignatures(prompt);
    return super.makeChatCompletionsRequest(transformedPrompt);
  }

  /**
   * Transform prompt input to include thought signatures in the format expected by Gemini
   */
  private transformPromptWithThoughtSignatures(prompt: Prompt): Prompt {
    const transformedInput = prompt.input.map((item: any) => {
      // Only transform message items with tool_calls
      if (item.type !== 'message' || !item.tool_calls || !Array.isArray(item.tool_calls)) {
        return item;
      }

      // Check if any tool_calls have thought signatures
      const hasThoughtSignatures = item.tool_calls.some((tc: any) => tc.thoughtSignature);
      if (!hasThoughtSignatures) {
        return item;
      }

      // Transform tool_calls to include thought signatures in the format Gemini expects
      const transformedToolCalls = item.tool_calls.map((tc: any) => {
        if (!tc.thoughtSignature) {
          return tc;
        }

        // Return tool call with thought signature in both formats for compatibility
        return {
          id: tc.id,
          type: tc.type,
          function: tc.function,
          // Direct field (some Gemini versions)
          thoughtSignature: tc.thoughtSignature,
          // OpenAI-compatible nested format
          extra_content: {
            google: {
              thought_signature: tc.thoughtSignature
            }
          }
        };
      });

      return {
        ...item,
        tool_calls: transformedToolCalls
      };
    });

    return {
      ...prompt,
      input: transformedInput
    };
  }
}
