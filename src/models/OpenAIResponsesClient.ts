/**
 * OpenAI Responses API client implementation for browserx-chrome
 * Implements the experimental /v1/responses endpoint with SSE streaming
 */

import {
  ModelClient,
  ModelClientError,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk,
  type RetryConfig,
} from './ModelClient';
import { ResponseStream } from './ResponseStream';
import type {
  ResponseEvent,
  ResponsesApiRequest,
  Prompt,
  ModelFamily,
  ModelProviderInfo,
  Reasoning,
  TextControls,
  ReasoningEffortConfig,
  ReasoningSummaryConfig,
  OpenAiVerbosity,
  TextFormat,
  TextFormatType,
} from './types/ResponsesAPI';
import type { RateLimitSnapshot } from './types/RateLimits';
import type { TokenUsage } from './types/TokenUsage';
import { SSEEventParser } from './SSEEventParser';
import { RequestQueue, RequestPriority, type QueuedRequest } from './RequestQueue';
import { get_full_instructions, get_formatted_input } from './PromptHelpers';

/**
 * SSE Event structure from OpenAI Responses API
 */
interface SseEvent {
  type: string;
  response?: any;
  item?: any;
  delta?: string;
}

/**
 * Response completed structure from SSE stream
 */
interface ResponseCompleted {
  id: string;
  usage?: ResponseCompletedUsage;
}

/**
 * Usage information from completed response
 */
interface ResponseCompletedUsage {
  input_tokens: number;
  input_tokens_details?: {
    cached_tokens: number;
  };
  output_tokens: number;
  output_tokens_details?: {
    reasoning_tokens: number;
  };
  total_tokens: number;
}

/**
 * Authentication configuration for OpenAI Responses API
 */
export interface OpenAIResponsesConfig {
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
  /** Reasoning effort configuration */
  reasoningEffort?: ReasoningEffortConfig;
  /** Reasoning summary configuration */
  reasoningSummary?: ReasoningSummaryConfig;
  /** Model verbosity setting */
  modelVerbosity?: OpenAiVerbosity;
}

/**
 * OpenAI Responses API client implementing experimental /v1/responses endpoint
 */
export class OpenAIResponsesClient extends ModelClient {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly organization?: string;
  private readonly conversationId: string;
  private readonly modelFamily: ModelFamily;
  private readonly provider: ModelProviderInfo;
  private reasoningEffort?: ReasoningEffortConfig;
  private reasoningSummary?: ReasoningSummaryConfig;
  private modelVerbosity?: OpenAiVerbosity;
  private currentModel: string;

  // Performance optimizations (Phase 9)
  private sseParser: SSEEventParser;
  private requestQueue: RequestQueue | null = null;
  private queueEnabled: boolean = false;

  constructor(config: OpenAIResponsesConfig, retryConfig?: Partial<RetryConfig>) {
    super(retryConfig);

    // Don't validate API key in constructor - validation happens when making requests
    // This allows the model client to be created before API key is configured

    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.organization = config.organization;
    this.conversationId = config.conversationId;
    this.modelFamily = config.modelFamily;
    this.provider = config.provider;
    this.reasoningEffort = config.reasoningEffort;
    this.reasoningSummary = config.reasoningSummary;
    this.modelVerbosity = config.modelVerbosity;
    this.currentModel = config.modelFamily.family;

    // Initialize performance optimizations
    this.sseParser = new SSEEventParser();

    // Initialize request queue if rate limiting is needed
    // Note: requestsPerMinute/requestsPerHour not in base ModelProviderInfo type yet
    // TODO: Add to ModelProviderInfo interface
    const providerAny = this.provider as any;
    if (providerAny.requestsPerMinute || providerAny.requestsPerHour) {
      this.requestQueue = new RequestQueue({
        requestsPerMinute: providerAny.requestsPerMinute || 60,
        requestsPerHour: providerAny.requestsPerHour || 1000,
        burstLimit: Math.min(providerAny.requestsPerMinute || 10, 10),
      });
      this.queueEnabled = true;
    }
  }

  getProvider(): ModelProviderInfo {
    return this.provider;
  }

  getModel(): string {
    return this.currentModel;
  }

  setModel(model: string): void {
    this.currentModel = model;
  }

