/**
 * Model Client base interface and types for browserx-chrome
 */

import type { ToolDefinition } from '../tools/BaseTool';
import type { ModelProviderInfo, Prompt } from './types/ResponsesAPI';
import type { ResponseEvent } from './types/ResponseEvent';
import type { StreamAttemptError } from './types/StreamAttemptError';
import type { ResponseStream } from './ResponseStream';
import type { RateLimitSnapshot } from './types/RateLimits';

/**
 * Request configuration for completion API calls
 */
export interface CompletionRequest {
  /** The model to use for completion */
  model: string;
  /** Array of messages in the conversation */
  messages: Message[];
  /** Sampling temperature between 0 and 2 */
  temperature?: number;
  /** Maximum number of tokens to generate */
  maxTokens?: number;
  /** Tools available to the model */
  tools?: ToolDefinition[];
  /** Whether to stream the response */
  stream?: boolean;
}

/**
 * Response from completion API calls
 */
export interface CompletionResponse {
  /** Unique identifier for the completion */
  id: string;
  /** Model used for the completion */
  model: string;
  /** Array of completion choices */
  choices: Choice[];
  /** Token usage information */
  usage: Usage;
}

/**
 * Message in a conversation
 */
export interface Message {
  /** Role of the message sender */
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Content of the message (null for tool calls without content) */
  content: string | null;
  /** Tool calls made by the assistant */
  toolCalls?: ToolCall[];
  /** ID of the tool call this message responds to */
  toolCallId?: string;
}

/**
 * A single completion choice
 */
export interface Choice {
  /** Index of this choice */
  index: number;
  /** Message for this choice */
  message: Message;
  /** Reason the completion finished */
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

/**
 * Token usage statistics
 */
export interface Usage {
  /** Number of tokens in the prompt */
  promptTokens: number;
  /** Number of tokens in the completion */
  completionTokens: number;
  /** Total number of tokens used */
  totalTokens: number;
}

/**
 * Tool call made by the model
 */
export interface ToolCall {
  /** Unique identifier for the tool call */
  id: string;
  /** Type of tool call */
  type: 'function';
  /** Function call details */
  function: {
    /** Name of the function to call */
    name: string;
    /** JSON string of arguments */
    arguments: string;
  };
}

/**
 * Streaming chunk from completion API
 */
export interface StreamChunk {
  /** Delta containing new content */
  delta?: {
    /** New content to append */
    content?: string;
    /** Tool calls being made */
    toolCalls?: ToolCall[];
  };
  /** Reason the stream finished (only in final chunk) */
  finishReason?: string;
}

/**
 * Configuration for retry behavior
 */
export interface RetryConfig {
  /** Maximum number of retry attempts */
  maxRetries: number;
  /** Base delay in milliseconds */
  baseDelay: number;
  /** Maximum delay in milliseconds */
  maxDelay: number;
  /** Multiplier for exponential backoff */
  backoffMultiplier: number;
  /** Jitter percentage (0-1) for randomizing delays */
  jitterPercent: number;
}

/**
 * Error thrown by model clients
 */
export class ModelClientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly provider?: string,
    public readonly retryable: boolean = false,
    public readonly retryAfter?: number
  ) {
    super(message);
    this.name = 'ModelClientError';
  }
}

/**
 * Abstract base class for model clients
 */
export abstract class ModelClient {
  protected retryConfig: RetryConfig;

