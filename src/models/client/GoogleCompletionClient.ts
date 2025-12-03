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
import { ModelClientError, type RetryConfig } from '../ModelClient';
import { get_full_instructions, get_formatted_input } from '../PromptHelpers';

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
   * Override to build Gemini-compatible request
   *
   * Gemini's OpenAI compatibility layer does NOT support:
   * - reasoning_content field in messages
   * - strict field in tool function definitions
   * - parallel_tool_calls parameter
   *
   * Thought signatures must be passed back exactly as received in subsequent turns
   * to maintain Gemini's reasoning context.
   */
  protected async makeChatCompletionsRequest(prompt: Prompt): Promise<AsyncIterable<any>> {
    // Validate API key before making request
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError(`No API key configured for provider: ${this.provider.name}`);
    }

    try {
      // Reset streaming state before starting new request
      (this as any).chatCompletionTextContent = '';
      (this as any).chatCompletionReasoningContent = '';
      (this as any).chatCompletionToolCalls.clear();
      GeminiLogger.stateReset();
      GeminiLogger.streamStart(this.currentModel, this.conversationId);

      // Transform prompt to include thought signatures in tool_calls
      const transformedPrompt = this.transformPromptWithThoughtSignatures(prompt);

      // Convert Prompt to Chat Completions format
      const messages: any[] = [];

      // Get full instructions including base instructions and overrides
      const fullInstructions = get_full_instructions(transformedPrompt, this.modelFamily);

      // Add system message if instructions exist
      if (fullInstructions) {
        messages.push({
          role: 'system',
          content: fullInstructions
        });
      }

      // Convert input array to messages
      const formattedInput = await get_formatted_input(transformedPrompt);
      if (formattedInput && Array.isArray(formattedInput)) {
        for (const item of formattedInput) {
          if (item.type === 'message') {
            // Convert content array to Chat Completions format
            let content: any = item.content;
            if (Array.isArray(content)) {
              // Handle all ContentItem types: 'text', 'input_text', 'output_text', 'input_image'
              const convertedParts = content.map((part: any) => {
                if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
                  return { type: 'text', text: part.text };
                } else if (part.type === 'input_image') {
                  // Convert to Chat Completions image format
                  return {
                    type: 'image_url',
                    image_url: { url: part.image_url }
                  };
                } else if (part.type === 'refusal') {
                  return { type: 'text', text: part.refusal };
                }
                return null;
              }).filter((c: any) => c !== null);

              // If all parts are text, join into a single string for simplicity
              // Otherwise, keep as multimodal array
              const allText = convertedParts.every((p: any) => p.type === 'text');
              if (allText && convertedParts.length > 0) {
                content = convertedParts.map((p: any) => p.text).join('\n');
              } else {
                content = convertedParts;
              }
            }

            // Build message object
            const message: any = {
              role: item.role,
              content: content
            };

            // NOTE: Gemini does NOT support reasoning_content field - skip it
            // (Other providers like Kimi K2, o1, o3 use this for multi-turn reasoning)

            // Add tool_calls if present (unified format)
            // Tool calls are now part of message items, not separate items
            if (item.tool_calls && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
              message.tool_calls = item.tool_calls;
            }

            messages.push(message);
          } else if (item.type === 'function_call') {
            // Legacy support: Convert old function_call items to Chat Completions format
            messages.push({
              role: 'assistant',
              tool_calls: [{
                id: item.call_id || item.id,
                type: 'function',
                function: {
                  name: item.name,
                  arguments: item.arguments
                }
              }]
            });
          } else if (item.type === 'function_call_output') {
            // Convert function_call_output to Chat Completions tool message
            let content = item.output;
            if (typeof content !== 'string') {
              try {
                content = JSON.stringify(content);
              } catch (e) {
                content = String(content);
              }
            }
            messages.push({
              role: 'tool',
              tool_call_id: item.call_id,
              content: content
            });
          } else if (item.type === 'reasoning') {
            // Legacy reasoning items are skipped for Gemini
          }
        }
      }

      // Build chat completions request
      const requestParams: any = {
        model: this.currentModel,
        messages: messages,
        stream: true,
      };

      // Add tools if present
      let supplementalInstructions = '';

      if (transformedPrompt.tools && transformedPrompt.tools.length > 0) {
        // Convert to Chat Completions tool format
        // NOTE: Gemini does NOT support 'strict' field - omit it
        requestParams.tools = transformedPrompt.tools.map((tool: any) => {
          if (tool.type === 'function') {
            // Check for long description and add to supplemental instructions
            if (tool.function.description && tool.function.description.length > 1024) {
              supplementalInstructions += `\n\n### Tool Instructions: ${tool.function.name}\n${tool.function.description}`;
            }

            // Sanitize parameters schema for Gemini compatibility
            // This will also truncate the description in the tool definition
            const sanitizedParameters = this.sanitizeSchema(tool.function.parameters);

            // Truncate function description if needed
            let description = tool.function.description;
            if (description && description.length > 1024) {
              description = description.substring(0, 1021) + '...';
            }

            return {
              type: 'function',
              function: {
                name: tool.function.name,
                description: description,
                parameters: sanitizedParameters,
                // NOTE: 'strict' field omitted for Gemini compatibility
              }
            };
          }
          return tool;
        });

        requestParams.tool_choice = 'auto';
        // NOTE: parallel_tool_calls omitted for Gemini compatibility
      }

      // Append supplemental instructions to system message
      if (supplementalInstructions) {
        const systemMessageIndex = messages.findIndex(m => m.role === 'system');
        if (systemMessageIndex !== -1) {
          messages[systemMessageIndex].content += supplementalInstructions;
        } else {
          // If no system message exists, create one (though get_full_instructions usually ensures one exists)
          messages.unshift({
            role: 'system',
            content: supplementalInstructions.trim()
          });
        }
      }

      // Use OpenAI SDK's chat completions API with streaming
      const stream = await this.client.chat.completions.create(requestParams);

      // The SDK returns a Stream object which is AsyncIterable
      return stream as any as AsyncIterable<any>;
    } catch (error: any) {
      // Handle SDK errors and convert to ModelClientError
      const statusCode = error.status || error.statusCode || 500;
      const errorMessage = error.message || `${this.provider.name} Chat Completions API error`;

      throw new ModelClientError(
        errorMessage,
        statusCode,
        this.provider.name,
        (this as any).isRetryableHttpError(statusCode)
      );
    }
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
  /**
   * Sanitize JSON schema for Gemini compatibility
   * Ensures that all 'object' type schemas have a 'properties' field
   * Truncates descriptions to 1024 characters
   * Removes 'title' fields
   */
  private sanitizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') {
      return schema;
    }

    // Clone to avoid mutating original
    const sanitized = { ...schema };

    // Remove title field if present (can confuse Gemini)
    if ('title' in sanitized) {
      delete sanitized.title;
    }

    // Truncate description if too long
    if (sanitized.description && typeof sanitized.description === 'string' && sanitized.description.length > 1024) {
      sanitized.description = sanitized.description.substring(0, 1021) + '...';
    }

    // If type is object, ensure properties exists
    if (sanitized.type === 'object') {
      if (!sanitized.properties) {
        sanitized.properties = {};
        // Explicitly allow additional properties when properties are empty
        // This matches the intent of "any object"
        sanitized.additionalProperties = true;
      }
    }

    // Recursively sanitize properties
    if (sanitized.properties && schema.properties) {
      const sanitizedProps: any = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        sanitizedProps[key] = this.sanitizeSchema(value);
      }
      sanitized.properties = sanitizedProps;
      // Gemini recommends additionalProperties: false for defined objects
      if (sanitized.additionalProperties === undefined) {
        sanitized.additionalProperties = false;
      }
    }

    // Recursively sanitize array items
    if (sanitized.type === 'array' && sanitized.items) {
      sanitized.items = this.sanitizeSchema(sanitized.items);
    }

    return sanitized;
  }
}
