/**
 * OpenAI Chat Completion API client implementation for browserx-chrome
 * Uses official OpenAI SDK for Chat Completions API calls (supports OpenAI-compatible providers)
 */

import OpenAI from 'openai';
import {
  ModelClientError,
  type CompletionRequest,
  type RetryConfig,
} from '../ModelClient';
import { ResponseStream } from '../ResponseStream';
import type {
  ResponseEvent,
  Prompt,
  ModelFamily,
  ModelProviderInfo,
} from '../types/ResponsesAPI';
import type { TokenUsage } from '../types/TokenUsage';
import { get_full_instructions, get_formatted_input } from '../PromptHelpers';
import { GeminiLogger } from '../../utils/logger';
import { OpenAIResponsesClient } from './OpenAIResponsesClient';

/**
 * Authentication configuration for OpenAI Chat Completion API
 */
export interface OpenAIChatCompletionConfig {
  /** OpenAI API key (can be null - validation happens at request time) */
  apiKey: string | null;
  /** Base URL for API (defaults to OpenAI's endpoint) */
  baseUrl?: string;
  /** Organization ID */
  organization?: string;
  /** Conversation ID for session tracking */
  conversationId: string;
  /** Model family configuration */
  modelFamily: ModelFamily;
  /** Model provider information */
  provider: ModelProviderInfo;
}

/**
 * OpenAI Chat Completion API client using official OpenAI SDK
 * Supports OpenAI and OpenAI-compatible providers (e.g., Google AI Studio for Gemini)
 * Extends OpenAIResponsesClient to reuse common functionality
 */
export class OpenAIChatCompletionClient extends OpenAIResponsesClient {

  // Chat Completions streaming state
  // Tool calls arrive incrementally, so we need to accumulate them
  private chatCompletionToolCalls: Map<number, {
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }> = new Map();

  // Text content accumulator for Chat Completions API
  // Unlike Responses API which auto-accumulates, Chat Completions requires manual accumulation
  private chatCompletionTextContent: string = '';

  // Pending events queue for multi-event chunks
  // Some chunks need to emit multiple events (e.g., OutputItemDone + Completed)
  private pendingEvents: ResponseEvent[] = [];

