/**
 * Comprehensive tests for error handling and recovery
 * Tests extended error classes, retry logic, and error metadata preservation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ModelClientError,
  RateLimitError,
  UsageLimitReachedError,
  NetworkError,
  AuthenticationError,
  QuotaExceededError,
  ModelError,
  ContentPolicyError,
  ErrorFactory,
  ErrorTypeGuards,
  type PlanType,
  type RateLimitMetadata,
  type UsageLimitMetadata,
  type NetworkMetadata,
} from '../ModelClientError';
import { ModelClient } from '../ModelClient';

// Mock implementation for testing
class TestModelClient extends ModelClient {
  private mockComplete: () => Promise<any>;
  private mockStream: () => AsyncGenerator<any>;

  constructor(mockComplete?: () => Promise<any>, mockStream?: () => AsyncGenerator<any>) {
    super();
    this.mockComplete = mockComplete || (() => Promise.resolve({}));
    this.mockStream = mockStream || (async function* () { yield {}; });
  }

  async complete(request: any): Promise<any> {
    this.validateRequest(request);
    return this.withRetry(() => this.mockComplete());
  }

  async *stream(request: any): AsyncGenerator<any> {
    this.validateRequest(request);
    yield* this.mockStream();
  }

  countTokens(text: string, model: string): number {
    return text.length / 4; // Rough approximation
  }

  getProvider(): any {
    return {
      name: 'test',
      baseUrl: 'https://test.api.com',
      wireApi: 'Responses',
      requiresOpenaiAuth: false,
      requestMaxRetries: 3,
      streamMaxRetries: 2,
      streamIdleTimeoutMs: 30000,
    };
  }

  async *streamCompletion(request: any): AsyncGenerator<any> {
    yield* this.stream(request);
  }

  getModel(): string {
    return 'test-model';
  }

  setModel(model: string): void {
    // No-op for testing
  }

  getContextWindow(): number | undefined {
    return 4000;
  }

  getModelContextWindow(): number | undefined {
    return 4000;
  }

  getAutoCompactTokenLimit(): number | undefined {
    return 3200;
  }

  getModelFamily(): any {
    return {
      family: 'test-family',
      base_instructions: 'Test instructions',
      supports_reasoning_summaries: false,
      needs_special_apply_patch_instructions: false,
    };
  }

  getAuthManager(): any {
    return null;
  }

  getReasoningEffort(): any {
    return null;
  }

  setReasoningEffort(effort: any): void {
    // No-op for testing
  }

  getReasoningSummary(): any {
    return null;
  }

  setReasoningSummary(summary: any): void {
    // No-op for testing
  }

  protected async *streamResponses(request: any): AsyncGenerator<any> {
    yield* this.stream(request);
  }

  protected async *streamChat(request: any): AsyncGenerator<any> {
    yield* this.stream(request);
  }

  protected async *attemptStreamResponses(request: any, attempt: number): AsyncGenerator<any> {
    yield* this.stream(request);
  }

  protected async *processSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<any> {
    yield {};
  }

  protected parseRateLimitSnapshot(headers: Headers): any {
    return undefined;
  }

  // Expose protected methods for testing
  public testIsRetryableError(error: any): boolean {
    return this.isRetryableError(error);
  }

  public testWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    return this.withRetry(fn);
  }

  public testCalculateBackoff(attempt: number, retryAfter?: number): number {
    return this.calculateBackoff(attempt, retryAfter);
  }
}

describe('Extended Error Classes', () => {
  describe('RateLimitError', () => {
    const rateLimitMetadata: RateLimitMetadata = {
      limit: 100,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 3600,
      window: 3600,
      retryAfter: 5000,
    };

    it('should create rate limit error with metadata', () => {
      const error = new RateLimitError(
        'Rate limit exceeded',
        rateLimitMetadata,
        429,
        'openai'
      );

      expect(error).toBeInstanceOf(ModelClientError);
      expect(error.name).toBe('RateLimitError');
      expect(error.statusCode).toBe(429);
      expect(error.provider).toBe('openai');
      expect(error.retryable).toBe(true);
      expect(error.retryAfter).toBe(5000);
      expect(error.rateLimitMetadata).toEqual(rateLimitMetadata);
    });

    it('should provide human-readable rate limit description', () => {
      const error = new RateLimitError('Test', rateLimitMetadata);
      const description = error.getRateLimitDescription();

      expect(description).toContain('Rate limit of 100 requests per 3600s exceeded');
      expect(description).toContain('0 requests remaining');
      expect(description).toContain('Resets at');
    });
  });

  describe('UsageLimitReachedError', () => {
    const usageLimitMetadata: UsageLimitMetadata = {
      planType: 'free',
      currentUsage: 100,
      planLimit: 100,
      suggestedPlan: 'pro',
    };

    it('should create usage limit error with metadata', () => {
      const error = new UsageLimitReachedError(
        'Usage limit reached',
        usageLimitMetadata,
        402,
        'anthropic'
      );

      expect(error).toBeInstanceOf(ModelClientError);
      expect(error.name).toBe('UsageLimitReachedError');
      expect(error.statusCode).toBe(402);
      expect(error.provider).toBe('anthropic');
      expect(error.retryable).toBe(false);
      expect(error.usageLimitMetadata).toEqual(usageLimitMetadata);
    });

    it('should provide usage limit description', () => {
      const error = new UsageLimitReachedError('Test', usageLimitMetadata);
      const description = error.getUsageLimitDescription();

      expect(description).toContain('Usage limit reached for free plan: 100/100');
    });

    it('should handle unlimited plans', () => {
      const unlimitedMetadata: UsageLimitMetadata = {
        planType: 'enterprise',
        currentUsage: 1000,
        planLimit: -1,
      };
      const error = new UsageLimitReachedError('Test', unlimitedMetadata);
      const description = error.getUsageLimitDescription();

      expect(description).toContain('Unlimited usage for enterprise plan, current usage: 1000');
    });

    it('should indicate upgrade suggestions', () => {
      const error = new UsageLimitReachedError('Test', usageLimitMetadata);
      expect(error.hasUpgradeSuggestion()).toBe(true);

      const noSuggestionMetadata = { ...usageLimitMetadata, suggestedPlan: undefined };
      const errorNoSuggestion = new UsageLimitReachedError('Test', noSuggestionMetadata);
      expect(errorNoSuggestion.hasUpgradeSuggestion()).toBe(false);
    });
  });

  describe('NetworkError', () => {
    const networkMetadata: NetworkMetadata = {
      attempts: 2,
      code: 'ECONNRESET',
      aborted: false,
      timeout: 30000,
    };

    it('should create network error with metadata', () => {
      const error = new NetworkError('Connection reset', networkMetadata, undefined, 'openai');

      expect(error).toBeInstanceOf(ModelClientError);
      expect(error.name).toBe('NetworkError');
      expect(error.retryable).toBe(true);
      expect(error.networkMetadata).toEqual(networkMetadata);
    });

    it('should not be retryable if aborted', () => {
      const abortedMetadata = { ...networkMetadata, aborted: true };
      const error = new NetworkError('Aborted', abortedMetadata);
      expect(error.retryable).toBe(false);
    });

    it('should detect timeout errors', () => {
      const timeoutMetadata = { ...networkMetadata, code: 'ETIMEDOUT' };
      const error = new NetworkError('Timeout', timeoutMetadata);
      expect(error.isTimeout()).toBe(true);

      const regularError = new NetworkError('Regular error', networkMetadata);
      expect(regularError.isTimeout()).toBe(true); // Has timeout property
    });

    it('should detect connection errors', () => {
      const error = new NetworkError('Connection reset', networkMetadata);
      expect(error.isConnectionError()).toBe(true);

      const dnsError = new NetworkError('DNS failed', {
        ...networkMetadata,
        code: 'ENOTFOUND'
      });
      expect(dnsError.isConnectionError()).toBe(true);
    });
  });

  describe('AuthenticationError', () => {
    it('should create authentication error', () => {
      const error = new AuthenticationError('Invalid API key', 401, 'openai');

      expect(error).toBeInstanceOf(ModelClientError);
      expect(error.name).toBe('AuthenticationError');
      expect(error.statusCode).toBe(401);
      expect(error.retryable).toBe(false);
    });
  });

  describe('Other Error Types', () => {
    it('should create quota exceeded error', () => {
      const error = new QuotaExceededError('Quota exceeded', 'free', 402, 'openai');
      expect(error.name).toBe('QuotaExceededError');
      expect(error.planType).toBe('free');
      expect(error.retryable).toBe(false);
    });

    it('should create model error', () => {
      const error = new ModelError('Model unavailable', 'gpt-4', 503, 'openai', true);
      expect(error.name).toBe('ModelError');
      expect(error.modelName).toBe('gpt-4');
      expect(error.retryable).toBe(true);
    });

    it('should create content policy error', () => {
      const error = new ContentPolicyError('Content blocked', 'harmful', 400, 'openai');
      expect(error.name).toBe('ContentPolicyError');
      expect(error.contentType).toBe('harmful');
      expect(error.retryable).toBe(false);
    });
  });
});

describe('Error Factory', () => {
  describe('createRateLimitError', () => {
    it('should create rate limit error from headers', () => {
      const headers = {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '5',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'x-ratelimit-window': '3600',
        'retry-after': '60',
      };

      const error = ErrorFactory.createRateLimitError(headers, 'openai');

      expect(error).toBeInstanceOf(RateLimitError);
      expect(error.rateLimitMetadata.limit).toBe(100);
      expect(error.rateLimitMetadata.remaining).toBe(5);
      expect(error.rateLimitMetadata.retryAfter).toBe(60000);
      expect(error.provider).toBe('openai');
    });

    it('should handle missing headers gracefully', () => {
      const error = ErrorFactory.createRateLimitError({});
      expect(error.rateLimitMetadata.limit).toBe(0);
      expect(error.rateLimitMetadata.remaining).toBe(0);
    });
  });

  describe('createUsageLimitError', () => {
    it('should create usage limit error for different plan types', () => {
      const planTypes: PlanType[] = ['free', 'pro', 'team', 'enterprise'];

      planTypes.forEach(planType => {
        const error = ErrorFactory.createUsageLimitError(planType, 100, 100);
        expect(error).toBeInstanceOf(UsageLimitReachedError);
        expect(error.usageLimitMetadata.planType).toBe(planType);
      });
    });

    it('should suggest appropriate upgrades', () => {
      const freeError = ErrorFactory.createUsageLimitError('free', 100, 100);
      expect(freeError.usageLimitMetadata.suggestedPlan).toBe('pro');

      const proError = ErrorFactory.createUsageLimitError('pro', 1000, 1000);
      expect(proError.usageLimitMetadata.suggestedPlan).toBe('team');

      const teamError = ErrorFactory.createUsageLimitError('team', 5000, 5000);
      expect(teamError.usageLimitMetadata.suggestedPlan).toBeUndefined();
    });

    it('should handle unlimited plans', () => {
      const error = ErrorFactory.createUsageLimitError('enterprise', 1000, -1);
      expect(error.message).toContain('Unexpected usage limit reached');
    });
  });

  describe('createNetworkError', () => {
    it('should create network errors from different exception types', () => {
      const testCases = [
        { error: { code: 'ETIMEDOUT' }, expectedMessage: 'Request timed out' },
        { error: { code: 'ENOTFOUND' }, expectedMessage: 'DNS lookup failed' },
        { error: { code: 'ECONNRESET' }, expectedMessage: 'Connection was reset' },
        { error: { code: 'ECONNREFUSED' }, expectedMessage: 'Connection was refused' },
        { error: { name: 'AbortError' }, expectedMessage: 'Request was aborted' },
        { error: { message: 'Unknown error' }, expectedMessage: 'Network error occurred' },
      ];

      testCases.forEach(({ error, expectedMessage }) => {
        const networkError = ErrorFactory.createNetworkError(error, 2, 'openai');
        expect(networkError).toBeInstanceOf(NetworkError);
        expect(networkError.message).toBe(expectedMessage);
        expect(networkError.networkMetadata.attempts).toBe(2);
        expect(networkError.provider).toBe('openai');
      });
    });
  });

  describe('createAuthError', () => {
    it('should create different types of authentication errors', () => {
      const authReasons = [
        'invalid_key',
        'expired_key',
        'insufficient_permissions',
        'unknown'
      ] as const;

      authReasons.forEach(reason => {
        const error = ErrorFactory.createAuthError(reason, 'anthropic');
        expect(error).toBeInstanceOf(AuthenticationError);
        expect(error.message).toBeTruthy();
        expect(error.provider).toBe('anthropic');
      });
    });
  });

  describe('createModelError', () => {
    it('should create model errors with appropriate retryability', () => {
      const modelReasons = [
        { reason: 'not_found', retryable: false, statusCode: 404 },
        { reason: 'unavailable', retryable: true, statusCode: 503 },
        { reason: 'deprecated', retryable: false, statusCode: 400 },
        { reason: 'unsupported_feature', retryable: false, statusCode: 400 },
        { reason: 'unknown', retryable: false, statusCode: 400 },
      ] as const;

      modelReasons.forEach(({ reason, retryable, statusCode }) => {
        const error = ErrorFactory.createModelError('gpt-4', reason, 'openai');
        expect(error).toBeInstanceOf(ModelError);
        expect(error.retryable).toBe(retryable);
        expect(error.statusCode).toBe(statusCode);
        expect(error.modelName).toBe('gpt-4');
      });
    });
  });
});

describe('Error Type Guards', () => {
  const rateLimitError = new RateLimitError('Test', {
    limit: 100, remaining: 0, reset: 0, window: 3600
  });
  const usageLimitError = new UsageLimitReachedError('Test', {
    planType: 'free', currentUsage: 100, planLimit: 100
  });
  const networkError = new NetworkError('Test', { attempts: 1, aborted: false });
  const authError = new AuthenticationError('Test');
  const quotaError = new QuotaExceededError('Test', 'free');
  const modelError = new ModelError('Test', 'gpt-4');
  const contentError = new ContentPolicyError('Test', 'harmful');
  const baseError = new ModelClientError('Test');
  const regularError = new Error('Regular error');

  it('should correctly identify error types', () => {
    expect(ErrorTypeGuards.isRateLimitError(rateLimitError)).toBe(true);
    expect(ErrorTypeGuards.isRateLimitError(usageLimitError)).toBe(false);

    expect(ErrorTypeGuards.isUsageLimitError(usageLimitError)).toBe(true);
    expect(ErrorTypeGuards.isUsageLimitError(rateLimitError)).toBe(false);

    expect(ErrorTypeGuards.isNetworkError(networkError)).toBe(true);
    expect(ErrorTypeGuards.isNetworkError(authError)).toBe(false);

    expect(ErrorTypeGuards.isAuthenticationError(authError)).toBe(true);
    expect(ErrorTypeGuards.isAuthenticationError(quotaError)).toBe(false);

    expect(ErrorTypeGuards.isQuotaError(quotaError)).toBe(true);
    expect(ErrorTypeGuards.isQuotaError(modelError)).toBe(false);

    expect(ErrorTypeGuards.isModelError(modelError)).toBe(true);
    expect(ErrorTypeGuards.isModelError(contentError)).toBe(false);

    expect(ErrorTypeGuards.isContentPolicyError(contentError)).toBe(true);
    expect(ErrorTypeGuards.isContentPolicyError(baseError)).toBe(false);

    expect(ErrorTypeGuards.isModelClientError(baseError)).toBe(true);
    expect(ErrorTypeGuards.isModelClientError(rateLimitError)).toBe(true);
    expect(ErrorTypeGuards.isModelClientError(regularError)).toBe(false);
  });
});

describe('Error Recovery and Retry Logic', () => {
  let client: TestModelClient;
  let mockComplete: vi.Mock;

  beforeEach(() => {
    mockComplete = vi.fn();
    client = new TestModelClient(mockComplete);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Retry Logic', () => {
    it('should retry retryable errors', async () => {
      const retryableError = new RateLimitError('Rate limited', {
        limit: 100, remaining: 0, reset: 0, window: 3600, retryAfter: 1000
      });

      mockComplete
        .mockRejectedValueOnce(retryableError)
        .mockResolvedValueOnce({ id: 'success' });

      const request = { model: 'test', messages: [{ role: 'user' as const, content: 'test' }] };

      // Start the completion
      const completionPromise = client.complete(request);

      // Fast-forward through the retry delay
      await vi.advanceTimersToNextTimerAsync();

      const result = await completionPromise;
      expect(result).toEqual({ id: 'success' });
      expect(mockComplete).toHaveBeenCalledTimes(2);
    });

    it('should not retry non-retryable errors', async () => {
      const nonRetryableError = new AuthenticationError('Invalid key');
      mockComplete.mockRejectedValue(nonRetryableError);

      const request = { model: 'test', messages: [{ role: 'user' as const, content: 'test' }] };

      await expect(client.complete(request)).rejects.toThrow(AuthenticationError);
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });

    it('should respect maximum retry attempts', async () => {
      const retryableError = new NetworkError('Connection failed', {
        attempts: 0, aborted: false
      });

      mockComplete.mockRejectedValue(retryableError);

      const request = { model: 'test', messages: [{ role: 'user' as const, content: 'test' }] };

      const completionPromise = client.complete(request);

      // Fast-forward through all retries
      for (let i = 0; i <= 3; i++) { // maxRetries is 3 by default
        await vi.advanceTimersToNextTimerAsync();
      }

      await expect(completionPromise).rejects.toThrow(NetworkError);
      expect(mockComplete).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    });

    it('should use retry-after delays from rate limit errors', async () => {
      const rateLimitError = new RateLimitError('Rate limited', {
        limit: 100, remaining: 0, reset: 0, window: 3600, retryAfter: 5000
      });

      mockComplete
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ id: 'success' });

      const request = { model: 'test', messages: [{ role: 'user' as const, content: 'test' }] };

      const completionPromise = client.complete(request);

      // The retry should wait approximately 5000ms (with jitter)
      await vi.advanceTimersByTimeAsync(4000); // Not enough time
      expect(mockComplete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000); // Should be enough with jitter
      await completionPromise;

      expect(mockComplete).toHaveBeenCalledTimes(2);
    });
  });

  describe('Backoff Calculation', () => {
    it('should calculate exponential backoff', () => {
      const delays = [0, 1, 2, 3].map(attempt =>
        client.testCalculateBackoff(attempt)
      );

      // Each delay should be larger than the previous (with jitter considered)
      expect(delays[1]).toBeGreaterThan(900); // ~1000ms base delay
      expect(delays[2]).toBeGreaterThan(1800); // ~2000ms
      expect(delays[3]).toBeGreaterThan(3600); // ~4000ms
    });

    it('should respect retry-after headers', () => {
      const retryAfter = 10000;
      const delay = client.testCalculateBackoff(0, retryAfter);

      // Should be close to retryAfter value (with jitter)
      expect(delay).toBeGreaterThan(retryAfter);
      expect(delay).toBeLessThan(retryAfter * 1.2); // Max 20% jitter
    });

    it('should cap maximum delay', () => {
      // Very high attempt number should be capped
      const delay = client.testCalculateBackoff(10);
      expect(delay).toBeLessThan(35000); // maxDelay is 30000 + jitter
    });
  });

  describe('Error Detection', () => {
    it('should correctly identify retryable errors', () => {
      const retryableErrors = [
        new RateLimitError('Rate limited', { limit: 100, remaining: 0, reset: 0, window: 3600 }),
        new NetworkError('Network failed', { attempts: 1, aborted: false }),
        new ModelError('Model unavailable', 'gpt-4', 503, 'openai', true),
        { status: 500 }, // HTTP 500 error
        { statusCode: 502 }, // HTTP 502 error
        { code: 'ECONNRESET' }, // Network error
      ];

      retryableErrors.forEach(error => {
        expect(client.testIsRetryableError(error)).toBe(true);
      });
    });

    it('should correctly identify non-retryable errors', () => {
      const nonRetryableErrors = [
        new AuthenticationError('Invalid key'),
        new UsageLimitReachedError('Usage exceeded', {
          planType: 'free', currentUsage: 100, planLimit: 100
        }),
        new ContentPolicyError('Content blocked', 'harmful'),
        { status: 400 }, // HTTP 400 error
        { name: 'AbortError' }, // Aborted request
      ];

      nonRetryableErrors.forEach(error => {
        expect(client.testIsRetryableError(error)).toBe(false);
      });
    });
  });

  describe('Usage Limit Scenarios', () => {
    const usageLimitTestCases: Array<{
      planType: PlanType;
      currentUsage: number;
      planLimit: number;
      shouldHaveSuggestion: boolean;
    }> = [
      { planType: 'free', currentUsage: 100, planLimit: 100, shouldHaveSuggestion: true },
      { planType: 'pro', currentUsage: 1000, planLimit: 1000, shouldHaveSuggestion: true },
      { planType: 'team', currentUsage: 5000, planLimit: 5000, shouldHaveSuggestion: false },
      { planType: 'enterprise', currentUsage: 1000, planLimit: -1, shouldHaveSuggestion: false },
    ];

    it.each(usageLimitTestCases)(
      'should handle $planType plan limits correctly',
      ({ planType, currentUsage, planLimit, shouldHaveSuggestion }) => {
        const error = ErrorFactory.createUsageLimitError(planType, currentUsage, planLimit);

        expect(error.usageLimitMetadata.planType).toBe(planType);
        expect(error.usageLimitMetadata.currentUsage).toBe(currentUsage);
        expect(error.usageLimitMetadata.planLimit).toBe(planLimit);
        expect(error.hasUpgradeSuggestion()).toBe(shouldHaveSuggestion);
      }
    );
  });

  describe('Network Error Scenarios', () => {
    const networkTestCases = [
      { code: 'ETIMEDOUT', expectedMessage: 'Request timed out', shouldRetry: true },
      { code: 'ENOTFOUND', expectedMessage: 'DNS lookup failed', shouldRetry: true },
      { code: 'ECONNRESET', expectedMessage: 'Connection was reset', shouldRetry: true },
      { code: 'ECONNREFUSED', expectedMessage: 'Connection was refused', shouldRetry: true },
      { name: 'AbortError', expectedMessage: 'Request was aborted', shouldRetry: false },
    ];

    it.each(networkTestCases)(
      'should handle $code network errors correctly',
      ({ code, name, expectedMessage, shouldRetry }) => {
        const mockError = code ? { code } : { name };
        const networkError = ErrorFactory.createNetworkError(mockError, 1, 'test');

        expect(networkError.message).toBe(expectedMessage);
        expect(networkError.retryable).toBe(shouldRetry);
        expect(networkError.networkMetadata.attempts).toBe(1);
      }
    );
  });

  describe('Error Metadata Preservation', () => {
    it('should preserve rate limit metadata through retries', async () => {
      const originalMetadata: RateLimitMetadata = {
        limit: 100,
        remaining: 0,
        reset: Math.floor(Date.now() / 1000) + 3600,
        window: 3600,
        retryAfter: 1000
      };

      const rateLimitError = new RateLimitError('Rate limited', originalMetadata);
      mockComplete.mockRejectedValue(rateLimitError);

      const request = { model: 'test', messages: [{ role: 'user' as const, content: 'test' }] };

      try {
        await client.testWithRetry(() => mockComplete());
      } catch (error) {
        expect(error).toBeInstanceOf(RateLimitError);
        if (error instanceof RateLimitError) {
          expect(error.rateLimitMetadata).toEqual(originalMetadata);
        }
      }
    });

    it('should preserve usage limit metadata in error chains', () => {
      const originalMetadata: UsageLimitMetadata = {
        planType: 'pro',
        currentUsage: 1000,
        planLimit: 1000,
        resetTime: Date.now() + 86400000,
        suggestedPlan: 'team',
      };

      const usageError = new UsageLimitReachedError('Usage exceeded', originalMetadata);

      expect(usageError.usageLimitMetadata).toEqual(originalMetadata);
      expect(usageError.usageLimitMetadata.resetTime).toBe(originalMetadata.resetTime);
    });
  });
});

describe('Integration with ModelClient Base Class', () => {
  let client: TestModelClient;

  beforeEach(() => {
    client = new TestModelClient();
  });

  it('should validate requests and throw appropriate errors', () => {
    expect(() => client.complete({ model: '', messages: [] })).toThrow(ModelClientError);
    expect(() => client.complete({ model: 'test', messages: [] })).toThrow(ModelClientError);
    expect(() => client.complete({
      model: 'test',
      messages: [{ role: 'invalid' as any, content: 'test' }]
    })).toThrow(ModelClientError);
  });

  it('should handle tool message validation', () => {
    expect(() => client.complete({
      model: 'test',
      messages: [{ role: 'tool', content: 'result' }] // Missing toolCallId
    })).toThrow(ModelClientError);

    // Should not throw with valid tool message
    expect(() => client.complete({
      model: 'test',
      messages: [{ role: 'tool', content: 'result', toolCallId: 'call_123' }]
    })).not.toThrow();
  });

  it('should validate temperature and maxTokens', () => {
    expect(() => client.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'test' }],
      temperature: -1
    })).toThrow(ModelClientError);

    expect(() => client.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 0
    })).toThrow(ModelClientError);
  });
});

/**
 * Error Handling and Retries Integration Tests
 *
 * These tests verify error handling and retry logic for the Responses API.
 */