  getModelContextWindow(): number | undefined {
    // Return context window sizes for known OpenAI models
    const contextWindows: Record<string, number> = {
      'gpt-4': 8192,
      'gpt-4-32k': 32768,
      'gpt-4-turbo': 128000,
      'gpt-4o': 128000,
      'gpt-5': 200000,
      'gpt-3.5-turbo': 4096,
      'gpt-3.5-turbo-16k': 16384,
    };
    return contextWindows[this.currentModel];
  }

  getAutoCompactTokenLimit(): number | undefined {
    const contextWindow = this.getModelContextWindow();
    return contextWindow ? Math.floor(contextWindow * 0.8) : undefined;
  }

  getModelFamily(): ModelFamily {
    return this.modelFamily;
  }

  getAuthManager(): any {
    // Chrome extension doesn't use auth manager - returns undefined
    return undefined;
  }

  getReasoningEffort(): ReasoningEffortConfig | undefined {
    return this.reasoningEffort;
  }

  setReasoningEffort(effort: ReasoningEffortConfig): void {
    this.reasoningEffort = effort;
  }

  getReasoningSummary(): ReasoningSummaryConfig | undefined {
    return this.reasoningSummary;
  }

  setReasoningSummary(summary: ReasoningSummaryConfig): void {
    this.reasoningSummary = summary;
  }

