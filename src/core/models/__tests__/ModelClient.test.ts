/**
 * Comprehensive unit tests for ModelClient abstract base class
 *
 * Tests the concrete (non-abstract) methods of ModelClient via a minimal
 * concrete test subclass. Focuses on:
 * - Constructor and default retry configuration
 * - validateRequest() edge cases
 * - calculateBackoff() logic (exponential, jitter, cap, retry-after)
 * - isRetryableError() classification
 * - isRetryableHttpError() status code checks
 * - withRetry() orchestration (retries, exhaustion, custom predicates)
 * - setModelConfig() / getModelContextWindow()
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ModelClient,
  ModelClientError,
  type CompletionRequest,
  type CompletionResponse,
  type RetryConfig,
} from '../ModelClient';
import type { Prompt, ModelProviderInfo } from '../types/ResponsesAPI';
import type { ResponseEvent } from '../types/ResponseEvent';
import type { RateLimitSnapshot } from '../types/RateLimits';
import type { ResponseStream } from '../ResponseStream';
import type { IModelConfig } from '../../../config/types';

// ---------------------------------------------------------------------------
// Minimal concrete subclass that exposes protected methods for testing
// ---------------------------------------------------------------------------
class TestableModelClient extends ModelClient {
  constructor(retryConfig?: Partial<RetryConfig>) {
    super(retryConfig);
  }

  // ---- abstract method stubs (not under test) ----
  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    throw new Error('Not implemented');
  }

  async stream(_prompt: Prompt): Promise<ResponseStream> {
    throw new Error('Not implemented');
  }

  countTokens(text: string, _model: string): number {
    return text.length;
  }

  async *streamCompletion(_req: CompletionRequest): AsyncGenerator<any> {
    throw new Error('Not implemented');
  }

  getProvider(): ModelProviderInfo {
    return {
      name: 'test',
      base_url: 'https://test.example.com',
      wire_api: 'Responses',
      requires_openai_auth: false,
      request_max_retries: 3,
    };
  }

  getModel(): string {
    return 'test-model';
  }

  setModel(_model: string): void {}

  getAutoCompactTokenLimit(): number | undefined {
    return undefined;
  }

  getModelFamily(): any {
    return { family: 'test' };
  }

  getAuthManager(): any {
    return undefined;
  }

  getReasoningEffort(): any {
    return undefined;
  }

  setReasoningEffort(_effort: any): void {}

  getReasoningSummary(): any {
    return undefined;
  }

  setReasoningSummary(_summary: any): void {}

  protected async *streamResponses(_req: CompletionRequest): AsyncGenerator<ResponseEvent> {
    throw new Error('Not implemented');
  }

  protected async *streamChat(_req: CompletionRequest): AsyncGenerator<ResponseEvent> {
    throw new Error('Not implemented');
  }

  protected async attemptStreamResponses(_attempt: number, _payload: any): Promise<ResponseStream> {
    throw new Error('Not implemented');
  }

  protected async *processSSE(_stream: ReadableStream<Uint8Array>): AsyncGenerator<ResponseEvent> {
    throw new Error('Not implemented');
  }

  protected parseRateLimitSnapshot(_headers?: Headers): RateLimitSnapshot | undefined {
    return undefined;
  }

  // ---- public accessors for protected methods under test ----
  public callValidateRequest(req: CompletionRequest): void {
    return this.validateRequest(req);
  }

  public callCalculateBackoff(attempt: number, retryAfter?: number): number {
    return this.calculateBackoff(attempt, retryAfter);
  }

  public callIsRetryableError(error: any): boolean {
    return this.isRetryableError(error);
  }

  public callIsRetryableHttpError(statusCode: number): boolean {
    return this.isRetryableHttpError(statusCode);
  }

  public callWithRetry<T>(
    fn: () => Promise<T>,
    retryableErrors?: (error: any) => boolean,
  ): Promise<T> {
    return this.withRetry(fn, retryableErrors);
  }

  public getRetryConfig(): RetryConfig {
    return this.retryConfig;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function validRequest(overrides?: Partial<CompletionRequest>): CompletionRequest {
  return {
    model: 'gpt-4',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ModelClient', () => {
  let client: TestableModelClient;

  beforeEach(() => {
    client = new TestableModelClient();
  });

  // =========================================================================
  // Constructor & default retry config
  // =========================================================================
  describe('constructor / retry config', () => {
    it('should use default retry config when none is provided', () => {
      const cfg = client.getRetryConfig();
      expect(cfg.maxRetries).toBe(3);
      expect(cfg.baseDelay).toBe(1000);
      expect(cfg.maxDelay).toBe(30000);
      expect(cfg.backoffMultiplier).toBe(2);
      expect(cfg.jitterPercent).toBe(0.1);
    });

    it('should merge partial retry config with defaults', () => {
      const custom = new TestableModelClient({ maxRetries: 5, baseDelay: 500 });
      const cfg = custom.getRetryConfig();
      expect(cfg.maxRetries).toBe(5);
      expect(cfg.baseDelay).toBe(500);
      // defaults preserved
      expect(cfg.maxDelay).toBe(30000);
      expect(cfg.backoffMultiplier).toBe(2);
      expect(cfg.jitterPercent).toBe(0.1);
    });

    it('should allow overriding all retry config fields', () => {
      const full: RetryConfig = {
        maxRetries: 1,
        baseDelay: 100,
        maxDelay: 5000,
        backoffMultiplier: 3,
        jitterPercent: 0.25,
      };
      const custom = new TestableModelClient(full);
      expect(custom.getRetryConfig()).toEqual(full);
    });
  });

  // =========================================================================
  // setModelConfig / getModelContextWindow
  // =========================================================================
  describe('setModelConfig / getModelContextWindow', () => {
    it('should return undefined when no model config is set', () => {
      expect(client.getModelContextWindow()).toBeUndefined();
    });

    it('should return contextWindow from model config when set', () => {
      client.setModelConfig({ contextWindow: 128000 } as IModelConfig);
      expect(client.getModelContextWindow()).toBe(128000);
    });

    it('should return undefined after setting config to undefined', () => {
      client.setModelConfig({ contextWindow: 4096 } as IModelConfig);
      client.setModelConfig(undefined);
      expect(client.getModelContextWindow()).toBeUndefined();
    });

    it('should reflect the latest config after multiple updates', () => {
      client.setModelConfig({ contextWindow: 4096 } as IModelConfig);
      expect(client.getModelContextWindow()).toBe(4096);
      client.setModelConfig({ contextWindow: 128000 } as IModelConfig);
      expect(client.getModelContextWindow()).toBe(128000);
    });
  });

  // =========================================================================
  // validateRequest
  // =========================================================================
  describe('validateRequest', () => {
    it('should accept a minimal valid request', () => {
      expect(() => client.callValidateRequest(validRequest())).not.toThrow();
    });

    it('should throw when model is empty string', () => {
      expect(() => client.callValidateRequest(validRequest({ model: '' }))).toThrow(
        ModelClientError,
      );
    });

    it('should throw when model is whitespace-only', () => {
      expect(() => client.callValidateRequest(validRequest({ model: '   ' }))).toThrow(
        ModelClientError,
      );
    });

    it('should throw when messages array is empty', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ messages: [] })),
      ).toThrow(ModelClientError);
    });

    it('should throw when messages is undefined', () => {
      expect(() =>
        client.callValidateRequest({ model: 'gpt-4', messages: undefined as any }),
      ).toThrow(ModelClientError);
    });

    it('should throw for temperature < 0', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ temperature: -0.1 })),
      ).toThrow(ModelClientError);
    });

    it('should throw for temperature > 2', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ temperature: 2.1 })),
      ).toThrow(ModelClientError);
    });

    it('should accept temperature = 0', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ temperature: 0 })),
      ).not.toThrow();
    });

    it('should accept temperature = 2', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ temperature: 2 })),
      ).not.toThrow();
    });

    it('should accept undefined temperature', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ temperature: undefined })),
      ).not.toThrow();
    });

    it('should throw for maxTokens = 0', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ maxTokens: 0 })),
      ).toThrow(ModelClientError);
    });

    it('should throw for negative maxTokens', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ maxTokens: -10 })),
      ).toThrow(ModelClientError);
    });

    it('should accept positive maxTokens', () => {
      expect(() =>
        client.callValidateRequest(validRequest({ maxTokens: 100 })),
      ).not.toThrow();
    });

    it('should throw for an invalid message role', () => {
      expect(() =>
        client.callValidateRequest(
          validRequest({ messages: [{ role: 'invalid' as any, content: 'hi' }] }),
        ),
      ).toThrow(ModelClientError);
    });

    it('should accept all valid roles', () => {
      const roles: Array<'system' | 'user' | 'assistant' | 'tool'> = [
        'system',
        'user',
        'assistant',
        'tool',
      ];
      roles.forEach((role) => {
        const msgs =
          role === 'tool'
            ? [{ role, content: 'result', toolCallId: 'call_1' }]
            : [{ role, content: 'hi' }];
        expect(() =>
          client.callValidateRequest(validRequest({ messages: msgs as any })),
        ).not.toThrow();
      });
    });

    it('should throw when a tool message has no toolCallId', () => {
      expect(() =>
        client.callValidateRequest(
          validRequest({ messages: [{ role: 'tool', content: 'result' }] }),
        ),
      ).toThrow(ModelClientError);
    });

    it('should accept a tool message with toolCallId', () => {
      expect(() =>
        client.callValidateRequest(
          validRequest({
            messages: [{ role: 'tool', content: 'result', toolCallId: 'call_123' }],
          }),
        ),
      ).not.toThrow();
    });

    it('should validate every message in the array', () => {
      // first message valid, second invalid
      expect(() =>
        client.callValidateRequest(
          validRequest({
            messages: [
              { role: 'user', content: 'hello' },
              { role: 'tool', content: 'no id' }, // missing toolCallId
            ],
          }),
        ),
      ).toThrow(ModelClientError);
    });

    it('should throw a ModelClientError with descriptive message for missing model', () => {
      try {
        client.callValidateRequest(validRequest({ model: '' }));
        expect.fail('should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(ModelClientError);
        expect(e.message).toBe('Model is required');
      }
    });
  });

  // =========================================================================
  // calculateBackoff
  // =========================================================================
  describe('calculateBackoff', () => {
    it('should return baseDelay (plus jitter) for attempt 0', () => {
      const delay = client.callCalculateBackoff(0);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1100); // 1000 + 10% jitter
    });

    it('should double delay on each attempt (exponential)', () => {
      // Attempt 1: 2000 + jitter
      const d1 = client.callCalculateBackoff(1);
      expect(d1).toBeGreaterThanOrEqual(2000);
      expect(d1).toBeLessThanOrEqual(2200);

      // Attempt 2: 4000 + jitter
      const d2 = client.callCalculateBackoff(2);
      expect(d2).toBeGreaterThanOrEqual(4000);
      expect(d2).toBeLessThanOrEqual(4400);
    });

    it('should cap delay at maxDelay', () => {
      // Attempt 20 would produce an astronomically large base, but should be capped
      const delay = client.callCalculateBackoff(20);
      expect(delay).toBeLessThanOrEqual(33000); // 30000 + 10% jitter
      expect(delay).toBeGreaterThanOrEqual(30000);
    });

    it('should use retryAfter when provided instead of exponential', () => {
      const delay = client.callCalculateBackoff(5, 2000);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2200); // 2000 + 10% jitter
    });

    it('should handle retryAfter = 0', () => {
      const delay = client.callCalculateBackoff(3, 0);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(100);
    });

    it('should add jitter that varies across calls', () => {
      const delays = Array.from({ length: 50 }, () => client.callCalculateBackoff(1));
      const unique = new Set(delays);
      expect(unique.size).toBeGreaterThan(1);
    });

    it('should respect a custom jitterPercent', () => {
      const noJitter = new TestableModelClient({ jitterPercent: 0 });
      const delays = Array.from({ length: 20 }, () => noJitter.callCalculateBackoff(1));
      // With 0% jitter all delays should be exactly the same
      const unique = new Set(delays);
      expect(unique.size).toBe(1);
      expect(delays[0]).toBe(2000); // baseDelay * 2^1
    });

    it('should respect a custom backoffMultiplier', () => {
      const tripler = new TestableModelClient({ backoffMultiplier: 3, jitterPercent: 0 });
      expect(tripler.callCalculateBackoff(0)).toBe(1000); // 1000 * 3^0
      expect(tripler.callCalculateBackoff(1)).toBe(3000); // 1000 * 3^1
      expect(tripler.callCalculateBackoff(2)).toBe(9000); // 1000 * 3^2
    });
  });

  // =========================================================================
  // isRetryableHttpError
  // =========================================================================
  describe('isRetryableHttpError', () => {
    it.each([429, 408, 500, 502, 503, 504])(
      'should return true for status %i',
      (code) => {
        expect(client.callIsRetryableHttpError(code)).toBe(true);
      },
    );

    it.each([200, 201, 400, 401, 403, 404, 422])(
      'should return false for status %i',
      (code) => {
        expect(client.callIsRetryableHttpError(code)).toBe(false);
      },
    );
  });

  // =========================================================================
  // isRetryableError
  // =========================================================================
  describe('isRetryableError', () => {
    it('should return true for ModelClientError with retryable = true', () => {
      const err = new ModelClientError('fail', 500, 'test', true);
      expect(client.callIsRetryableError(err)).toBe(true);
    });

    it('should return false for ModelClientError with retryable = false', () => {
      const err = new ModelClientError('fail', 400, 'test', false);
      expect(client.callIsRetryableError(err)).toBe(false);
    });

    it('should return true for error with status 500', () => {
      expect(client.callIsRetryableError({ status: 500 })).toBe(true);
    });

    it('should return true for error with statusCode 429', () => {
      expect(client.callIsRetryableError({ statusCode: 429 })).toBe(true);
    });

    it('should return true for error with statusCode 408', () => {
      expect(client.callIsRetryableError({ statusCode: 408 })).toBe(true);
    });

    it('should return false for error with status 400', () => {
      expect(client.callIsRetryableError({ status: 400 })).toBe(false);
    });

    it('should return true for ENOTFOUND network error', () => {
      expect(client.callIsRetryableError({ code: 'ENOTFOUND' })).toBe(true);
    });

    it('should return true for ECONNRESET network error', () => {
      expect(client.callIsRetryableError({ code: 'ECONNRESET' })).toBe(true);
    });

    it('should return true for ETIMEDOUT network error', () => {
      expect(client.callIsRetryableError({ code: 'ETIMEDOUT' })).toBe(true);
    });

    it('should return false for AbortError', () => {
      expect(client.callIsRetryableError({ name: 'AbortError' })).toBe(false);
    });

    it('should return false for a generic Error without special properties', () => {
      expect(client.callIsRetryableError(new Error('generic'))).toBe(false);
    });

    it('should return false for a plain object with no recognized properties', () => {
      expect(client.callIsRetryableError({ foo: 'bar' })).toBe(false);
    });

    it('should prefer ModelClientError.retryable over HTTP status code', () => {
      // A ModelClientError that says it is NOT retryable even though status is 500
      const err = new ModelClientError('conflict', 500, 'test', false);
      expect(client.callIsRetryableError(err)).toBe(false);
    });
  });

  // =========================================================================
  // withRetry
  // =========================================================================
  describe('withRetry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should return the result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const result = await client.callWithRetry(fn);
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry a retryable error and eventually succeed', async () => {
      const retryableErr = new ModelClientError('oops', 500, 'test', true);
      const fn = vi.fn()
        .mockRejectedValueOnce(retryableErr)
        .mockResolvedValueOnce('ok');

      const promise = client.callWithRetry(fn);
      await vi.advanceTimersToNextTimerAsync();

      const result = await promise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry a non-retryable error', async () => {
      const nonRetryable = new ModelClientError('auth', 401, 'test', false);
      const fn = vi.fn().mockRejectedValue(nonRetryable);

      await expect(client.callWithRetry(fn)).rejects.toThrow(ModelClientError);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw after maxRetries retryable failures', async () => {
      const retryableErr = new ModelClientError('fail', 503, 'test', true);
      const fn = vi.fn().mockRejectedValue(retryableErr);

      const promise = client.callWithRetry(fn);
      promise.catch(() => {});

      // advance through all 3 retry delays
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      await expect(promise).rejects.toThrow(ModelClientError);
      // 1 initial + 3 retries = 4 calls
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('should use retryAfter from the error when available', async () => {
      const err = new ModelClientError('rate limit', 429, 'test', true, 5000);
      const fn = vi.fn()
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce('done');

      const promise = client.callWithRetry(fn);

      // 4 seconds should not be enough
      await vi.advanceTimersByTimeAsync(4000);
      expect(fn).toHaveBeenCalledTimes(1);

      // 2 more seconds (total 6) should cover retryAfter + jitter
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;
      expect(result).toBe('done');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should accept a custom retryableErrors predicate', async () => {
      const customErr = new Error('custom');
      const fn = vi.fn()
        .mockRejectedValueOnce(customErr)
        .mockResolvedValueOnce('ok');

      // Custom predicate: always retry
      const promise = client.callWithRetry(fn, () => true);
      await vi.advanceTimersToNextTimerAsync();

      const result = await promise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry when custom predicate returns false', async () => {
      const err = new ModelClientError('retryable by default', 500, 'test', true);
      const fn = vi.fn().mockRejectedValue(err);

      // Custom predicate: never retry
      await expect(client.callWithRetry(fn, () => false)).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw the last error when all retries are exhausted', async () => {
      const errors = [
        new ModelClientError('err1', 500, 'test', true),
        new ModelClientError('err2', 502, 'test', true),
        new ModelClientError('err3', 503, 'test', true),
        new ModelClientError('err4', 504, 'test', true),
      ];
      const fn = vi.fn()
        .mockRejectedValueOnce(errors[0])
        .mockRejectedValueOnce(errors[1])
        .mockRejectedValueOnce(errors[2])
        .mockRejectedValueOnce(errors[3]);

      const promise = client.callWithRetry(fn);
      promise.catch(() => {});

      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersToNextTimerAsync();
      }

      try {
        await promise;
        expect.fail('should have thrown');
      } catch (e: any) {
        // Should throw the LAST error
        expect(e.message).toBe('err4');
      }
    });

    it('should work with maxRetries = 0 (no retries)', async () => {
      const noRetry = new TestableModelClient({ maxRetries: 0 });
      const fn = vi.fn().mockRejectedValue(new ModelClientError('fail', 500, 'test', true));

      await expect(noRetry.callWithRetry(fn)).rejects.toThrow('fail');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should delay between retries using calculateBackoff', async () => {
      const fastClient = new TestableModelClient({
        baseDelay: 100,
        backoffMultiplier: 2,
        jitterPercent: 0,
        maxRetries: 2,
      });

      const retryableErr = new ModelClientError('fail', 500, 'test', true);
      const fn = vi.fn()
        .mockRejectedValueOnce(retryableErr)
        .mockRejectedValueOnce(retryableErr)
        .mockResolvedValueOnce('done');

      const promise = fastClient.callWithRetry(fn);

      // First retry at 100ms
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(2);

      // Second retry at 200ms
      await vi.advanceTimersByTimeAsync(200);
      const result = await promise;
      expect(result).toBe('done');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // ModelClientError class
  // =========================================================================
  describe('ModelClientError', () => {
    it('should set name to ModelClientError', () => {
      const err = new ModelClientError('test');
      expect(err.name).toBe('ModelClientError');
    });

    it('should extend Error', () => {
      expect(new ModelClientError('msg')).toBeInstanceOf(Error);
    });

    it('should store statusCode, provider, retryable, retryAfter', () => {
      const err = new ModelClientError('msg', 429, 'openai', true, 3000);
      expect(err.statusCode).toBe(429);
      expect(err.provider).toBe('openai');
      expect(err.retryable).toBe(true);
      expect(err.retryAfter).toBe(3000);
    });

    it('should default retryable to false', () => {
      const err = new ModelClientError('msg');
      expect(err.retryable).toBe(false);
    });

    it('should default statusCode and provider to undefined', () => {
      const err = new ModelClientError('msg');
      expect(err.statusCode).toBeUndefined();
      expect(err.provider).toBeUndefined();
    });

    it('should have a stack trace', () => {
      const err = new ModelClientError('msg');
      expect(err.stack).toBeDefined();
      expect(typeof err.stack).toBe('string');
    });
  });
});
