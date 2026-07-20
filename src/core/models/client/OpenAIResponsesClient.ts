/**
 * OpenAI Responses API client implementation for pi
 * Uses official OpenAI SDK for API calls (supports OpenAI, xAI, and other compatible providers)
 */

import OpenAI from 'openai';
import {
  ModelClient,
  ModelClientError,
  type CompletionRequest,
  type CompletionResponse,
  type RetryConfig,
} from '../ModelClient';
import { ResponseStream } from '../ResponseStream';
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
  OpenAiVerbosity
} from '../types/ResponsesAPI';
import type { IModelConfig } from '../../../config/types';
import type { RateLimitSnapshot } from '../types/RateLimits';
import type { TokenUsage } from '../types/TokenUsage';
import { SSEEventParser } from '../SSEEventParser';
import { get_full_instructions, get_formatted_input } from '../PromptHelpers';

/**
 * Heuristic: does a 401 body message describe a billing/credit/quota problem
 * (which must be surfaced to the user verbatim) rather than an expired
 * session/token/key? The AI Hub gateway returns 401 with `type: "auth_error"`
 * for both, so the message text is the only discriminator available client-side.
 * Defaults to `false` (treat as auth failure) when there is no message.
 */
export function isGatewayBillingMessage(message?: string): boolean {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('credit account') ||
    m.includes('credit balance') ||
    m.includes('insufficient') ||
    m.includes('quota') ||
    m.includes('free tokens') ||
    m.includes('free app call') ||
    m.includes('daily free')
  );
}

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
  sessionId: string;
  /** Model family configuration */
  modelFamily: ModelFamily;
  /** Model provider information */
  provider: ModelProviderInfo;
  /** Model configuration from AgentConfig */
  modelConfig?: IModelConfig;
  /** Reasoning effort configuration */
  reasoningEffort?: ReasoningEffortConfig;
  /** Reasoning summary configuration */
  reasoningSummary?: ReasoningSummaryConfig;
  /** Model verbosity setting */
  modelVerbosity?: OpenAiVerbosity;
  /** Service tier for request prioritization (OpenAI-specific) */
  serviceTier?: 'default' | 'flex' | 'priority';
  /** Use credentials (cookies) for authentication - for backend routing */
  useCredentials?: boolean;
  /** Track 11: allow the model to emit multiple tool calls per response. Default false. */
  parallelToolCalls?: boolean;
  /** Optional OpenHub upstream-provider slug added to Chat Completions requests. */
  providerRoutingSlug?: string;
}

/**
 * OpenAI Responses API client using official OpenAI SDK
 * Supports OpenAI, xAI (Grok), and other OpenAI-compatible providers
 */
export class OpenAIResponsesClient extends ModelClient {
  protected readonly apiKey: string | null;
  protected readonly baseUrl: string;
  protected readonly organization?: string;
  protected readonly sessionId: string;
  protected readonly modelFamily: ModelFamily;
  protected readonly provider: ModelProviderInfo;
  protected reasoningEffort?: ReasoningEffortConfig;
  protected reasoningSummary?: ReasoningSummaryConfig;
  protected modelVerbosity?: OpenAiVerbosity;
  protected serviceTier?: 'default' | 'flex' | 'priority';
  protected currentModel: string;
  protected useCredentials: boolean;
  /** Track 11: emitted as `parallel_tool_calls` in the request payload. */
  protected readonly parallelToolCalls: boolean;
  /** OpenHub provider-selection pin; absent for direct and legacy routing. */
  protected readonly providerRoutingSlug?: string;

  // OpenAI SDK client instance
  protected client: OpenAI;

  // Performance optimizations (Phase 9)
  protected sseParser: SSEEventParser;

