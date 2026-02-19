/**
 * Together AI Chat Completion API client implementation for pi
 * Handles Together AI's unique response format for reasoning models like Kimi K2 Thinking
 *
 * Key differences from standard OpenAI Chat Completions:
 * 1. Reasoning content is in `delta.reasoning` instead of `delta.reasoning_content`
 * 2. Tool calls are embedded in reasoning text using special tokens:
 *    - <|tool_calls_section_begin|> ... <|tool_calls_section_end|>
 *    - <|tool_call_begin|> function_name:id <|tool_call_argument_begin|> {json} <|tool_call_end|>
 * 3. finish_reason is "stop" even when tool calls are present (parsed from reasoning)
 */

import { OpenAIChatCompletionClient } from './OpenAIChatCompletionClient';
import type { OpenAIChatCompletionConfig } from './OpenAIChatCompletionClient';
import type { ResponseEvent } from '../types/ResponsesAPI';
import type { RetryConfig } from '../ModelClient';

/**
 * Together AI Chat Completion client
 * Extends OpenAIChatCompletionClient with Together AI-specific handling
 */
export class TogetherChatCompletionClient extends OpenAIChatCompletionClient {
  // Accumulator for Together AI's reasoning field
  private togetherReasoningContent: string = '';

  constructor(config: OpenAIChatCompletionConfig, retryConfig?: Partial<RetryConfig>) {
    super(config, retryConfig);
  }

