/**
 * OpenAI Chat Completion API client implementation for browserx-chrome
 * Uses official OpenAI SDK for Chat Completions API calls (supports compatible providers)
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
import { OpenAIResponsesClient } from './OpenAIResponsesClient';

import type { IModelConfig } from '../../config/types';

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
  /** Model configuration from AgentConfig */
  modelConfig?: IModelConfig;
  /** Use credentials (cookies) for authentication - for backend routing */
  useCredentials?: boolean;
}

/**
 * OpenAI Chat Completion API client using official OpenAI SDK
 * Supports OpenAI and compatible providers
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

  // Reasoning content accumulator for thinking models (Kimi K2, o1, o3)
  // Accumulates delta.reasoning_content chunks before emitting as complete reasoning item
  private chatCompletionReasoningContent: string = '';

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
      modelConfig: config.modelConfig,
      useCredentials: config.useCredentials,
    }, retryConfig);

    // Backend routing: rewrite /chat/completions to /completions
    if (config.useCredentials) {
      const customFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        let urlObj: URL;

        // Robustly convert to URL object
        if (url instanceof URL) {
          urlObj = new URL(url.href);
        } else if (typeof Request !== 'undefined' && url instanceof Request) {
          urlObj = new URL(url.url);
        } else {
          urlObj = new URL(String(url));
        }

        // Remove the dummy API key that we injected
        urlObj.searchParams.delete('key');

        const fetchInit = { ...init, credentials: 'include' as RequestCredentials };
        const response = await fetch(urlObj.toString(), fetchInit);

        if (!response.ok) {
          const clonedResponse = response.clone();
          try {
            const body = await clonedResponse.text();
            if (body) {
              const errorData = JSON.parse(body);
              if (errorData.detail && !errorData.error) {
                const transformedBody = JSON.stringify({
                  error: {
                    message: errorData.detail,
                    type: 'api_error',
                    code: response.status.toString(),
                  },
                });
                return new Response(transformedBody, {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers,
                });
              }
            }
          } catch {
            // If we can't parse the body, let the original response through
          }
        }
        return response;
      };

      this.client = new OpenAI({
        apiKey: 'backend-routed',
        baseURL: this.baseUrl ? `${this.baseUrl.replace(/\/+$/, '')}` : this.baseUrl,
        dangerouslyAllowBrowser: true,
        timeout: 360000,
        maxRetries: 0,
        fetch: customFetch,
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
      while (this.pendingEvents.length > 0) {
        const pendingEvent = this.pendingEvents.shift()!;
        stream.addEvent(pendingEvent);

        // Track if we've emitted Completed
        if (pendingEvent.type === 'Completed') {
          completedEmitted = true;
        }
      }

      // Safety check: ensure Completed event is always emitted
      // This prevents "stream closed before response.completed" errors
      if (!completedEmitted) {
        // Fallback: If we have accumulated content or tool_calls, emit them as OutputItemDone
        // before emitting the Completed event
        const hasAccumulatedContent = this.chatCompletionTextContent.length > 0;
        const hasAccumulatedToolCalls = this.chatCompletionToolCalls.size > 0;
        const hasAccumulatedReasoning = this.chatCompletionReasoningContent.length > 0;

        if (hasAccumulatedContent || hasAccumulatedToolCalls || hasAccumulatedReasoning) {
          // Build content array
          const contentArray: any[] = [];
          if (hasAccumulatedContent) {
            contentArray.push({
              type: 'output_text' as const,
              text: this.chatCompletionTextContent,
            });
          }

          // Build tool_calls array
          let toolCallsArray: any[] | undefined;
          if (hasAccumulatedToolCalls) {
            toolCallsArray = Array.from(this.chatCompletionToolCalls.values());
          }

          // Create unified message item
          const messageItem: any = {
            type: 'message' as const,
            role: 'assistant' as const,
            content: contentArray,
          };

          // Add reasoning_content if present
          if (hasAccumulatedReasoning) {
            messageItem.reasoning_content = this.chatCompletionReasoningContent;
          }

          // Add tool_calls if present
          if (toolCallsArray && toolCallsArray.length > 0) {
            messageItem.tool_calls = toolCallsArray;
          }

          // Clear accumulated state
          this.chatCompletionTextContent = '';
          this.chatCompletionReasoningContent = '';
          this.chatCompletionToolCalls.clear();

          // Emit OutputItemDone with the accumulated content
          stream.addEvent({
            type: 'OutputItemDone',
            item: messageItem,
          });
        }

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
  protected convertChatCompletionEventToResponseEvent(chatEvent: any): ResponseEvent | null {
    // Check if we have pending events from previous chunk
    if (this.pendingEvents.length > 0) {
      const pendingEvent = this.pendingEvents.shift()!;
      return pendingEvent;
    }

    const choice = chatEvent.choices?.[0];
    if (!choice) {
      return null;
    }

    const delta = choice.delta;
    const finishReason = choice.finish_reason;

    // Handle reasoning content deltas (for thinking models like Kimi K2)
    // Reasoning content comes before regular content and represents the model's thinking process
    if (delta?.reasoning_content) {
      // Accumulate reasoning content for final message item
      // NOTE: We do NOT emit ReasoningContentDelta events here because:
      // 1. ReasoningContentDelta is a Responses API event type
      // 2. Chat Completions API should accumulate silently and include in final message item
      // 3. The reasoning_content will be stored in the message item and sent back to API
      this.chatCompletionReasoningContent += delta.reasoning_content;

      // Return null to continue processing without emitting an event
      return null;
    }

    // Handle text content deltas
    if (delta?.content) {
      // Accumulate text content for message item creation
      this.chatCompletionTextContent += delta.content;

      // CRITICAL FIX: Only return OutputTextDelta if there's NO finish_reason in this chunk
      // If finish_reason is present, we need to fall through to handle it below
      // This fixes the bug where content + finish_reason in same chunk causes early return
      if (!finishReason) {
        return {
          type: 'OutputTextDelta',
          delta: delta.content,
        };
      }

      // If we reach here, both content AND finish_reason are in the same chunk
      // Don't return OutputTextDelta - fall through to finish_reason handling
      // The accumulated text will be emitted as part of the OutputItemDone message
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
      // If there's no finish_reason in this chunk, we'll return null at the end
    }

    // Handle completion with finish_reason
    // NEW APPROACH: Create ONE unified message item with all accumulated parts
    // (reasoning_content, content, tool_calls) instead of separate items
    if (finishReason) {
      // Extract usage data - some APIs (like Moonshot) put usage in choices[0].usage instead of top-level usage
      const usage = chatEvent.usage || chatEvent.choices?.[0]?.usage;

      const completedEvent: ResponseEvent = {
        type: 'Completed',
        responseId: chatEvent.id || '',
        tokenUsage: usage ? this.convertChatCompletionUsageToTokenUsage(usage) : undefined,
      };

      // Check what we have accumulated
      const hasReasoning = this.chatCompletionReasoningContent.length > 0;
      const hasContent = this.chatCompletionTextContent.length > 0;
      const hasToolCalls = this.chatCompletionToolCalls.size > 0;

      // If we have any content (reasoning, text, or tool calls), create a unified message item
      if (hasReasoning || hasContent || hasToolCalls) {
        // Build content array (may be empty if only tool calls)
        const contentArray: any[] = [];
        if (hasContent) {
          contentArray.push({
            type: 'output_text' as const,
            text: this.chatCompletionTextContent,
          });
        }

        // Build tool_calls array (may be undefined if no tool calls)
        let toolCallsArray: any[] | undefined;
        if (hasToolCalls) {
          toolCallsArray = Array.from(this.chatCompletionToolCalls.values());

          if (toolCallsArray.length > 1) {
            console.warn('[OpenAIChatCompletionClient] Multiple tool calls detected, but BrowserX uses parallel_tool_calls=false:', toolCallsArray);
          }
        }

        // Create unified message item with all parts
        const messageItem: any = {
          type: 'message' as const,
          role: 'assistant' as const,
          content: contentArray,
        };

        // Add reasoning_content if present (for Kimi K2, o1, o3)
        if (hasReasoning) {
          messageItem.reasoning_content = this.chatCompletionReasoningContent;
        }

        // Add tool_calls if present
        if (toolCallsArray && toolCallsArray.length > 0) {
          messageItem.tool_calls = toolCallsArray;
        }

        // Clear all accumulated state for next request
        this.chatCompletionTextContent = '';
        this.chatCompletionReasoningContent = '';
        this.chatCompletionToolCalls.clear();

        // Queue Completed event
        this.pendingEvents.push(completedEvent);

        // Return unified message item
        return {
          type: 'OutputItemDone',
          item: messageItem,
        };
      }

      // Clear state just in case
      this.chatCompletionTextContent = '';
      this.chatCompletionReasoningContent = '';
      this.chatCompletionToolCalls.clear();

      // Emit completion event
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
      // Support both OpenAI format (prompt_tokens_details.cached_tokens) and Moonshot format (cached_tokens)
      cached_input_tokens: usage.prompt_tokens_details?.cached_tokens || usage.cached_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      reasoning_output_tokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    };
  }

  /**
   * Normalize tool call arguments to ensure they're always a valid JSON string.
   * Handles cases where arguments might be undefined, already an object, or invalid.
   */
  private normalizeToolCallArguments(args: any): string {
    // If undefined or null, return empty object JSON
    if (args === undefined || args === null) {
      return '{}';
    }
    // If already a string, validate it's valid JSON
    if (typeof args === 'string') {
      try {
        JSON.parse(args);
        return args;
      } catch {
        // Invalid JSON string - wrap it as an object
        console.warn('[OpenAIChatCompletionClient] Invalid JSON in tool call arguments, wrapping:', args);
        return JSON.stringify({ _raw: args });
      }
    }
    // If an object, stringify it
    if (typeof args === 'object') {
      return JSON.stringify(args);
    }
    // For any other type, wrap it
    return JSON.stringify({ _value: args });
  }

  /**
   * Make streaming request to Chat Completions API
   * Returns an async iterable stream converted to ResponseEvent format
   */
  protected async makeChatCompletionsRequest(prompt: Prompt): Promise<AsyncIterable<any>> {
    // Validate API key before making request
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError(`No API key configured for provider: ${this.provider.name}`);
    }

    try {
      // Reset streaming state before starting new request
      this.chatCompletionTextContent = '';
      this.chatCompletionReasoningContent = '';
      this.chatCompletionToolCalls.clear();

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

            // Build message object
            const message: any = {
              role: item.role,
              content: content
            };

            // Add reasoning_content if present (for Kimi K2, o1, o3, etc.)
            // This preserves the thinking/reasoning context for multi-turn conversations
            if (item.reasoning_content) {
              message.reasoning_content = item.reasoning_content;
            }

            // Add tool_calls if present (unified format)
            // Tool calls are now part of message items, not separate items
            if (item.tool_calls && Array.isArray(item.tool_calls) && item.tool_calls.length > 0) {
              // Validate and normalize tool_call arguments to ensure they're valid JSON strings
              message.tool_calls = item.tool_calls.map((tc: any) => ({
                ...tc,
                function: {
                  ...tc.function,
                  arguments: this.normalizeToolCallArguments(tc.function?.arguments)
                }
              }));
            }

            messages.push(message);
          } else if (item.type === 'function_call') {
            // Legacy support: Convert old function_call items to Chat Completions format
            // NOTE: New responses use message items with tool_calls field instead
            messages.push({
              role: 'assistant',
              tool_calls: [{
                id: item.call_id || item.id,
                type: 'function',
                function: {
                  name: item.name,
                  arguments: this.normalizeToolCallArguments(item.arguments)
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
          } else if (item.type === 'reasoning') {
            // Legacy reasoning items are skipped
            // New format includes reasoning_content directly in message items
            // Keep reasoning items in history for backward compatibility but don't send to API
          }
          // Note: Other item types (web_search_call, etc.) are omitted
        }
      }

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
      }

      // Use OpenAI SDK's chat completions API with streaming
      const stream = await this.client.chat.completions.create(requestParams);

      // The SDK returns a Stream object which is AsyncIterable
      return stream as any as AsyncIterable<any>;
    } catch (error: any) {
      // Handle SDK errors and convert to ModelClientError with extracted details
      throw this.toModelClientError(error, `${this.provider.name} Chat Completions API error`);
    }
  }

  /**
   * Cleanup resources
   */
  public async cleanup(): Promise<void> {
    // Reset streaming state
    this.chatCompletionTextContent = '';
    this.chatCompletionReasoningContent = '';
    this.chatCompletionToolCalls.clear();
    this.pendingEvents = [];
  }
}