  constructor(config: OpenAIResponsesConfig, retryConfig?: Partial<RetryConfig>) {
    super(retryConfig);

    // Don't validate API key in constructor - validation happens when making requests
    // This allows the model client to be created before API key is configured

    this.apiKey = config.apiKey;
    this.parallelToolCalls = config.parallelToolCalls ?? false;
    this.providerRoutingSlug = config.providerRoutingSlug?.trim() || undefined;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';

    // Validate baseUrl is a valid URL to catch configuration errors early
    try {
      new URL(this.baseUrl);
    } catch {
      console.error('[OpenAIResponsesClient] Invalid baseUrl:', this.baseUrl);
      throw new ModelClientError(
        `Invalid API base URL: "${this.baseUrl}". Please check the provider configuration.`,
        400,
        config.provider?.name || 'Unknown',
        false
      );
    }

    this.organization = config.organization;
    this.sessionId = config.sessionId;
    this.modelFamily = config.modelFamily;
    this.provider = config.provider;
    this.modelConfig = config.modelConfig;
    this.reasoningEffort = config.reasoningEffort;
    this.reasoningSummary = config.reasoningSummary;
    this.modelVerbosity = config.modelVerbosity;
    this.serviceTier = config.serviceTier;
    this.currentModel = config.modelFamily.family;
    this.useCredentials = config.useCredentials ?? false;

    // Initialize OpenAI SDK client with provider-specific baseURL
    // If useCredentials is true, configure custom fetch to include cookies for backend routing
    const fetchOptions: OpenAI.RequestOptions['fetchOptions'] = this.useCredentials
      ? { credentials: 'include' as RequestCredentials }
      : undefined;

    // Custom fetch wrapper that captures error response bodies
    // The OpenAI SDK expects {"error": {"message": "..."}} format, but our backend
    // returns FastAPI format {"detail": "..."}. This wrapper transforms error responses.
    const customFetch = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const fetchInit = this.useCredentials ? { ...init, credentials: 'include' as RequestCredentials } : init;
      const response = await fetch(url, fetchInit);

      // If it's an error response, clone it and try to extract the error detail
      if (!response.ok) {
        const clonedResponse = response.clone();
        try {
          const body = await clonedResponse.text();
          if (body) {
            // Store the raw error body for later extraction
            // We'll create a new response with the body preserved
            const errorData = JSON.parse(body);

            // Transform FastAPI format to OpenAI format if needed
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
      apiKey: this.apiKey || 'dummy-key', // SDK requires key but we might not have one yet
      baseURL: this.baseUrl,
      organization: this.organization,
      dangerouslyAllowBrowser: true,
      timeout: 360000, // 6 minutes for reasoning models
      maxRetries: 0, // We handle retries manually
      // Use custom fetch to handle credentials and transform error responses
      fetch: customFetch,
    });

    // Initialize performance optimizations
    this.sseParser = new SSEEventParser();
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

  // Override to provide fallback for legacy hardcoded values
  getModelContextWindow(): number | undefined {
    // Try base class implementation first (reads from IModelConfig)
    const contextWindow = super.getModelContextWindow();
    if (contextWindow) {
      return contextWindow;
    }

    // Fallback to legacy hardcoded values for backward compatibility
    if (this.currentModel === 'gpt-5') {
      return 200000;
    } else if (this.currentModel === 'grok-4-fast-reasoning') {
      return 131072;
    } else if (this.currentModel === 'qwen/qwen3-32b') {
      return 131072;
    } else if (this.currentModel === 'moonshotai/kimi-k2-instruct-0905') {
      return 262144;
    }
    // Default fallback
    return 128000;
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

  // Non-streaming completion using the Chat Completions API
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.validateRequest(request);

    const requestParams: any = {
      model: request.model,
      messages: request.messages
        .filter(m => m.role !== 'tool')
        .map(m => ({
          role: m.role as 'system' | 'user' | 'assistant',
          content: m.content ?? '',
        })),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    };
    if (this.providerRoutingSlug) {
      requestParams.provider = this.providerRoutingSlug;
    }

    const response = await this.client.chat.completions.create(requestParams);

    const choice = response.choices[0];
    return {
      id: response.id,
      model: response.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: choice?.message?.content ?? '',
        },
        finishReason: (choice?.finish_reason as CompletionResponse['choices'][0]['finishReason']) ?? 'stop',
      }],
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
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

    // Build request payload (can be overridden by subclasses like GroqClient)
    const payload = await this.buildRequestPayload(prompt);

    // Track 12: retry/backoff/reset-wait is owned by the single orchestrator
    // at the TurnManager.runTurn boundary. This client makes one attempt and
    // lets errors propagate up for unified classification.
    return await this.attemptStreamResponses(0, payload);
  }