  constructor(retryConfig?: Partial<RetryConfig>) {
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitterPercent: 0.1, // 10% jitter by default
      ...retryConfig,
    };
  }

  /**
   * Complete a chat conversation
   * @param request The completion request
   * @returns Promise resolving to the completion response
   */
  abstract complete(request: CompletionRequest): Promise<CompletionResponse>;

  /**
   * Stream a model response using the Responses API
   *
   * This method creates and returns a ResponseStream that will emit ResponseEvent
   * objects as the model generates its response. The stream is returned immediately,
   * with events being added asynchronously as they arrive from the API.
   *
   * **Behavior**:
   * 1. Validates the prompt (empty input throws error)
   * 2. Creates a ResponseStream instance
   * 3. Spawns async task to populate stream via network call
   * 4. Returns stream immediately
   *
   * @param prompt The prompt containing input messages and tools
   * @returns Promise resolving to ResponseStream that yields ResponseEvent objects
   * @throws ModelClientError if prompt validation fails
   *
   * @example
   * ```typescript
   * const prompt: Prompt = {
   *   input: [{ type: 'message', role: 'user', content: 'Hello' }],
   *   tools: [],
   * };
   * const stream = await client.stream(prompt);
   * for await (const event of stream) {
   *   if (event.type === 'OutputTextDelta') {
   *     console.log(event.delta);
   *   }
   * }
   * ```
   */
  abstract stream(prompt: Prompt): Promise<ResponseStream>;

  /**
   * Count tokens in a text string for a given model
   * @param text The text to count tokens for
   * @param model The model to use for counting
   * @returns Number of tokens
   */
  abstract countTokens(text: string, model: string): number;

  /**
   * Get the provider information for this client
   */
  abstract getProvider(): ModelProviderInfo;

  /**
   * Stream completion with events
   * @param request The completion request
   * @returns Async generator yielding stream events
   */
  abstract streamCompletion(request: CompletionRequest): AsyncGenerator<any>;

  /**
   * Get current model identifier
   */
  abstract getModel(): string;

  /**
   * Set the model to use
   */
  abstract setModel(model: string): void;

  /**
   * Get model context window size
   */
  abstract getModelContextWindow(): number | undefined;

  /**
   * Get auto-compact token limit for this model
   */
  abstract getAutoCompactTokenLimit(): number | undefined;

  /**
   * Get model family configuration
   */
  abstract getModelFamily(): any;

  /**
   * Get auth manager instance
   *
   * **Browser Environment Note**: Always returns `undefined` in Chrome extension.
   *
   * In the browser environment:
   * - Chrome extensions use the Chrome Storage API for API key management
   * - No OAuth flow is implemented (users provide API keys directly)
   * - API keys are managed through AgentConfig
   */
  abstract getAuthManager(): any;

  /**
   * Get reasoning effort configuration
   */
  abstract getReasoningEffort(): any;

  /**
   * Set reasoning effort configuration
   */
  abstract setReasoningEffort(effort: any): void;

  /**
   * Get reasoning summary configuration
   */
  abstract getReasoningSummary(): any;

  /**
   * Set reasoning summary configuration
   */
  abstract setReasoningSummary(summary: any): void;

  /**
   * Stream responses from the model using appropriate wire API
   * Dispatches to either Responses API or Chat Completions based on provider
   */
  protected abstract streamResponses(request: CompletionRequest): AsyncGenerator<ResponseEvent>;

  /**
   * Stream chat completions (Chat API variant)
   */
  protected abstract streamChat(request: CompletionRequest): AsyncGenerator<ResponseEvent>;

  /**
   * Attempt a single streaming request with retry logic
   *
   * This method makes a single attempt to create a streaming connection,
   * without retry logic. Returns a ResponseStream that will be populated
   * with events from the API response.
   *
   * @param attempt The attempt number (0-based) for logging/metrics
   * @param payload The API request payload
   * @returns Promise resolving to ResponseStream
   * @throws Error if the connection fails or response is invalid
   */
  protected abstract attemptStreamResponses(
    attempt: number,
    payload: any
  ): Promise<ResponseStream>;

  /**
   * Process Server-Sent Events (SSE) stream into ResponseEvents
   * @param stream ReadableStream from fetch response
   * @returns AsyncGenerator yielding parsed ResponseEvents
   */
  protected abstract processSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ResponseEvent>;

  /**
   * Parse rate limit snapshot from HTTP headers
   *
   * Extracts rate limit information from HTTP response headers, if present.
   * Supports both primary and secondary rate limit windows.
   *
   * **Header Format**:
   * - Primary: `x-browserx-primary-used-percent`, `x-browserx-primary-window-minutes`, `x-browserx-primary-resets-in-seconds`
   * - Secondary: `x-browserx-secondary-used-percent`, `x-browserx-secondary-window-minutes`, `x-browserx-secondary-resets-in-seconds`
   *
   * @param headers HTTP response headers from fetch()
   * @returns RateLimitSnapshot if rate limit headers present, undefined otherwise
   */
  protected abstract parseRateLimitSnapshot(headers?: Headers): RateLimitSnapshot | undefined;

  /**
   * Validate a request before sending
   * @param request The request to validate
   * @throws ModelClientError if validation fails
   */
  protected validateRequest(request: CompletionRequest): void {
    if (!request.model?.trim()) {
      throw new ModelClientError('Model is required');
    }

    if (!request.messages || request.messages.length === 0) {
      throw new ModelClientError('At least one message is required');
    }

    // Validate temperature
    if (request.temperature !== undefined && (request.temperature < 0 || request.temperature > 2)) {
      throw new ModelClientError('Temperature must be between 0 and 2');
    }

    // Validate maxTokens
    if (request.maxTokens !== undefined && request.maxTokens <= 0) {
      throw new ModelClientError('maxTokens must be positive');
    }

    // Validate messages
    for (const message of request.messages) {
      if (['system', 'user', 'assistant', 'tool'].indexOf(message.role) === -1) {
        throw new ModelClientError(`Invalid message role: ${message.role}`);
      }

      if (message.role === 'tool' && !message.toolCallId) {
        throw new ModelClientError('Tool messages must have a toolCallId');
      }
    }
  }

  /**
   * Calculate backoff delay with proportional jitter
   * @param attempt The current attempt number (0-based)
   * @param retryAfter Optional retry-after value from server (in milliseconds)
   * @returns Delay in milliseconds
   */
  protected calculateBackoff(attempt: number, retryAfter?: number): number {
    // If server provides retry-after, use it with minimal jitter
    if (retryAfter !== undefined) {
      const jitter = retryAfter * this.retryConfig.jitterPercent;
      return retryAfter + Math.random() * jitter;
    }

    // Exponential backoff
    const exponentialDelay = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffMultiplier, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.retryConfig.maxDelay);

    // Add proportional jitter (10% by default)
    const jitter = cappedDelay * this.retryConfig.jitterPercent;
    return cappedDelay + Math.random() * jitter;
  }

  /**
   * Check if an error is retryable based on its properties
   * @param error The error to check
   * @returns True if the error is retryable
   */
  protected isRetryableError(error: any): boolean {
    // ModelClientError with retryable flag
    if (error instanceof ModelClientError) {
      return error.retryable;
    }

    // HTTP errors
    if (error.status || error.statusCode) {
      const statusCode = error.status || error.statusCode;
      return this.isRetryableHttpError(statusCode);
    }

    // Network errors
    if (error.code === 'ENOTFOUND' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      return true;
    }

    // AbortError is not retryable
    if (error.name === 'AbortError') {
      return false;
    }

    return false;
  }

  /**
   * Execute a function with retry logic
   * @param fn The function to execute
   * @param retryableErrors Function to determine if an error is retryable
   * @returns Promise resolving to the function result
   */
  protected async withRetry<T>(
    fn: () => Promise<T>,
    retryableErrors: (error: any) => boolean = (error) => this.isRetryableError(error)
  ): Promise<T> {
    let lastError: any;

    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        // Don't retry on the last attempt
        if (attempt === this.retryConfig.maxRetries) {
          break;
        }

        // Only retry if the error is retryable
        if (!retryableErrors(error)) {
          break;
        }

        // Extract retry-after from error if available
        let retryAfter: number | undefined;
        if (error.retryAfter) {
          retryAfter = error.retryAfter;
        }

        const delay = this.calculateBackoff(attempt, retryAfter);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  /**
   * Check if an HTTP error is retryable
   * @param statusCode The HTTP status code
   * @returns True if the error is retryable
   */
  protected isRetryableHttpError(statusCode: number): boolean {
    return statusCode >= 500 || statusCode === 429 || statusCode === 408;
  }
}