  constructor(config: OpenAIChatCompletionConfig, retryConfig?: Partial<RetryConfig>) {
    // Convert OpenAIChatCompletionConfig to OpenAIResponsesConfig for parent constructor
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      organization: config.organization,
      conversationId: config.conversationId,
      modelFamily: config.modelFamily,
      provider: config.provider,
    }, retryConfig);

    // Gemini through Google AI Studio expects API key via `key` query param / X-Goog-Api-Key header.
    // Re-initialize client with custom headers if needed
    if (!config.provider.requires_openai_auth && config.apiKey) {
      this.client = new OpenAI({
        apiKey: config.apiKey || 'placeholder',
        baseURL: this.baseUrl,
        organization: this.organization,
        timeout: 360000,
        maxRetries: 0,
        defaultHeaders: {
          ...(config.provider.http_headers || {}),
          'X-Goog-Api-Key': config.apiKey,
        },
        defaultQuery: {
          ...(config.provider.query_params || {}),
          key: config.apiKey,
        },
      });
    }
  }

  /**
   * Stream a model response using the Chat Completions API
   * Overrides parent's Responses API implementation
   *
   * @param prompt The prompt containing input messages and tools
   * @returns Promise resolving to ResponseStream that yields ResponseEvent objects
   * @throws ModelClientError if prompt validation fails
   */
  async stream(prompt: Prompt): Promise<ResponseStream> {
    // Validate prompt
    if (!prompt.input || prompt.input.length === 0) {
      throw new ModelClientError('Prompt input is required');
    }

    // Retry logic with exponential backoff
    const maxRetries = this.provider.request_max_retries ?? 3;
    let attempt = 0;
    let lastError: any;

    while (attempt <= maxRetries) {
      try {
        // Make API request - returns ResponseStream immediately
        return await this.attemptStreamChat(attempt, prompt);
      } catch (error) {
        lastError = error;

        // Don't retry on the last attempt
        if (attempt === maxRetries) {
          break;
        }

        // Check for non-retryable errors (e.g., 401)
        if (error instanceof ModelClientError) {
          if (error.statusCode === 401) {
            throw error; // Don't retry auth errors
          }

          if (error.statusCode && error.statusCode < 500 && error.statusCode !== 429) {
            throw error; // Don't retry client errors except 429
          }
        }

        // Calculate backoff delay
        let retryAfter: number | undefined;
        if (error instanceof ModelClientError && error.retryAfter) {
          retryAfter = error.retryAfter;
        }

        const delay = this.calculateBackoff(attempt, retryAfter);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
      }
    }

    throw lastError;
  }

  /**
   * Stream responses from the model using Chat Completions API
   */
  protected async *streamResponses(request: CompletionRequest): AsyncGenerator<ResponseEvent> {
    // Convert CompletionRequest to Prompt
    const prompt: Prompt = {
      input: request.messages.map(msg => ({
        type: 'message' as const,
        role: msg.role,
        content: [{ type: 'text' as const, text: msg.content || '' }],
      })),
      tools: request.tools || [],
    };

    yield* this.streamChatInternal(prompt);
  }

  /**
   * Attempt a single streaming request without retry logic
   *
   * Uses OpenAI SDK's streaming API.
   * Returns a ResponseStream that will be populated asynchronously.
   *
   * @param attempt The attempt number (0-based) for logging/metrics
   * @param prompt The prompt to send
   * @returns Promise resolving to ResponseStream
   * @throws Error if the connection fails or response is invalid
   */
  protected async attemptStreamChat(
    attempt: number,
    prompt: Prompt
  ): Promise<ResponseStream> {
    // Make SDK streaming request - this will throw on connection errors (401, 429, etc.)
    const sdkStream = await this.makeChatCompletionsRequest(prompt);

    // Create stream and start processing asynchronously
    // Use 30-minute event timeout for LLM reasoning
    const stream = new ResponseStream(undefined, { eventTimeout: 1800000 });

    // Spawn async task to populate stream from SDK events
    (async () => {
      try {
        await this.processChatCompletionSDKStreamToResponseStream(sdkStream, stream);
        stream.complete();
      } catch (error) {
        stream.error(error as Error);
      }
    })();

    return stream;
  }

  /**
   * Stream Chat Completions using OpenAI Chat Completions API (internal method)
   */
  private async *streamChatInternal(prompt: Prompt): AsyncGenerator<ResponseEvent> {
    // Retry logic with exponential backoff
    const maxRetries = this.provider.request_max_retries ?? 3;
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;

      try {
        const sdkStream = await this.makeChatCompletionsRequest(prompt);

        // Process SDK stream and yield events
        yield* this.processChatCompletionSDKStream(sdkStream);
        return;

      } catch (error) {
        // Handle specific error cases
        if (error instanceof ModelClientError) {
          // Check for rate limiting
          if (error.statusCode === 429) {
            if (attempt > maxRetries) {
              throw error;
            }

            const delay = this.calculateBackoff(attempt - 1, error.retryAfter);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          // Check for auth errors
          if (error.statusCode === 401) {
            throw new ModelClientError('Authentication failed - check API key', 401, this.provider.name);
          }

          // Non-retryable errors
          if (error.statusCode && error.statusCode < 500 && error.statusCode !== 429) {
            throw error;
          }
        }

        // Retry on server errors or network issues
        if (attempt > maxRetries) {
          throw error;
        }

        const delay = this.calculateBackoff(attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Process Chat Completions SDK stream as AsyncGenerator (for streamChatInternal)
   * The SDK handles SSE parsing and returns structured events
   *
   * @param sdkStream Async iterable from OpenAI SDK
   */
  private async *processChatCompletionSDKStream(
    sdkStream: AsyncIterable<any>
  ): AsyncGenerator<ResponseEvent> {
    try {
      for await (const chunk of sdkStream) {
        // The SDK returns structured event objects
        // Convert SDK event format to our ResponseEvent format
        const responseEvent = this.convertChatCompletionEventToResponseEvent(chunk);

        if (responseEvent) {
          yield responseEvent;
        }
      }

      // Flush any pending events after stream ends
      // (e.g., Completed event queued after OutputItemDone for tool calls)
      while (this.pendingEvents.length > 0) {
        const pendingEvent = this.pendingEvents.shift()!;
        yield pendingEvent;
      }
    } catch (error) {
      console.error('[OpenAIChatCompletionClient] SDK stream error:', error);
      throw error;
    }
  }

  /**
   * Process Chat Completions SDK stream and convert to ResponseStream
   * The SDK handles SSE parsing and returns structured events
   *
   * @param sdkStream Async iterable from OpenAI SDK
   * @param stream ResponseStream to populate with events
   */
  private async processChatCompletionSDKStreamToResponseStream(
    sdkStream: AsyncIterable<any>,
    stream: ResponseStream
  ): Promise<void> {
    let completedEmitted = false;

    try {
      for await (const chunk of sdkStream) {
        // The SDK returns structured event objects
        // Convert SDK event format to our ResponseEvent format
        const responseEvent = this.convertChatCompletionEventToResponseEvent(chunk);

        if (responseEvent) {
          stream.addEvent(responseEvent);

          // Track if we've emitted Completed
          if (responseEvent.type === 'Completed') {
            completedEmitted = true;
          }
        }
      }

      // Flush any pending events after stream ends
      // (e.g., Completed event queued after OutputItemDone for tool calls)
      const pendingCount = this.pendingEvents.length;
      if (pendingCount > 0) {
        GeminiLogger.debug('Flushing pending events', { count: pendingCount });
      }

      while (this.pendingEvents.length > 0) {
        const pendingEvent = this.pendingEvents.shift()!;
        GeminiLogger.debug('Flushing event', { type: pendingEvent.type });
        stream.addEvent(pendingEvent);

        // Track if we've emitted Completed
        if (pendingEvent.type === 'Completed') {
          completedEmitted = true;
        }
      }

      // Safety check: ensure Completed event is always emitted
      // This prevents "stream closed before response.completed" errors
      if (!completedEmitted) {
        console.warn('[OpenAIChatCompletionClient] Stream ended without Completed event, emitting fallback');
        GeminiLogger.debug('Emitting fallback Completed event');
        stream.addEvent({
          type: 'Completed',
          responseId: 'fallback',
          tokenUsage: undefined,
        });
      }
    } catch (error) {
      console.error('[OpenAIChatCompletionClient] SDK stream error:', error);
      throw error;
    }
  }

  /**
   * Convert Chat Completions streaming event to ResponseEvent format
   *
   * Chat Completions streaming format:
   * - Text comes in delta.content chunks
   * - Tool calls come incrementally: first chunk has id+name, subsequent chunks have argument pieces
   * - finish_reason signals completion: "stop", "length", "tool_calls", etc.
   * - Usage info comes in the final chunk (when finish_reason is set)
   */
  private convertChatCompletionEventToResponseEvent(chatEvent: any): ResponseEvent | null {
    // Debug logging for Gemini responses
    if (this.provider.name === 'Google AI Studio') {
      console.log('[Gemini Debug] Raw chunk:', JSON.stringify(chatEvent, null, 2));
    }

    // Check if we have pending events from previous chunk
    if (this.pendingEvents.length > 0) {
      const pendingEvent = this.pendingEvents.shift()!;
      GeminiLogger.debug('Returning pending event', { type: pendingEvent.type, remaining: this.pendingEvents.length });
      return pendingEvent;
    }

    const choice = chatEvent.choices?.[0];
    if (!choice) {
      console.log('[Gemini Debug] No choice in chunk');
      return null;
    }

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    console.log('[Gemini Debug] Delta:', delta, 'FinishReason:', finishReason);

    // Handle text content deltas
    if (delta?.content) {
      // Accumulate text content for message item creation
      this.chatCompletionTextContent += delta.content;

      // Trace logging for text accumulation
      GeminiLogger.textAccumulated(delta.content, this.chatCompletionTextContent.length);
      GeminiLogger.textDelta(delta.content, this.chatCompletionTextContent.length);

      return {
        type: 'OutputTextDelta',
        delta: delta.content,
      };
    }

    // Handle tool call deltas (accumulate incrementally)
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index ?? 0;

        // Get or create accumulated tool call
        let accumulated = this.chatCompletionToolCalls.get(index);
        if (!accumulated) {
          accumulated = {
            id: '',
            type: 'function',
            function: {
              name: '',
              arguments: '',
            },
          };
          this.chatCompletionToolCalls.set(index, accumulated);
        }

        // Accumulate fields
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

      // Don't emit event yet - fall through to check finish_reason in same chunk
      // (Gemini sends both tool_calls and finish_reason in the same chunk)
      // If there's no finish_reason in this chunk, we'll return null at the end
    }

    // Handle completion with finish_reason
    if (finishReason) {
      const completedEvent: ResponseEvent = {
        type: 'Completed',
        responseId: chatEvent.id || '',
        tokenUsage: chatEvent.usage ? this.convertChatCompletionUsageToTokenUsage(chatEvent.usage) : undefined,
      };

      // Trace logging for finish reason
      const hasContent = this.chatCompletionTextContent.length > 0;
      const hasToolCalls = this.chatCompletionToolCalls.size > 0;
      GeminiLogger.finishReason(finishReason, hasContent, hasToolCalls);

      // If tool_calls finish reason, emit OutputItemDone first, then Completed
      if (finishReason === 'tool_calls') {
        const toolCallsArray = Array.from(this.chatCompletionToolCalls.values());

        // Clear accumulated tool calls for next request
        this.chatCompletionToolCalls.clear();

        // Handle mixed content case: text + tool calls
        // When Gemini returns text followed by tool calls, the text was already emitted as deltas
        // We need to emit it as a message item too, then emit the tool call
        if (hasContent && toolCallsArray.length > 0) {
          // Create message item for the accumulated text
          const messageItem = {
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: this.chatCompletionTextContent,
              },
            ],
          };

          // Clear text for next request
          this.chatCompletionTextContent = '';

          GeminiLogger.messageItemEmitted(messageItem.content[0].text.length);

          // Queue tool call OutputItemDone
          const toolCall = toolCallsArray[0];
          this.pendingEvents.push({
            type: 'OutputItemDone',
            item: {
              type: 'function_call',
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          });
          GeminiLogger.debug('Queued tool call OutputItemDone', { toolName: toolCall.function.name });

          // Queue Completed event
          this.pendingEvents.push(completedEvent);
          GeminiLogger.debug('Queued Completed event', { pendingCount: this.pendingEvents.length });

          // Return message OutputItemDone first
          return {
            type: 'OutputItemDone',
            item: messageItem,
          };
        }

        // Emit OutputItemDone for the tool call, queue Completed for next iteration
        // Note: Chat Completions can have parallel_tool_calls, but BrowserX sets it to false
        // so we should only have one tool call at a time
        if (toolCallsArray.length > 0) {
          const toolCall = toolCallsArray[0];

          if (toolCallsArray.length > 1) {
            console.warn('[OpenAIChatCompletionClient] Multiple tool calls detected, but only emitting first one:', toolCallsArray);
          }

          // Trace logging for tool call emission
          GeminiLogger.functionCallItemEmitted(
            toolCallsArray.length,
            toolCallsArray.map(tc => tc.function.name)
          );

          // Clear any accumulated text (it was just for "thinking out loud")
          this.chatCompletionTextContent = '';

          // Queue the Completed event for next call
          this.pendingEvents.push(completedEvent);
          GeminiLogger.debug('Queued Completed event (tool calls only)', { pendingCount: this.pendingEvents.length });

          // Return the OutputItemDone event immediately
          return {
            type: 'OutputItemDone',
            item: {
              type: 'function_call',
              call_id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          };
        }

        // If no tool calls accumulated, just emit completion
        // Clear text just in case
        this.chatCompletionTextContent = '';
        return completedEvent;
      }

      // Handle finish_reason='stop'
      //
      // ROOT CAUSE: Chat Completions API emits text as delta.content chunks
      // but does NOT auto-create message items like Responses API does. Without this fix,
      // text deltas would be displayed in UI but never stored in conversation history,
      // causing TurnManager to receive empty processedItems[] and show "Task completed"
      // without any visible response text.
      //
      // FIX: Manually accumulate text in chatCompletionTextContent during streaming,
      // then create message item with accumulated text when finish_reason='stop'.
      // This mirrors the tool call handling pattern (accumulate -> create item -> emit).
      if (finishReason === 'stop' || finishReason === 'length') {
        // Check if we have accumulated text content
        if (hasContent) {
          // Create message item with accumulated text
          const messageItem = {
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: this.chatCompletionTextContent,
              },
            ],
          };

          // Clear accumulated text for next request
          this.chatCompletionTextContent = '';

          // Trace logging for message item emission
          GeminiLogger.messageItemEmitted(messageItem.content[0].text.length);

          // Queue Completed event for next call
          this.pendingEvents.push(completedEvent);
          GeminiLogger.debug('Queued Completed event (stop)', { pendingCount: this.pendingEvents.length });

          // Return OutputItemDone with message item immediately
          return {
            type: 'OutputItemDone',
            item: messageItem,
          };
        }

        // Validation - empty response handling
        // If no content and no tool calls, log warning
        if (!hasContent && !hasToolCalls) {
          GeminiLogger.validationWarning(
            'Empty response detected: finish_reason=stop but no content or tool calls',
            { finishReason, responseId: chatEvent.id }
          );
          console.warn('[OpenAIChatCompletionClient] Empty response with finish_reason=stop, skipping OutputItemDone');
        }
      }

      // Clear tool calls state for next request
      this.chatCompletionToolCalls.clear();
      // Also clear text content if not already cleared
      this.chatCompletionTextContent = '';

      // Emit completion event for other finish reasons or fallback
      GeminiLogger.completedEmitted(completedEvent.tokenUsage);
      return completedEvent;
    }

    return null;
  }

  /**
   * Convert Chat Completions usage format to internal TokenUsage format
   */
  private convertChatCompletionUsageToTokenUsage(usage: any): TokenUsage {
    return {
      input_tokens: usage.prompt_tokens || 0,
      cached_input_tokens: usage.prompt_tokens_details?.cached_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      reasoning_output_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    };
  }

  /**
   * Make streaming request to Chat Completions API
   * Used for providers that support the OpenAI Chat Completions endpoint (Gemini, etc.)
   * Returns an async iterable stream converted to ResponseEvent format
   */
  private async makeChatCompletionsRequest(prompt: Prompt): Promise<AsyncIterable<any>> {
    // Validate API key before making request
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError(`No API key configured for provider: ${this.provider.name}`);
    }

    try {
      // Reset streaming state before starting new request
      this.chatCompletionTextContent = '';
      this.chatCompletionToolCalls.clear();
      GeminiLogger.stateReset();
      GeminiLogger.streamStart(this.currentModel, this.conversationId);

      // Convert Prompt to Chat Completions format
      const messages: any[] = [];

      // Get full instructions including base instructions and overrides
      const fullInstructions = get_full_instructions(prompt, this.modelFamily);

      // Add system message if instructions exist
      if (fullInstructions) {
        messages.push({
          role: 'system',
          content: fullInstructions
        });
      }

      // Convert input array to messages
      const formattedInput = await get_formatted_input(prompt);
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

            messages.push({
              role: item.role,
              content: content
            });
          } else if (item.type === 'function_call') {
            // Convert function_call to Chat Completions assistant message with tool_calls
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
            messages.push({
              role: 'tool',
              tool_call_id: item.call_id,
              content: item.output
            });
          }
          // Note: 'reasoning' items are not sent (provider generates its own reasoning)
          // Other item types (web_search_call, etc.) are also omitted
        }
      }

      console.log('[Debug] Converted messages:', JSON.stringify(messages, null, 2));

      // Build chat completions request
      const requestParams: any = {
        model: this.currentModel,
        messages: messages,
        stream: true,
      };

      // Add tools if present
      if (prompt.tools && prompt.tools.length > 0) {
        // Convert to Chat Completions tool format
        requestParams.tools = prompt.tools.map((tool: any) => {
          if (tool.type === 'function') {
            return {
              type: 'function',
              function: {
                name: tool.function.name,
                description: tool.function.description,
                parameters: tool.function.parameters,
                strict: tool.function.strict || false
              }
            };
          }
          return tool;
        });

        requestParams.tool_choice = 'auto';
        requestParams.parallel_tool_calls = false;

        console.log('[Debug] Converted tools:', JSON.stringify(requestParams.tools, null, 2));
      }

      console.log('[Debug] Final request params:', JSON.stringify({
        model: requestParams.model,
        messageCount: requestParams.messages.length,
        toolCount: requestParams.tools?.length || 0,
        stream: requestParams.stream
      }, null, 2));

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
        this.isRetryableHttpError(statusCode)
      );
    }
  }

  /**
   * Cleanup resources
   */
  public async cleanup(): Promise<void> {
    // Reset streaming state
    this.chatCompletionTextContent = '';
    this.chatCompletionToolCalls.clear();
    this.pendingEvents = [];
  }
}