  /**
   * Override convertChatCompletionEventToResponseEvent to handle Together AI's format
   * Together AI uses delta.reasoning instead of delta.reasoning_content
   * and embeds tool calls in the reasoning text using special tokens
   */
  protected convertChatCompletionEventToResponseEvent(chatEvent: any): ResponseEvent | null {
    // Check if we have pending events from previous chunk
    const pendingEvents = (this as any).pendingEvents;
    if (pendingEvents && pendingEvents.length > 0) {
      const pendingEvent = pendingEvents.shift()!;
      return pendingEvent;
    }

    const choice = chatEvent.choices?.[0];
    if (!choice) {
      return null;
    }

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // Handle Together AI's reasoning field (delta.reasoning instead of delta.reasoning_content)
    if (delta?.reasoning) {
      // Accumulate reasoning content
      this.togetherReasoningContent += delta.reasoning;

      // Return null to continue processing without emitting an event
      return null;
    }

    // Handle text content deltas (same as parent)
    if (delta?.content) {
      // Access parent's chatCompletionTextContent
      (this as any).chatCompletionTextContent += delta.content;

      if (!finishReason) {
        return {
          type: 'OutputTextDelta',
          delta: delta.content,
        };
      }
    }

    // Handle standard tool call deltas (in case Together AI sends them normally in some cases)
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      const toolCalls = (this as any).chatCompletionToolCalls as Map<number, any>;
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index ?? 0;

        let accumulated = toolCalls.get(index);
        if (!accumulated) {
          accumulated = {
            id: '',
            type: 'function',
            function: {
              name: '',
              arguments: '',
            },
          };
          toolCalls.set(index, accumulated);
        }

        if (toolCallDelta.id) {
          accumulated.id = toolCallDelta.id;
        }
        if (toolCallDelta.type) {
          accumulated.type = toolCallDelta.type;
        }
        if (toolCallDelta.function?.name) {
          accumulated.function.name = toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          accumulated.function.arguments += toolCallDelta.function.arguments;
        }
      }
    }

    // Handle completion with finish_reason
    if (finishReason) {
      const usage = chatEvent.usage || chatEvent.choices?.[0]?.usage;

      const completedEvent: ResponseEvent = {
        type: 'Completed',
        responseId: chatEvent.id || '',
        tokenUsage: usage ? (this as any).convertChatCompletionUsageToTokenUsage(usage) : undefined,
      };

      // Parse tool calls from reasoning content if present
      const parsedToolCalls = this.parseToolCallsFromReasoning(this.togetherReasoningContent);

      // Get accumulated state
      const hasReasoning = this.togetherReasoningContent.length > 0;
      const hasContent = (this as any).chatCompletionTextContent.length > 0;
      const toolCalls = (this as any).chatCompletionToolCalls as Map<number, any>;
      const hasStandardToolCalls = toolCalls.size > 0;
      const hasParsedToolCalls = parsedToolCalls.length > 0;

      // If we have any content, create a unified message item
      if (hasReasoning || hasContent || hasStandardToolCalls || hasParsedToolCalls) {
        const contentArray: any[] = [];
        if (hasContent) {
          contentArray.push({
            type: 'output_text' as const,
            text: (this as any).chatCompletionTextContent,
          });
        }

        // Use standard tool calls if available, otherwise use parsed ones
        let toolCallsArray: any[] | undefined;
        if (hasStandardToolCalls) {
          toolCallsArray = Array.from(toolCalls.values());
        } else if (hasParsedToolCalls) {
          toolCallsArray = parsedToolCalls;
        }

        // Create unified message item
        const messageItem: any = {
          type: 'message' as const,
          role: 'assistant' as const,
          content: contentArray,
        };

        // Add reasoning_content (cleaned version without tool call tokens)
        if (hasReasoning) {
          const cleanedReasoning = this.cleanReasoningContent(this.togetherReasoningContent);
          if (cleanedReasoning.trim()) {
            messageItem.reasoning_content = cleanedReasoning;
          }
        }

        // Add tool_calls if present
        if (toolCallsArray && toolCallsArray.length > 0) {
          messageItem.tool_calls = toolCallsArray;
        }

        // Clear all accumulated state for next request
        (this as any).chatCompletionTextContent = '';
        this.togetherReasoningContent = '';
        toolCalls.clear();

        // Queue Completed event
        pendingEvents.push(completedEvent);

        return {
          type: 'OutputItemDone',
          item: messageItem,
        };
      }

      // Empty response

      // Clear state
      (this as any).chatCompletionTextContent = '';
      this.togetherReasoningContent = '';
      toolCalls.clear();

      return completedEvent;
    }

    return null;
  }

  /**
   * Parse tool calls from Together AI's reasoning content
   * Format: <|tool_calls_section_begin|> <|tool_call_begin|> function_name:id <|tool_call_argument_begin|> {json} <|tool_call_end|> <|tool_calls_section_end|>
   */
  private parseToolCallsFromReasoning(reasoningContent: string): any[] {
    const toolCalls: any[] = [];

    // Check if reasoning contains tool call section
    if (!reasoningContent.includes('<|tool_calls_section_begin|>')) {
      return toolCalls;
    }

    // Extract tool calls section
    const sectionMatch = reasoningContent.match(
      /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/
    );
    if (!sectionMatch) {
      return toolCalls;
    }

    const toolCallsSection = sectionMatch[1];

    // Parse individual tool calls
    // Format: <|tool_call_begin|> functions.tool_name:id <|tool_call_argument_begin|> {json} <|tool_call_end|>
    const toolCallRegex = /<\|tool_call_begin\|>\s*([\w.]+):(\d+)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;

    let match;
    while ((match = toolCallRegex.exec(toolCallsSection)) !== null) {
      const fullName = match[1]; // e.g., "functions.browser_dom"
      const callId = match[2];   // e.g., "10"
      const argsJson = match[3]; // e.g., '{"action": "click", "node_id": 15234}'

      // Extract just the function name (remove "functions." prefix if present)
      const functionName = fullName.startsWith('functions.')
        ? fullName.substring('functions.'.length)
        : fullName;

      try {
        // Validate JSON is parseable
        JSON.parse(argsJson);

        toolCalls.push({
          id: `call_together_${callId}`,
          type: 'function',
          function: {
            name: functionName,
            arguments: argsJson,
          },
        });
      } catch (e) {
        console.warn('[TogetherChatCompletionClient] Failed to parse tool call arguments:', argsJson, e);
      }
    }

    return toolCalls;
  }

  /**
   * Clean reasoning content by removing tool call tokens
   * Returns reasoning text without the special tokens for storage/display
   */
  private cleanReasoningContent(reasoningContent: string): string {
    // Remove tool calls section entirely
    let cleaned = reasoningContent.replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g,
      ''
    );

    // Remove any remaining special tokens
    cleaned = cleaned.replace(/<\|[^|]+\|>/g, '');

    // Clean up extra whitespace
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    return cleaned;
  }

  /**
   * Cleanup resources
   */
  public async cleanup(): Promise<void> {
    await super.cleanup();
    this.togetherReasoningContent = '';
  }
}