  // Basic ModelClient interface methods (delegated to streamResponses)
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    throw new ModelClientError('Direct completion not supported by Responses API - use streamResponses instead');
  }

  /**
   * Stream a model response using the Responses API
   *
   * This method creates and returns a ResponseStream that will emit ResponseEvent
   * objects as the model generates its response. The stream is returned immediately,
   * with events being added asynchronously as they arrive from the API.
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

    // Build request payload
    const fullInstructions = this.getFullInstructions(prompt);

    const toolsJson = this.createToolsJsonForResponsesApi(prompt.tools);

    const reasoning = this.createReasoningParam();
    const textControls = this.createTextParam(prompt.output_schema);

    const include: string[] = reasoning ? ['reasoning.encrypted_content'] : [];
    const azureWorkaround = (this.provider.base_url && this.provider.base_url.indexOf('azure') !== -1) || false;

    const payload: ResponsesApiRequest = {
      model: this.currentModel,
      instructions: fullInstructions,
      input: await get_formatted_input(prompt),
      tools: toolsJson,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning,
      store: azureWorkaround,
      stream: true,
      include,
      prompt_cache_key: this.conversationId,
      text: textControls,
    };

    // Retry logic with exponential backoff
    const maxRetries = this.provider.request_max_retries ?? 3;
    let attempt = 0;
    let lastError: any;

    while (attempt <= maxRetries) {
      try {
        // Make API request - returns ResponseStream immediately
        return await this.attemptStreamResponses(attempt, payload);
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

  async *streamCompletion(request: CompletionRequest): AsyncGenerator<ResponseEvent> {
    yield* this.streamResponses(request);
  }

  countTokens(text: string, model: string): number {
    // Simple approximation - in production would use tiktoken
    const multiplier = 1.3; // Average token multiplier for OpenAI models
    const words = text.split(/\s+/).length;
    const punctuation = (text.match(/[.!?;:,]/g) || []).length;
    return Math.ceil((words + punctuation * 0.5) * multiplier);
  }

  /**
   * Stream responses from the model using appropriate wire API
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

    yield* this.streamResponsesInternal(prompt);
  }

  /**
   * Chat completions streaming (not supported by Responses API)
   */
  protected async *streamChat(request: CompletionRequest): AsyncGenerator<ResponseEvent> {
    throw new ModelClientError('Chat completions not supported by Responses API - use OpenAIClient instead');
  }

  /**
   * Attempt a single streaming request without retry logic
   *
   * This method makes a single attempt to create a streaming connection.
   * It makes the HTTP request synchronously (throwing on connection errors),
   * then returns a ResponseStream that will be populated asynchronously.
   *
   * @param attempt The attempt number (0-based) for logging/metrics
   * @param payload The API request payload
   * @returns Promise resolving to ResponseStream
   * @throws Error if the connection fails or response is invalid
   */
  protected async attemptStreamResponses(
    attempt: number,
    payload: any
  ): Promise<ResponseStream> {
    // Make HTTP request - this will throw on connection errors (401, 429, etc.)
    const response = await this.makeResponsesApiRequest(payload);

    if (!response.body) {
      throw new ModelClientError('Response body is null');
    }

    // Create stream and start processing asynchronously
    // Use 30-minute event timeout for LLM reasoning (extended for reasoning models like o1)
    // Reasoning models can take >5 minutes without sending events during complex reasoning
    const stream = new ResponseStream(undefined, { eventTimeout: 1800000 });

    // Spawn async task to populate stream from SSE
    (async () => {
      try {
        await this.processSSEToStream(response.body!, response.headers, stream);
        stream.complete();
      } catch (error) {
        stream.error(error as Error);
      }
    })();

    return stream;
  }

  /**
   * Stream responses using OpenAI Responses API (internal method)
   * Main method implementing the experimental /v1/responses endpoint
   */
  private async *streamResponsesInternal(prompt: Prompt): AsyncGenerator<ResponseEvent> {
    const fullInstructions = this.getFullInstructions(prompt);
    const toolsJson = this.createToolsJsonForResponsesApi(prompt.tools);
    const reasoning = this.createReasoningParam();
    const textControls = this.createTextParam(prompt.output_schema);

    const include: string[] = reasoning ? ['reasoning.encrypted_content'] : [];

    // Determine store setting (Azure workaround logic)
    const azureWorkaround = (this.provider.base_url && this.provider.base_url.indexOf('azure') !== -1) || false;

    const payload: ResponsesApiRequest = {
      model: this.currentModel,
      instructions: fullInstructions,
      input: await get_formatted_input(prompt),
      tools: toolsJson,
      tool_choice: 'auto',
      parallel_tool_calls: false,
      reasoning,
      store: azureWorkaround,
      stream: true,
      include,
      prompt_cache_key: this.conversationId,
      text: textControls,
    };

    // Retry logic with exponential backoff
    const maxRetries = this.provider.request_max_retries ?? 3;
    let attempt = 0;

    while (attempt <= maxRetries) {
      attempt++;

      try {
        const response = await this.makeResponsesApiRequest(payload);

        if (!response.body) {
          throw new ModelClientError('Response body is null');
        }

        // Process SSE stream
        yield* this.processSSE(response.body, response.headers);
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
   * Process Server-Sent Events stream and populate ResponseStream
   *
   * This method processes the SSE stream from the API and adds events to the
   * provided ResponseStream.
   *
   * @param body ReadableStream from fetch response
   * @param headers HTTP response headers
   * @param stream ResponseStream to populate with events
   */
  private async processSSEToStream(
    body: ReadableStream<Uint8Array>,
    headers: Headers | undefined,
    stream: ResponseStream
  ): Promise<void> {
    // Parse rate limit information from headers
    const rateLimitSnapshot = this.parseRateLimitSnapshot(headers);
    if (rateLimitSnapshot) {
      stream.addEvent({ type: 'RateLimits', snapshot: rateLimitSnapshot });
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseCompleted: ResponseCompleted | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Handle completion - yield Completed event at stream end
          if (responseCompleted) {
            stream.addEvent({
              type: 'Completed',
              responseId: responseCompleted.id,
              tokenUsage: responseCompleted.usage ? this.convertTokenUsage(responseCompleted.usage) : undefined,
            });
          } else {
            throw new Error('Stream closed before response.completed');
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        // Use optimized batch processing for better performance
        const dataLines = lines
          .filter(line => {
            const trimmed = line.trim();
            return trimmed && trimmed.indexOf('data: ') === 0;
          })
          .map(line => line.slice(6)); // Remove 'data: ' prefix

        if (dataLines.length === 0) continue;

        // Check for [DONE] signal
        if (dataLines.some(data => data === '[DONE]')) {
          break;
        }

        // Process events using optimized parser
        for (const data of dataLines) {
          try {
            const event = this.sseParser.parse(data);
            if (event) {
              const responseEvents = this.sseParser.processEvent(event);

              for (const responseEvent of responseEvents) {
                // Store Completed event to yield at stream end
                if (responseEvent.type === 'Completed' && 'responseId' in responseEvent) {
                  responseCompleted = {
                    id: responseEvent.responseId,
                    usage: responseEvent.tokenUsage ? this.convertToApiUsage(responseEvent.tokenUsage) : undefined,
                  };
                } else {
                  // Add all other events immediately
                  stream.addEvent(responseEvent);
                }
              }
            }
          } catch (error) {
            // SSEEventParser.processEvent() throws on response.failed
            throw error;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Process Server-Sent Events stream from Responses API (legacy AsyncGenerator version)
   *
   * This is kept for backward compatibility with streamResponsesInternal().
   * New code should use processSSEToStream() instead.
   */
  protected async *processSSE(
    stream: ReadableStream<Uint8Array>,
    headers?: Headers
  ): AsyncGenerator<ResponseEvent> {
    const body = stream;
    // Parse rate limit information from headers
    const rateLimitSnapshot = this.parseRateLimitSnapshot(headers);
    if (rateLimitSnapshot) {
      yield { type: 'RateLimits', snapshot: rateLimitSnapshot };
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let responseCompleted: ResponseCompleted | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Handle completion or error
          if (responseCompleted) {
            yield {
              type: 'Completed',
              responseId: responseCompleted.id,
              tokenUsage: responseCompleted.usage ? this.convertTokenUsage(responseCompleted.usage) : undefined,
            };
          } else {
            throw new Error('Stream closed before response.completed');
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        // Use optimized batch processing for better performance
        const dataLines = lines
          .filter(line => {
            const trimmed = line.trim();
            return trimmed && trimmed.indexOf('data: ') === 0;
          })
          .map(line => line.slice(6)); // Remove 'data: ' prefix

        if (dataLines.length === 0) continue;

        // Check for [DONE] signal
        if (dataLines.some(data => data === '[DONE]')) {
          return;
        }

        // Process events using optimized parser
        for (const data of dataLines) {
          const event = this.sseParser.parse(data);
          if (event) {
            const responseEvents = this.sseParser.processEvent(event);

            for (const responseEvent of responseEvents) {
              // Store Completed event to yield at stream end
              if (responseEvent.type === 'Completed' && 'responseId' in responseEvent) {
                responseCompleted = {
                  id: responseEvent.responseId,
                  usage: responseEvent.tokenUsage ? this.convertToApiUsage(responseEvent.tokenUsage) : undefined,
                };
              } else {
                // Yield all other events immediately
                yield responseEvent;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Handle individual SSE events and convert to ResponseEvent
   */
  private async handleSseEvent(event: SseEvent): Promise<ResponseEvent | null> {
    switch (event.type) {
      case 'response.created':
        return { type: 'Created' };

      case 'response.output_item.done':
        if (event.item) {
          return { type: 'OutputItemDone', item: event.item };
        }
        break;

      case 'response.output_text.delta':
        if (event.delta) {
          return { type: 'OutputTextDelta', delta: event.delta };
        }
        break;

      case 'response.reasoning_summary_text.delta':
        if (event.delta) {
          return { type: 'ReasoningSummaryDelta', delta: event.delta };
        }
        break;

      case 'response.reasoning_text.delta':
        if (event.delta) {
          return { type: 'ReasoningContentDelta', delta: event.delta };
        }
        break;

      case 'response.reasoning_summary_part.added':
        return { type: 'ReasoningSummaryPartAdded' };

      case 'response.output_item.added':
        // Detect web search call begin
        if (event.item?.type === 'web_search_call') {
          const callId = event.item.id || '';
          return { type: 'WebSearchCallBegin', callId };
        }
        break;

      case 'response.completed':
        if (event.response) {
          return {
            type: 'Completed',
            responseId: event.response.id,
            tokenUsage: event.response.usage ? this.convertTokenUsage(event.response.usage) : undefined,
          };
        }
        break;

      case 'response.failed':
        if (event.response?.error) {
          const errorMsg = event.response.error.message || 'Response failed';
          throw new ModelClientError(errorMsg);
        }
        throw new ModelClientError('Response failed');

      // Ignored events
      case 'response.in_progress':
      case 'response.output_text.done':
      case 'response.content_part.done':
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
      case 'response.custom_tool_call_input.done':
      case 'response.reasoning_summary_text.done':
        break;

      default:
        // Unknown event type - log but don't fail
        console.debug('Unknown SSE event type:', event.type);
    }

    return null;
  }

  /**
   * Make HTTP request to OpenAI Responses API endpoint
   */
  private async makeResponsesApiRequest(payload: ResponsesApiRequest): Promise<Response> {
    // Validate API key before making request
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError('No API key configured for provider: openai');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
      'OpenAI-Beta': 'responses=experimental',
      'conversation_id': this.conversationId,
      'session_id': this.conversationId,
      'Accept': 'text/event-stream',
    };

    if (this.organization) {
      headers['OpenAI-Organization'] = this.organization;
    }

    const url = `${this.baseUrl}/responses`;
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `OpenAI Responses API error: ${response.status} ${response.statusText}`;

      try {
        const errorData = JSON.parse(errorText);
        if (errorData.error?.message) {
          errorMessage = errorData.error.message;
        }
      } catch {
        if (errorText) {
          errorMessage = errorText;
        }
      }

      // Extract retry-after header if present
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;

      throw new ModelClientError(
        errorMessage,
        response.status,
        this.provider.name,
        this.isRetryableHttpError(response.status)
      );
    }

    return response;
  }

  /**
   * Get full instructions including base instructions and overrides
   */
  private getFullInstructions(prompt: Prompt): string {
    return get_full_instructions(prompt, this.modelFamily);
  }

  /**
   * Create tools JSON for Responses API
   * Converts ToolSpec format to Responses API format
   * Handles: function, local_shell, web_search, custom tool types
   */
  private createToolsJsonForResponsesApi(tools: any[]): any[] {
    if (!tools || !Array.isArray(tools)) {
      return [];
    }

    return tools
      .map(tool => {
        if (!tool || typeof tool !== 'object') {
          console.warn('[OpenAIResponsesClient] Invalid tool object:', tool);
          return null;
        }

        // Handle function tools (ToolSpec format: { type: 'function', function: {...} })
        // Responses API expects FLAT structure, not nested under 'function' key
        if (tool.type === 'function') {
          if (!tool.function || !tool.function.name || !tool.function.description) {
            console.error('[OpenAIResponsesClient] Function tool missing required fields:', tool);
            return null;
          }
          return {
            type: 'function',
            name: tool.function.name,
            description: tool.function.description,
            strict: tool.function.strict || false,
            parameters: tool.function.parameters || { type: 'object', properties: {} },
          };
        }

        // Handle local_shell tools
        if (tool.type === 'local_shell') {
          return { type: 'local_shell' };
        }

        // Handle web_search tools
        if (tool.type === 'web_search') {
          return { type: 'web_search' };
        }

        // Handle custom/freeform tools - convert to function format
        if (tool.type === 'custom' && tool.custom) {
          return {
            type: 'function',
            function: {
              name: tool.custom.name,
              description: tool.custom.description,
              strict: false,
              parameters: {
                type: 'object',
                properties: {
                  input: { type: 'string', description: 'Tool input' },
                },
                required: ['input'],
              },
            },
          };
        }

        console.warn('[OpenAIResponsesClient] Unknown tool type:', tool);
        return null;
      })
      .filter((tool): tool is NonNullable<typeof tool> => tool !== null);
  }

  /**
   * Create reasoning parameter for request
   */
  private createReasoningParam(): Reasoning | undefined {
    if (!this.modelFamily.supports_reasoning_summaries) {
      return undefined;
    }

    return {
      effort: this.reasoningEffort,
      summary: this.reasoningSummary,
    };
  }

  /**
   * Create text controls parameter for GPT-5 models
   */
  private createTextParam(outputSchema?: any): TextControls | undefined {
    if (!this.modelVerbosity && !outputSchema) {
      return undefined;
    }

    const textControls: TextControls = {};

    if (this.modelVerbosity) {
      textControls.verbosity = this.modelVerbosity;
    }

    if (outputSchema) {
      textControls.format = {
        type: 'json_schema',
        strict: true,
        schema: outputSchema,
        name: 'browserx_output_schema',
      };
    }

    return textControls;
  }

  /**
   * Parse rate limit information from response headers
   */
  /**
   * Parse rate limit snapshot from HTTP headers
   */
  protected parseRateLimitSnapshot(headers?: Headers): RateLimitSnapshot | undefined {
    if (!headers) return undefined;
    const primary = this.parseRateLimitWindow(
      headers,
      'x-browserx-primary-used-percent',
      'x-browserx-primary-window-minutes',
      'x-browserx-primary-resets-in-seconds'
    );

    const secondary = this.parseRateLimitWindow(
      headers,
      'x-browserx-secondary-used-percent',
      'x-browserx-secondary-window-minutes',
      'x-browserx-secondary-resets-in-seconds'
    );

    if (!primary && !secondary) {
      return undefined;
    }

    return { primary, secondary };
  }

  /**
   * Parse rate limit window from headers
   */
  private parseRateLimitWindow(
    headers: Headers,
    usedPercentHeader: string,
    windowMinutesHeader: string,
    resetsHeader: string
  ): import('./types/RateLimits').RateLimitWindow | undefined {
    const usedPercent = this.parseHeaderFloat(headers, usedPercentHeader);
    if (usedPercent === null) {
      return undefined;
    }

    return {
      used_percent: usedPercent,
      window_minutes: this.parseHeaderInt(headers, windowMinutesHeader) ?? undefined,
      resets_in_seconds: this.parseHeaderInt(headers, resetsHeader) ?? undefined,
    };
  }

  private parseHeaderFloat(headers: Headers, name: string): number | null {
    const value = headers.get(name);
    if (!value) return null;
    const parsed = parseFloat(value);
    return isFinite(parsed) ? parsed : null;
  }

  private parseHeaderInt(headers: Headers, name: string): number | null {
    const value = headers.get(name);
    if (!value) return null;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Convert API usage format to internal TokenUsage
   */
  private convertTokenUsage(usage: ResponseCompletedUsage): TokenUsage {
    return {
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.input_tokens_details?.cached_tokens || 0,
      output_tokens: usage.output_tokens,
      reasoning_output_tokens: usage.output_tokens_details?.reasoning_tokens || 0,
      total_tokens: usage.total_tokens,
    };
  }

  /**
   * Convert internal TokenUsage back to API usage format
   */
  private convertToApiUsage(usage: TokenUsage): ResponseCompletedUsage {
    return {
      input_tokens: usage.input_tokens,
      input_tokens_details: usage.cached_input_tokens ? {
        cached_tokens: usage.cached_input_tokens,
      } : undefined,
      output_tokens: usage.output_tokens,
      output_tokens_details: usage.reasoning_output_tokens ? {
        reasoning_tokens: usage.reasoning_output_tokens,
      } : undefined,
      total_tokens: usage.total_tokens,
    };
  }

  /**
   * Convert optimized SSE event to ResponseEvent format
   */
  private convertSSEEventToResponseEvent(event: any): ResponseEvent | null {
    switch (event.type) {
      case 'Created':
        return { type: 'Created' };

      case 'OutputItemDone':
        return { type: 'OutputItemDone', item: event.item };

      case 'OutputTextDelta':
        return { type: 'OutputTextDelta', delta: event.delta };

      case 'ReasoningSummaryDelta':
        return { type: 'ReasoningSummaryDelta', delta: event.delta };

      case 'ReasoningContentDelta':
        return { type: 'ReasoningContentDelta', delta: event.delta };

      case 'ReasoningSummaryPartAdded':
        return { type: 'ReasoningSummaryPartAdded' };

      case 'WebSearchCallBegin':
        return { type: 'WebSearchCallBegin', callId: event.callId };

      case 'Completed':
        return {
          type: 'Completed',
          responseId: event.responseId,
          tokenUsage: event.tokenUsage,
        };

      default:
        return null;
    }
  }

  /**
   * Get performance metrics and queue status
   */
  public getPerformanceStatus() {
    return {
      sseMetrics: this.sseParser.getPerformanceMetrics(),
      queueStatus: this.requestQueue?.getStatus(),
      queueAnalytics: this.requestQueue?.getAnalytics(),
    };
  }

  /**
   * Reset performance metrics for monitoring
   */
  public resetPerformanceMetrics(): void {
    this.sseParser.resetPerformanceMetrics();
  }

  /**
   * Enable or disable request queuing
   */
  public setQueueEnabled(enabled: boolean): void {
    if (this.requestQueue) {
      this.queueEnabled = enabled;
      if (enabled) {
        this.requestQueue.resume();
      } else {
        this.requestQueue.pause();
      }
    }
  }

  /**
   * Clear all queued requests
   */
  public clearQueue(): void {
    this.requestQueue?.clear();
  }

  /**
   * Cleanup resources and log performance summary
   */
  public async cleanup(): Promise<void> {
    const metrics = this.sseParser.getPerformanceMetrics();
    if (metrics.totalProcessed > 0) {
      console.log(
        `SSE Processing Summary: ${metrics.totalProcessed} events, ` +
        `${metrics.averageTime.toFixed(2)}ms average (target: <10ms), ` +
        `Performance: ${metrics.isWithinTarget ? 'GOOD' : 'NEEDS_OPTIMIZATION'}`
      );
    }

    if (this.requestQueue) {
      const queueAnalytics = this.requestQueue.getAnalytics();
      console.log(
        `Request Queue Summary: ${queueAnalytics.successRate * 100}% success rate, ` +
        `${queueAnalytics.averageWaitTime.toFixed(0)}ms average wait`
      );
      this.requestQueue.pause();
    }

    this.sseParser.resetPerformanceMetrics();
  }
}