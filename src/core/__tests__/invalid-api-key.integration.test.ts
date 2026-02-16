/**
 * Edge Case Test: Invalid API Key
 *
 * Tests that authentication errors (401) throw immediately without retry
 *
 * **Quickstart Reference**: Edge Case 1
 * **Rust Reference**: browserx-rs/core/src/client.rs Lines 245-264 (retry logic)
 * **Functional Requirement**: FR-033 (distinguish retryable from fatal errors)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import { ModelClientError } from '@/core/models/ModelClient';
import type { Prompt, ModelFamily, ModelProviderInfo } from '@/core/models/types';

describe('Edge Case: Invalid API Key', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock global fetch
    mockFetch = vi.fn();
    global.fetch = mockFetch;
  });

  it('should throw on 401 without retry (FR-033)', async () => {
    // Setup: Mock 401 response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({
        'content-type': 'application/json',
      }),
      json: async () => ({
        error: {
          message: 'Invalid API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    });

    const client = new OpenAIResponsesClient({
      apiKey: 'invalid-key',
      modelFamily: {
        family: 'gpt-4',
        supports_reasoning_summaries: false,
        supports_extended_thinking: false,
      } as ModelFamily,
      provider: {
        name: 'openai',
        api_base_url: 'https://api.openai.com/v1',
        wire_api: 'Responses',
        requires_openai_auth: true,
        request_max_retries: 3,
      } as ModelProviderInfo,
    });

    const prompt: Prompt = {
      input: [
        {
          type: 'user_input',
          content: 'Test message',
        },
      ],
    };

    // Execute & Verify
    await expect(client.stream(prompt)).rejects.toThrow(ModelClientError);

    // Verify fetch was called exactly once (no retries)
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Verify the error details
    try {
      await client.stream(prompt);
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelClientError);
      if (error instanceof ModelClientError) {
        expect(error.statusCode).toBe(401);
        expect(error.retryable).toBe(false);
      }
    }
  });

  it('should not retry on 403 forbidden error', async () => {
    // Setup: Mock 403 response
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      headers: new Headers({
        'content-type': 'application/json',
      }),
      json: async () => ({
        error: {
          message: 'Insufficient permissions',
          type: 'invalid_request_error',
        },
      }),
    });

    const client = new OpenAIResponsesClient({
      apiKey: 'api-key-without-permissions',
      modelFamily: {
        family: 'gpt-4',
        supports_reasoning_summaries: false,
        supports_extended_thinking: false,
      } as ModelFamily,
      provider: {
        name: 'openai',
        api_base_url: 'https://api.openai.com/v1',
        wire_api: 'Responses',
        requires_openai_auth: true,
        request_max_retries: 3,
      } as ModelProviderInfo,
    });

    const prompt: Prompt = {
      input: [
        {
          type: 'user_input',
          content: 'Test message',
        },
      ],
    };

    // Execute & Verify
    await expect(client.stream(prompt)).rejects.toThrow();

    // Verify fetch was called exactly once (no retries on 4xx)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should retry on 429 rate limit error', async () => {
    // Setup: Mock 429 response followed by success
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        headers: new Headers({
          'content-type': 'application/json',
          'retry-after': '1',
        }),
        json: async () => ({
          error: {
            message: 'Rate limit exceeded',
            type: 'rate_limit_error',
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'text/event-stream',
        }),
        body: new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();
            controller.enqueue(
              encoder.encode('data: {"type":"response.created","response":{"id":"resp-1"}}\n\n')
            );
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
      });

    const client = new OpenAIResponsesClient({
      apiKey: 'valid-key',
      modelFamily: {
        family: 'gpt-4',
        supports_reasoning_summaries: false,
        supports_extended_thinking: false,
      } as ModelFamily,
      provider: {
        name: 'openai',
        api_base_url: 'https://api.openai.com/v1',
        wire_api: 'Responses',
        requires_openai_auth: true,
        request_max_retries: 3,
      } as ModelProviderInfo,
    });

    const prompt: Prompt = {
      input: [
        {
          type: 'user_input',
          content: 'Test message',
        },
      ],
    };

    // Execute
    const stream = await client.stream(prompt);

    // Verify fetch was called twice (initial + 1 retry)
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify stream works
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
  });

  it('should match quickstart edge case 1 example', async () => {
    // Quickstart Edge Case 1 verification
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      headers: new Headers({
        'content-type': 'application/json',
      }),
      json: async () => ({
        error: {
          message: 'Incorrect API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      }),
    });

    const client = new OpenAIResponsesClient({
      apiKey: 'invalid-key',
      modelFamily: {
        family: 'gpt-4',
        supports_reasoning_summaries: false,
        supports_extended_thinking: false,
      } as ModelFamily,
      provider: {
        name: 'openai',
        api_base_url: 'https://api.openai.com/v1',
        wire_api: 'Responses',
        requires_openai_auth: true,
        request_max_retries: 3,
      } as ModelProviderInfo,
    });

    const prompt: Prompt = {
      input: [
        {
          type: 'user_input',
          content: 'Test',
        },
      ],
    };

    // When: Streaming request
    try {
      const stream = await client.stream(prompt);
      for await (const event of stream) {
        // Should not reach here
      }
      expect.fail('Should have thrown');
    } catch (error) {
      // Then: Throws auth error immediately without retry
      expect(error).toBeInstanceOf(ModelClientError);
      if (error instanceof ModelClientError) {
        expect(error.statusCode).toBe(401);
        // ✅ PASS: No retry on auth error (FR-033)
      }
    }

    // Verify no retries
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