  /**
   * Build request payload for OpenAI/xAI providers
   * Can be overridden by subclasses (e.g., GroqClient) for provider-specific behavior
   */
  protected async buildRequestPayload(prompt: Prompt): Promise<ResponsesApiRequest> {
    const fullInstructions = this.getFullInstructions(prompt);
    const toolsJson = this.createToolsJsonForResponsesApi(prompt.tools);
    const reasoning = this.buildReasoningParam();
    const textControls = this.createTextParam(prompt.output_schema);

    // Provider-specific parameter handling
    const azureWorkaround = (this.provider.base_url && this.provider.base_url.indexOf('azure') !== -1) || false;

    // Include reasoning.encrypted_content if reasoning enabled
    const include: string[] | undefined = reasoning ? ['reasoning.encrypted_content'] : [];

    // xAI: store must be false (required for images)
    // Azure: use azureWorkaround
    // Others: use azureWorkaround
    const storeValue = this.provider.name === 'xai' ? false : azureWorkaround;

    // Build base payload
    const payload: ResponsesApiRequest | any = {
      model: this.currentModel,
      instructions: fullInstructions,
      input: (await get_formatted_input(prompt)).map((item: any) => {
        // Strip thoughtSignature from tool_calls — it's Gemini-specific, not valid for OpenAI
        if (item.type === 'message' && item.tool_calls) {
          return {
            ...item,
            tool_calls: item.tool_calls.map((tc: any) => {
              const { thoughtSignature, ...cleanTc } = tc;
              return cleanTc;
            }),
          };
        }
        return item;
      }),
      tools: toolsJson,
      tool_choice: 'auto',
      parallel_tool_calls: this.parallelToolCalls,
      ...(storeValue !== undefined && { store: storeValue }), // Conditionally include store
      stream: true,
      ...(include !== undefined && include.length > 0 && { include }), // Conditionally include
      prompt_cache_key: this.sessionId,
      text: textControls,
      ...(this.serviceTier && { service_tier: this.serviceTier }), // Conditionally include service_tier
    };

    // Add reasoning parameter if model supports it
    if (this.modelFamily.supports_reasoning && reasoning) {
      payload.reasoning = reasoning;
    }

    return payload;
  }