describe('Error Handling and Retries Integration', () => {
  let client: any;
  let mockModelFamily: any;
  let mockProvider: any;

  beforeEach(async () => {
    // Dynamically import to avoid module resolution issues during testing
    const { OpenAIResponsesClient } = await import('../OpenAIResponsesClient');

    mockModelFamily = {
      family: 'gpt-4',
      base_instructions: 'You are a helpful assistant.',
      supports_reasoning_summaries: false,
      needsSpecialApplyPatchInstructions: false,
    };

    mockProvider = {
      name: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      wireApi: 'responses' as const,
      requestMaxRetries: 3,
      streamIdleTimeoutMs: 60000,
    };

    client = new OpenAIResponsesClient(
      {
        apiKey: 'test-api-key',
        conversationId: 'error-test',
        modelFamily: mockModelFamily,
        provider: mockProvider,
      },
      { maxRetries: 3, baseDelayMs: 100 }
    );

    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Invalid API Key (401) - No Retries', () => {
    it('throws immediately on 401 authentication error without retrying', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => JSON.stringify({
          error: {
            message: 'Invalid API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        }),
        headers: new Headers(),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      // Contract: 401 errors should NOT retry
      await expect(client.stream(prompt)).rejects.toThrow(/invalid api key|unauthorized/i);

      // Should only be called once (no retries)
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('Empty Input Validation', () => {
    it('throws ModelClientError on empty input array', async () => {
      const prompt = {
        input: [],
        tools: [],
      };

      // Contract: Must validate before making API call
      await expect(client.stream(prompt)).rejects.toThrow();

      // Should not make any API calls
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('429 Rate Limit - Retry with Exponential Backoff', () => {
    it('retries 429 errors with exponential backoff', async () => {
      let callCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;

        if (callCount < 3) {
          // First 2 calls return 429
          return {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: async () => JSON.stringify({
              error: {
                message: 'Rate limit exceeded. Please retry after 2 seconds.',
                type: 'rate_limit_error',
                code: 'rate_limit_exceeded',
              },
            }),
            headers: new Headers({
              'retry-after': '2',
              'x-ratelimit-limit': '100',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120),
            }),
          } as Response;
        }

        // Third call succeeds
        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
              );
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.completed","response":{"id":"test"}}\\n\\n')
              );
              controller.close();
            },
          }),
        } as Response;
      });

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      // Contract: Should retry 429 errors
      const streamPromise = client.stream(prompt);

      // Advance through retry delays
      await vi.advanceTimersToNextTimerAsync();
      await vi.advanceTimersToNextTimerAsync();

      const stream = await streamPromise;

      // Should have retried and succeeded
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(stream).toBeDefined();
    });

    it('respects retry-after header from 429 response', async () => {
      let callCount = 0;
      const retryAfterSeconds = 5;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;

        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: async () => JSON.stringify({
              error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
            }),
            headers: new Headers({
              'retry-after': String(retryAfterSeconds),
            }),
          } as Response;
        }

        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
              );
              controller.close();
            },
          }),
        } as Response;
      });

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const streamPromise = client.stream(prompt);

      // Should wait approximately retry-after seconds
      await vi.advanceTimersByTimeAsync((retryAfterSeconds * 1000) + 500);

      await streamPromise;

      expect(callCount).toBe(2);
    });
  });

  describe('5xx Server Errors - Retry with Backoff', () => {
    it('retries 500 internal server errors', async () => {
      let callCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;

        if (callCount === 1) {
          return {
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            text: async () => JSON.stringify({
              error: { message: 'Internal server error', type: 'server_error' },
            }),
            headers: new Headers(),
          } as Response;
        }

        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
              );
              controller.close();
            },
          }),
        } as Response;
      });

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const streamPromise = client.stream(prompt);

      await vi.advanceTimersToNextTimerAsync();

      await streamPromise;

      // Contract: 5xx errors should retry
      expect(callCount).toBe(2);
    });

    it('retries 503 service unavailable errors', async () => {
      let callCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;

        if (callCount < 2) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => JSON.stringify({
              error: { message: 'Service temporarily unavailable', type: 'server_error' },
            }),
            headers: new Headers(),
          } as Response;
        }

        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
              );
              controller.close();
            },
          }),
        } as Response;
      });

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const streamPromise = client.stream(prompt);

      await vi.advanceTimersToNextTimerAsync();

      await streamPromise;

      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Max Retries Exhausted', () => {
    it('throws after max retries are exhausted', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => JSON.stringify({
          error: { message: 'Service unavailable', type: 'server_error' },
        }),
        headers: new Headers(),
      } as Response);

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const streamPromise = client.stream(prompt);

      // Advance through all retry attempts (maxRetries = 3)
      for (let i = 0; i <= 3; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      // Contract: Should throw after all retries exhausted
      await expect(streamPromise).rejects.toThrow(/service unavailable|server error/i);

      // Should have tried initial + 3 retries = 4 total
      expect(global.fetch).toHaveBeenCalledTimes(4);
    });
  });

  describe('Exponential Backoff Verification', () => {
    it('increases delay exponentially between retries', async () => {
      const delays: number[] = [];
      let callCount = 0;
      let lastCallTime = Date.now();

      global.fetch = vi.fn().mockImplementation(async () => {
        const now = Date.now();
        if (callCount > 0) {
          delays.push(now - lastCallTime);
        }
        lastCallTime = now;
        callCount++;

        if (callCount <= 3) {
          return {
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => JSON.stringify({
              error: { message: 'Service unavailable', type: 'server_error' },
            }),
            headers: new Headers(),
          } as Response;
        }

        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
              );
              controller.close();
            },
          }),
        } as Response;
      });

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const streamPromise = client.stream(prompt);

      // Advance through all retries
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      await streamPromise;

      // Contract: Each delay should be larger than previous (exponential)
      // Formula: baseDelay * 2^attempt with jitter
      expect(delays.length).toBeGreaterThan(0);

      // First delay should be around baseDelayMs (100ms)
      if (delays.length > 0) {
        expect(delays[0]).toBeGreaterThan(80); // Account for jitter
      }

      // Each subsequent delay should generally increase (exponential pattern)
      if (delays.length > 1) {
        expect(delays[1]).toBeGreaterThan(delays[0] * 0.8); // Allow for jitter variance
      }
    });
  });

  describe('Network Errors - Retry Logic', () => {
    it('retries on network connection errors', async () => {
      let callCount = 0;

      global.fetch = vi.fn().mockImplementation(async () => {
        callCount++;

        if (callCount === 1) {
          throw Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' });
        }

        return {
          ok: true,
          headers: new Headers(),
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('data: {"type":"response.created","response":{"id":"test"}}\\n\\n')
              );
              controller.close();
            },
          }),
        } as Response;
      });

      const prompt = {
        input: [{ type: 'message' as const, role: 'user' as const, content: 'Test' }],
        tools: [],
      };

      const streamPromise = client.stream(prompt);

      await vi.advanceTimersToNextTimerAsync();

      await streamPromise;

      // Should have retried network error
      expect(callCount).toBe(2);
    });
  });
});