/**
 * Edge Case Test: Invalid API Key
 *
 * Tests that authentication errors (401) throw immediately without retry
 *
 * **Quickstart Reference**: Edge Case 1
 * **Rust Reference**: pi-rs/core/src/client.rs Lines 245-264 (retry logic)
 * **Functional Requirement**: FR-033 (distinguish retryable from fatal errors)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import { ModelClientError } from '@/core/models/ModelClient';
import type { Prompt, ModelFamily, ModelProviderInfo } from '@/core/models/types';
import { ResponseStream } from '@/core/models/ResponseStream';

// Create a testable subclass to control SDK behavior
class TestableOpenAIResponsesClient extends OpenAIResponsesClient {
  public mockAttemptFn: ((attempt: number, payload: any) => Promise<ResponseStream>) | null = null;

  protected async attemptStreamResponses(attempt: number, payload: any): Promise<ResponseStream> {
    if (this.mockAttemptFn) {
      return this.mockAttemptFn(attempt, payload);
    }
    throw new Error('mockAttemptFn not set');
  }
}

function createModelFamily(): ModelFamily {
  return {
    family: 'gpt-4',
    base_instructions: '',
    supports_reasoning: false,
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
  };
}

function createProvider(overrides: Partial<ModelProviderInfo> = {}): ModelProviderInfo {
  return {
    name: 'openai',
    wire_api: 'Responses',
    requires_openai_auth: true,
    request_max_retries: 3,
    ...overrides,
  };
}

function createPrompt(): Prompt {
  return {
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Test message' }],
      } as any,
    ],
    tools: [],
  };
}

describe('Edge Case: Invalid API Key', () => {
  let attemptCount: number;

  beforeEach(() => {
    attemptCount = 0;
    vi.clearAllMocks();
  });

  it('should throw on 401 without retry (FR-033)', async () => {
    const client = new TestableOpenAIResponsesClient({
      apiKey: 'invalid-key',
      sessionId: 'test-conv-1',
      modelFamily: createModelFamily(),
      provider: createProvider(),
    });

    client.mockAttemptFn = async () => {
      attemptCount++;
      throw new ModelClientError(
        'Invalid API key provided',
        401,
        'openai',
        false
      );
    };

    // Execute & Verify
    await expect(client.stream(createPrompt())).rejects.toThrow(ModelClientError);

    // Verify fetch was called exactly once (no retries)
    expect(attemptCount).toBe(1);

    // Verify the error details
    try {
      attemptCount = 0;
      await client.stream(createPrompt());
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
    const client = new TestableOpenAIResponsesClient({
      apiKey: 'api-key-without-permissions',
      sessionId: 'test-conv-2',
      modelFamily: createModelFamily(),
      provider: createProvider(),
    });

    client.mockAttemptFn = async () => {
      attemptCount++;
      throw new ModelClientError(
        'Insufficient permissions',
        403,
        'openai',
        false
      );
    };

    // Execute & Verify
    await expect(client.stream(createPrompt())).rejects.toThrow();

    // Verify fetch was called exactly once (no retries on 4xx)
    expect(attemptCount).toBe(1);
  });

  it('makes a single attempt and propagates 429 (retry centralized in orchestrator)', async () => {
    // Track 12: the client no longer retries internally — the single retry
    // orchestrator at the TurnManager.runTurn boundary owns retry/backoff.
    // The client makes ONE attempt and propagates the 429 for the
    // orchestrator to classify and retry.
    const client = new TestableOpenAIResponsesClient({
      apiKey: 'valid-key',
      sessionId: 'test-conv-3',
      modelFamily: createModelFamily(),
      provider: createProvider(),
    });

    client.mockAttemptFn = async () => {
      attemptCount++;
      throw new ModelClientError('Rate limit exceeded', 429, 'openai', true, 0);
    };

    await expect(client.stream(createPrompt())).rejects.toThrow(
      'Rate limit exceeded'
    );
    expect(attemptCount).toBe(1);
  });

  it('should match quickstart edge case 1 example', async () => {
    const client = new TestableOpenAIResponsesClient({
      apiKey: 'invalid-key',
      sessionId: 'test-conv-4',
      modelFamily: createModelFamily(),
      provider: createProvider(),
    });

    client.mockAttemptFn = async () => {
      attemptCount++;
      throw new ModelClientError(
        'Incorrect API key provided',
        401,
        'openai',
        false
      );
    };

    // When: Streaming request
    try {
      const stream = await client.stream(createPrompt());
      for await (const event of stream) {
        // Should not reach here
      }
      expect.fail('Should have thrown');
    } catch (error) {
      // Then: Throws auth error immediately without retry
      expect(error).toBeInstanceOf(ModelClientError);
      if (error instanceof ModelClientError) {
        expect(error.statusCode).toBe(401);
      }
    }

    // Verify no retries
    expect(attemptCount).toBe(1);
  });
});