  /**
   * Build reasoning parameter for OpenAI/xAI
   * Can be overridden by subclasses for provider-specific formats
   */
  protected buildReasoningParam(): Reasoning | undefined {
    if (!this.modelFamily.supports_reasoning_summaries) {
      return undefined;
    }

    // Convert reasoningSummary to OpenAI's expected format
    // OpenAI expects: 'auto' | 'concise' | 'detailed'
    // We receive: boolean | { enabled: boolean }
    let summaryValue: string | undefined;
    if (this.reasoningSummary) {
      if (typeof this.reasoningSummary === 'boolean') {
        summaryValue = this.reasoningSummary ? 'auto' : undefined;
      } else if (typeof this.reasoningSummary === 'object' && this.reasoningSummary.enabled) {
        summaryValue = 'auto'; // Default to 'auto' when enabled
      }
    }

    const reasoning: any = {};
    if (this.reasoningEffort) {
      reasoning.effort = this.reasoningEffort;
    }
    if (summaryValue) {
      reasoning.summary = summaryValue;
    }

    return Object.keys(reasoning).length > 0 ? reasoning : undefined;
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
   * Uses OpenAI SDK's streaming API instead of manual SSE parsing.
   * Returns a ResponseStream that will be populated asynchronously.
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
    // Make SDK streaming request - this will throw on connection errors (401, 429, etc.)
    const sdkStream = await this.makeResponsesApiRequest(payload);

    // Create stream and start processing asynchronously
    // Use 30-minute event timeout for LLM reasoning (extended for reasoning models like o1)
    // Reasoning models can take >5 minutes without sending events during complex reasoning
    const stream = new ResponseStream(undefined, { eventTimeout: 1800000 });

    // Spawn async task to populate stream from SDK events
    (async () => {
      try {
        await this.processSDKStreamToResponseStream(sdkStream, stream);
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
    // Build request payload (can be overridden by subclasses)
    const payload = await this.buildRequestPayload(prompt);

    // Track 12: single attempt — retry/backoff is centralized in the
    // orchestrator. The 401 message enrichment is kept (user-facing value);
    // all other errors propagate unchanged for unified classification.
    try {
      const sdkStream = await this.makeResponsesApiRequest(payload);
      yield* this.processSDKStream(sdkStream);
    } catch (error) {
      if (error instanceof ModelClientError && error.statusCode === 401) {
        throw this.reclassifyGateway401(error);
      }
      throw error;
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
  /**
   * Process OpenAI SDK stream as AsyncGenerator (for streamResponsesInternal)
   * The SDK handles SSE parsing and returns structured events
   *
   * @param sdkStream Async iterable from OpenAI SDK
   */
  protected async *processSDKStream(
    sdkStream: AsyncIterable<any>
  ): AsyncGenerator<ResponseEvent> {
    try {
      for await (const chunk of sdkStream) {
        // The SDK returns structured event objects
        // Convert SDK event format to our ResponseEvent format
        const responseEvents = this.convertSDKEventToResponseEvent(chunk);

        // Yield each event (may be multiple events per chunk, e.g., output items + completion)
        for (const event of responseEvents) {
          yield event;
        }
      }
    } catch (error: any) {
      console.error('[OpenAIResponsesClient] SDK stream error:', error);
      // Convert to ModelClientError with extracted details for better error messages
      throw this.toModelClientError(error, 'Stream processing error');
    }
  }

  /**
   * Process OpenAI SDK stream and convert to ResponseStream
   * The SDK handles SSE parsing and returns structured events
   *
   * @param sdkStream Async iterable from OpenAI SDK
   * @param stream ResponseStream to populate with events
   */
  protected async processSDKStreamToResponseStream(
    sdkStream: AsyncIterable<any>,
    stream: ResponseStream
  ): Promise<void> {
    try {
      for await (const chunk of sdkStream) {
        // The SDK returns structured event objects
        // Convert SDK event format to our ResponseEvent format
        const responseEvents = this.convertSDKEventToResponseEvent(chunk);

        // Add each event (may be multiple events per chunk, e.g., output items + completion)
        for (const event of responseEvents) {
          stream.addEvent(event);
        }
      }
    } catch (error: any) {
      console.error('[OpenAIResponsesClient] SDK stream error:', error);
      // Convert to ModelClientError with extracted details for better error messages
      throw this.toModelClientError(error, 'Stream processing error');
    }
  }

  /**
   * Convert OpenAI SDK event to ResponseEvent format
   * Maps SDK's event structure to our internal ResponseEvent type
   * Returns an array to support extracting multiple items from a single event
   * Can be overridden by subclasses for provider-specific event handling
   */
  protected convertSDKEventToResponseEvent(sdkEvent: any): ResponseEvent[] {
    // The SDK event format will depend on what the actual SDK returns
    // This is a placeholder implementation that will need to be adjusted
    // based on the actual SDK event structure

    if (!sdkEvent || !sdkEvent.type) {
      return [];
    }

    const events: ResponseEvent[] = [];

    // Map SDK event types to ResponseEvent types
    // Uses the same event names as the SSE handler (handleSseEvent)
    switch (sdkEvent.type) {
      case 'response.created':
        events.push({ type: 'Created' });
        break;

      case 'response.output_item.done':
        events.push({
          type: 'OutputItemDone',
          item: sdkEvent.item,
        });
        break;

      case 'response.output_text.delta':
        events.push({
          type: 'OutputTextDelta',
          delta: sdkEvent.delta || '',
        });
        break;

      case 'response.reasoning_summary_text.delta':
        events.push({
          type: 'ReasoningSummaryDelta',
          delta: sdkEvent.delta || '',
        });
        break;

      case 'response.reasoning_text.delta':
        events.push({
          type: 'ReasoningContentDelta',
          delta: sdkEvent.delta || '',
        });
        break;

      case 'response.reasoning_summary_part.added':
        events.push({ type: 'ReasoningSummaryPartAdded' });
        break;

      case 'response.output_item.added':
        // Detect web search call begin
        if (sdkEvent.item?.type === 'web_search_call') {
          const callId = sdkEvent.item.id || '';
          events.push({ type: 'WebSearchCallBegin', callId });
        }
        break;

      case 'response.completed':
        events.push({
          type: 'Completed',
          responseId: sdkEvent.response?.id || sdkEvent.id || '',
          tokenUsage: sdkEvent.usage ? this.convertTokenUsage(sdkEvent.usage) : undefined,
        });
        break;

      case 'response.failed':
        // Will be caught as an error by the SDK stream
        break;

      // Informational events - no action needed
      case 'response.in_progress':
      case 'response.output_text.done':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.function_call_arguments.delta':
      case 'response.custom_tool_call_input.delta':
      case 'response.custom_tool_call_input.done':
      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary_part.done':
        break;

      default:
        console.debug('[OpenAIResponsesClient] Unknown SDK event type:', sdkEvent.type, sdkEvent);
        break;
    }

    return events;
  }

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
   * Make streaming request to OpenAI Responses API using official SDK
   * Returns an async iterable stream of events
   * Supports OpenAI, xAI (Grok), and other OpenAI-compatible providers
   */
  private async makeResponsesApiRequest(payload: ResponsesApiRequest): Promise<AsyncIterable<any>> {
    // Validate API key before making request
    if (!this.apiKey || !this.apiKey.trim()) {
      throw new ModelClientError(`No API key configured for provider: ${this.provider.name}`);
    }

    try {
      // Convert payload to SDK format
      const requestParams: any = {
        model: payload.model,
        input: payload.input,
        stream: true, // Always stream
      };

      // Add optional parameters
      if (payload.tools && payload.tools.length > 0) {
        requestParams.tools = payload.tools;
      }
      if (payload.instructions) {
        requestParams.instructions = payload.instructions;
      }
      if (payload.reasoning) {
        requestParams.reasoning = payload.reasoning;
      }
      if (payload.text) {
        requestParams.text = payload.text;
      }
      if (payload.store !== undefined) {
        requestParams.store = payload.store;
      }
      if (payload.tool_choice) {
        requestParams.tool_choice = payload.tool_choice;
      }
      if (payload.parallel_tool_calls !== undefined) {
        requestParams.parallel_tool_calls = payload.parallel_tool_calls;
      }
      if (payload.include && payload.include.length > 0) {
        requestParams.include = payload.include;
      }
      if (payload.prompt_cache_key) {
        requestParams.prompt_cache_key = payload.prompt_cache_key;
      }

      // Add provider-specific headers if needed
      const options: any = {};
      if (this.provider.name === 'openai') {
        options.headers = {
          'conversation_id': this.sessionId,
          'session_id': this.sessionId,
        };
      }

      // Use OpenAI SDK's responses API with streaming
      // The SDK handles authentication, retries, and format parsing
      const stream = await (this.client as any).responses.create(requestParams, options);

      return stream;
    } catch (error: any) {
      // Log additional context for debugging URL construction errors
      if (error.message?.includes('Invalid URL')) {
        console.error('[OpenAIResponsesClient] URL construction error - baseUrl:', this.baseUrl);
      }
      // Handle SDK errors and convert to ModelClientError with extracted details
      throw this.toModelClientError(error, `${this.provider.name} Responses API error`);
    }
  }

  /**
   * Get full instructions including base instructions and overrides
   */
  protected getFullInstructions(prompt: Prompt): string {
    return get_full_instructions(prompt, this.modelFamily);
  }

  /**
   * Extract detailed error message from SDK error
   * Handles various error formats from OpenAI SDK and backend responses
   */
  protected extractErrorDetails(error: any): { message: string; statusCode: number } {
    const statusCode = error.status || error.statusCode || 500;
    let message = error.message || `${this.provider.name} API error`;

    // Log the full error object for debugging
    console.error('[OpenAIResponsesClient] Error details:', {
      message: error.message,
      status: error.status,
      statusCode: error.statusCode,
      error: error.error,
      body: error.body,
      response: error.response,
      cause: error.cause,
    });

    // Try to extract more detailed error information from response body
    // The OpenAI SDK stores parsed response body in error.error
    if (error.error?.detail) {
      // Backend error format: {"detail": "Model 'x' is not supported"}
      message = error.error.detail;
    } else if (error.error?.message) {
      // OpenAI-style error format: {"error": {"message": "..."}}
      message = error.error.message;
    } else if (typeof error.error === 'string') {
      // Plain string error - might be unparsed JSON
      try {
        const parsed = JSON.parse(error.error);
        if (parsed.detail) {
          message = parsed.detail;
        } else if (parsed.message) {
          message = parsed.message;
        }
      } catch {
        message = error.error;
      }
    } else if (error.body) {
      // Some errors have body property
      if (typeof error.body === 'string') {
        try {
          const parsed = JSON.parse(error.body);
          if (parsed.detail) {
            message = parsed.detail;
          } else if (parsed.message) {
            message = parsed.message;
          }
        } catch {
          // Not JSON, use as-is if not empty
          if (error.body.trim()) {
            message = error.body;
          }
        }
      } else if (error.body?.detail) {
        message = error.body.detail;
      } else if (error.body?.message) {
        message = error.body.message;
      }
    }

    return { message, statusCode };
  }

  /**
   * Convert any error to ModelClientError with extracted details
   */
  protected toModelClientError(error: any, defaultMessage?: string): ModelClientError {
    const { message, statusCode } = this.extractErrorDetails(error);
    return new ModelClientError(
      message || defaultMessage || `${this.provider.name} API error`,
      statusCode,
      this.provider.name,
      this.isRetryableHttpError(statusCode)
    );
  }

  /**
   * Map a 401 from a gateway-routed request to the user-facing error to throw.
   *
   * A 401 here is NOT always an expired session/API key. The AI Hub gateway
   * returns 401 for billing conditions too — "no LLM credit account for this
   * identity", "insufficient LLM credit balance", exhausted daily quota —
   * each with a specific, actionable message and `type: "auth_error"`. The
   * previous behavior masked all of them as "Session expired" / "check API
   * key", hiding the real reason from the user and sending them into a
   * pointless re-login. Preserve any gateway billing/credit/quota message so
   * it reaches the UI; only fall back to the generic auth copy for a 401 that
   * carries no such detail (i.e. a genuine session/token/key failure).
   */
  protected reclassifyGateway401(error: ModelClientError): ModelClientError {
    if (isGatewayBillingMessage(error.message)) {
      return error; // surface the real, actionable reason unchanged
    }
    if (this.useCredentials) {
      return new ModelClientError(
        'Session expired - please log in again to continue using the AI agent',
        401,
        'Backend',
        false // Not retryable
      );
    }
    return new ModelClientError(
      'Authentication failed - check API key',
      401,
      this.provider.name,
      false // Not retryable
    );
  }

  /**
   * Create tools JSON for Responses API
   * Converts ToolSpec format to Responses API format
   * Handles: function, local_shell, web_search, custom tool types
   */
  protected createToolsJsonForResponsesApi(tools: any[]): any[] {
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
   * Create text controls parameter for GPT-5 models
   */
  protected createTextParam(outputSchema?: any): TextControls | undefined {
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
        name: 'workx_output_schema',
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
      'x-pi-primary-used-percent',
      'x-pi-primary-window-minutes',
      'x-pi-primary-resets-in-seconds'
    );

    const secondary = this.parseRateLimitWindow(
      headers,
      'x-pi-secondary-used-percent',
      'x-pi-secondary-window-minutes',
      'x-pi-secondary-resets-in-seconds'
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
  ): import('../types/RateLimits').RateLimitWindow | undefined {
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
  protected convertTokenUsage(usage: ResponseCompletedUsage): TokenUsage {
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
    };
  }

  /**
   * Reset performance metrics for monitoring
   */
  public resetPerformanceMetrics(): void {
    this.sseParser.resetPerformanceMetrics();
  }

  /**
   * Cleanup resources
   */
  public async cleanup(): Promise<void> {
    this.sseParser.resetPerformanceMetrics();
  }
}
