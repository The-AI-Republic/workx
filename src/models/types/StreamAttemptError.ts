/**
 * Internal error classification for stream retry logic
 *
 * Provides retry logic, backoff calculation, and error conversion.
 */

/**
 * StreamAttemptError represents the three types of errors that can occur
 * during streaming attempts:
 * - RetryableHttp: HTTP errors that can be retried (429, 500-599, 401)
 * - RetryableTransport: Network/transport errors that can be retried
 * - Fatal: Non-retryable errors (4xx except 401/429)
 */
export class StreamAttemptError extends Error {
  readonly type: 'RetryableHttp' | 'RetryableTransport' | 'Fatal';
  readonly status?: number;
  readonly retryAfter?: number;
  readonly cause?: Error;

  private constructor(
    type: 'RetryableHttp' | 'RetryableTransport' | 'Fatal',
    message: string,
    options?: { status?: number; retryAfter?: number; cause?: Error }
  ) {
    super(message);
    this.type = type;
    this.status = options?.status;
    this.retryAfter = options?.retryAfter;
    this.cause = options?.cause;
    this.name = 'StreamAttemptError';

    // Maintain proper prototype chain
    Object.setPrototypeOf(this, StreamAttemptError.prototype);
  }

  /**
   * Create a retryable HTTP error (e.g., 429 rate limit, 500 server error)
   */
  static retryableHttp(status: number, retryAfter?: number): StreamAttemptError {
    return new StreamAttemptError('RetryableHttp', `HTTP ${status}`, { status, retryAfter });
  }

  /**
   * Create a retryable transport/network error
   */
  static retryableTransport(error: Error): StreamAttemptError {
    return new StreamAttemptError('RetryableTransport', error.message, { cause: error });
  }

  /**
   * Create a fatal (non-retryable) error
   */
  static fatal(error: Error): StreamAttemptError {
    return new StreamAttemptError('Fatal', error.message, { cause: error });
  }

  /**
   * Classify an HTTP status code into the appropriate error type
   *
   * Classification rules:
   * - 401: Retryable (auth refresh)
   * - 429: Retryable (rate limit)
   * - 500-599: Retryable (server errors)
   * - Other 4xx: Fatal (client errors)
   */
  static fromHttpStatus(status: number, retryAfter?: number): StreamAttemptError {
    // Retryable status codes
    if (status === 401 || status === 429 || status >= 500) {
      return StreamAttemptError.retryableHttp(status, retryAfter);
    }

    // Fatal for other 4xx errors
    if (status >= 400 && status < 500) {
      return StreamAttemptError.fatal(new Error(`HTTP ${status}: Client error`));
    }

    // Unexpected status code - treat as fatal
    return StreamAttemptError.fatal(new Error(`Unexpected HTTP ${status}`));
  }

  /**
   * Calculate backoff delay: 2^(attempt+1) * 1000ms + jitter
   *
   * @param attempt The current attempt number (0-based)
   * @returns Delay in milliseconds before next retry
   */
  delay(attempt: number): number {
    // If server provided retry-after, use that with minimal jitter
    if (this.type === 'RetryableHttp' && this.retryAfter !== undefined) {
      const jitter = this.retryAfter * 0.1;
      return this.retryAfter + Math.random() * jitter;
    }

    // Exponential backoff: 2^(attempt+1) * 1000ms
    // attempt=0: 2^1 * 1000 = 2000ms
    // attempt=1: 2^2 * 1000 = 4000ms
    // attempt=2: 2^3 * 1000 = 8000ms
    const baseDelay = Math.pow(2, attempt + 1) * 1000;

    // Add jitter (up to 10% of base delay)
    const jitter = baseDelay * 0.1;
    return baseDelay + Math.random() * jitter;
  }

  /**
   * Convert to error for throwing
   *
   * @returns Error suitable for throwing to user code
   */
  intoError(): Error {
    // Fatal errors return the underlying cause
    if (this.type === 'Fatal') {
      return this.cause || this;
    }

    // Retryable HTTP errors with specific messages
    if (this.type === 'RetryableHttp') {
      if (this.status === 429) {
        return new Error(`Rate limit exceeded${this.retryAfter ? ` (retry after ${this.retryAfter}ms)` : ''}`);
      }
      if (this.status === 401) {
        return new Error('Authentication failed - check API key');
      }
      if (this.status && this.status >= 500) {
        return new Error(`Server error (HTTP ${this.status})`);
      }
    }

    // Retryable transport errors
    if (this.type === 'RetryableTransport') {
      return new Error(`Network error: ${this.cause?.message || 'Unknown'}`);
    }

    // Fallback: exceeded retry limit
    return new Error(`Request failed after maximum retries: ${this.message}`);
  }

  /**
   * Check if this error is retryable
   */
  isRetryable(): boolean {
    return this.type !== 'Fatal';
  }

  /**
   * Get a human-readable description of the error
   */
  toString(): string {
    switch (this.type) {
      case 'RetryableHttp':
        return `RetryableHttp(${this.status}${this.retryAfter ? `, retry_after=${this.retryAfter}` : ''})`;
      case 'RetryableTransport':
        return `RetryableTransport(${this.cause?.message || 'unknown'})`;
      case 'Fatal':
        return `Fatal(${this.cause?.message || this.message})`;
    }
  }
}

/**
 * Type guard to check if an error is a StreamAttemptError
 */
export function isStreamAttemptError(error: unknown): error is StreamAttemptError {
  return error instanceof StreamAttemptError;
}

/**
 * Helper to create appropriate StreamAttemptError from unknown error
 */
export function classifyError(error: unknown): StreamAttemptError {
  if (isStreamAttemptError(error)) {
    return error;
  }

  if (error instanceof Error) {
    // Check for network error codes in message
    const message = error.message.toLowerCase();
    if (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('econnrefused')
    ) {
      return StreamAttemptError.retryableTransport(error);
    }

    // Default to fatal for unknown errors
    return StreamAttemptError.fatal(error);
  }

  // Non-Error objects become fatal
  return StreamAttemptError.fatal(new Error(String(error)));
}
