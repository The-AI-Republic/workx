/**
 * Contract Test: ModelClient Interface Compliance
 *
 * This test validates that the TypeScript ModelClient implementation
 * matches the Rust ModelClient struct from browserx-rs/core/src/client.rs
 *
 * Rust Reference: browserx-rs/core/src/client.rs Lines 74-445
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ModelClient } from '@/core/models/ModelClient';
import type { Prompt } from '@/core/models/types/ResponsesAPI';
import type { ModelFamily, ModelProviderInfo } from '@/core/models/types/ResponsesAPI';
import type { ResponseEvent } from '@/core/models/types/ResponseEvent';
import type { RateLimitSnapshot } from '@/core/models/types/RateLimits';

// Mock configuration for testing (using snake_case from Phase 3.2)
const mockProvider: ModelProviderInfo = {
  name: 'openai',
  base_url: 'https://api.openai.com/v1',
  wire_api: 'Responses',
  request_max_retries: 3,
  stream_idle_timeout_ms: 30000,
  requires_openai_auth: true,
};

const mockModelFamily: ModelFamily = {
  family: 'gpt-4',
  base_instructions: 'You are a helpful assistant',
  supports_reasoning_summaries: false,
  needs_special_apply_patch_instructions: false,
};

// Create a concrete test implementation of ModelClient for testing
class TestModelClient extends ModelClient {
  constructor() {
    super();
  }

  async complete(): Promise<any> {
    throw new Error('Not implemented');
  }

  async stream(): Promise<any> {
    throw new Error('Not implemented');
  }

  countTokens(text: string, model: string): number {
    return text.length;
  }

  async *streamCompletion(): AsyncGenerator<any> {
    throw new Error('Not implemented');
  }

  getProvider(): ModelProviderInfo {
    return mockProvider;
  }

  getModel(): string {
    return 'gpt-4';
  }

  setModel(model: string): void {
    // No-op for test
  }

  getAutoCompactTokenLimit(): number | undefined {
    return 6400;
  }

  getModelFamily(): any {
    return mockModelFamily;
  }

  getAuthManager(): any {
    return undefined;
  }

  getReasoningEffort(): any {
    return undefined;
  }

  setReasoningEffort(effort: any): void {
    // No-op for test
  }

  getReasoningSummary(): any {
    return { type: 'auto' };
  }

  setReasoningSummary(summary: any): void {
    // No-op for test
  }

  protected async *streamResponses(request: any): AsyncGenerator<ResponseEvent> {
    throw new Error('Not implemented');
  }

  protected async *streamChat(request: any): AsyncGenerator<ResponseEvent> {
    throw new Error('Not implemented');
  }

  protected async *attemptStreamResponses(request: any, attempt: number): AsyncGenerator<ResponseEvent> {
    throw new Error('Not implemented');
  }

  protected async *processSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ResponseEvent> {
    yield { type: 'Created' } as ResponseEvent;
  }

  protected parseRateLimitSnapshot(headers?: Headers): RateLimitSnapshot | undefined {
    return undefined;
  }
}

describe('ModelClient Contract Compliance', () => {
  let client: TestModelClient;

  beforeEach(() => {
    client = new TestModelClient();
  });

  describe('Required Methods - Rust client.rs:74-445', () => {
    it('should have getModelContextWindow() method (Rust: get_model_context_window)', () => {
      expect(client.getModelContextWindow).toBeDefined();
      expect(typeof client.getModelContextWindow).toBe('function');

      const result = client.getModelContextWindow();
      expect(result === undefined || typeof result === 'number').toBe(true);
    });

    it('should have getAutoCompactTokenLimit() method (Rust: get_auto_compact_token_limit)', () => {
      expect(client.getAutoCompactTokenLimit).toBeDefined();
      expect(typeof client.getAutoCompactTokenLimit).toBe('function');

      const result = client.getAutoCompactTokenLimit();
      expect(result === undefined || typeof result === 'number').toBe(true);
    });

    it('should have stream() method (Rust: stream)', () => {
      expect(client.stream).toBeDefined();
      expect(typeof client.stream).toBe('function');
    });

    it('should have streamResponses() method (Rust: stream_responses)', () => {
      // Protected method - accessible via (client as any)
      expect((client as any).streamResponses).toBeDefined();
      expect(typeof (client as any).streamResponses).toBe('function');
    });

    it('should have attemptStreamResponses() method (Rust: attempt_stream_responses)', () => {
      // Protected method - accessible via (client as any)
      expect((client as any).attemptStreamResponses).toBeDefined();
      expect(typeof (client as any).attemptStreamResponses).toBe('function');
    });

    it('should have getProvider() method (Rust: get_provider)', () => {
      expect(client.getProvider).toBeDefined();
      expect(typeof client.getProvider).toBe('function');

      const provider = client.getProvider();
      // getProvider() returns ModelProviderInfo object, not a string
      expect(typeof provider).toBe('object');
      expect(typeof provider.name).toBe('string');
    });

    it('should have getModel() method (Rust: get_model)', () => {
      expect(client.getModel).toBeDefined();
      expect(typeof client.getModel).toBe('function');

      const model = client.getModel();
      expect(typeof model).toBe('string');
    });

    it('should have getModelFamily() method (Rust: get_model_family)', () => {
      expect(client.getModelFamily).toBeDefined();
      expect(typeof client.getModelFamily).toBe('function');
    });

    it('should have getReasoningEffort() method (Rust: get_reasoning_effort)', () => {
      expect(client.getReasoningEffort).toBeDefined();
      expect(typeof client.getReasoningEffort).toBe('function');
    });

    it('should have getReasoningSummary() method (Rust: get_reasoning_summary)', () => {
      expect(client.getReasoningSummary).toBeDefined();
      expect(typeof client.getReasoningSummary).toBe('function');
    });

    it('should have getAuthManager() method (Rust: get_auth_manager)', () => {
      expect(client.getAuthManager).toBeDefined();
      expect(typeof client.getAuthManager).toBe('function');
    });

    it('should have processSSE() method (Rust: process_sse)', () => {
      // Protected method - accessible via (client as any)
      expect((client as any).processSSE).toBeDefined();
      expect(typeof (client as any).processSSE).toBe('function');
    });
  });

  describe('Method Signature Validation', () => {
    it('should return ModelProviderInfo from getProvider()', () => {
      const provider = client.getProvider();
      expect(provider).toBeDefined();
      expect(provider.name).toBe('openai');
      expect(provider.base_url).toBe('https://api.openai.com/v1');
      expect(provider.wire_api).toBe('Responses');
    });

    it('should accept Prompt parameter for stream methods', () => {
      const prompt: Prompt = {
        input: [],
        tools: [],
      };

      // stream() is async and returns a Promise - verify it can be called
      // The promise will reject because this is a test stub, but calling it shouldn't throw synchronously
      const result = client.stream(prompt);
      expect(result).toBeInstanceOf(Promise);
      // Suppress the unhandled rejection from the test stub
      result.catch(() => {});
    });
  });

  describe('Browser-Specific Extensions', () => {
    it('should have countTokens() method (TS-specific, not in Rust)', () => {
      expect(client.countTokens).toBeDefined();
      expect(typeof client.countTokens).toBe('function');

      const count = client.countTokens('hello world', 'gpt-4');
      expect(typeof count).toBe('number');
    });

    it('should have setModel() method (TS-specific, not in Rust)', () => {
      expect(client.setModel).toBeDefined();
      expect(typeof client.setModel).toBe('function');
    });

    it('should have setReasoningEffort() method (TS-specific, not in Rust)', () => {
      expect(client.setReasoningEffort).toBeDefined();
      expect(typeof client.setReasoningEffort).toBe('function');
    });

    it('should have setReasoningSummary() method (TS-specific, not in Rust)', () => {
      expect(client.setReasoningSummary).toBeDefined();
      expect(typeof client.setReasoningSummary).toBe('function');
    });
  });

  describe('Contract Summary', () => {
    it('should have all required Rust methods', () => {
      const requiredMethods = [
        'getModelContextWindow',
        'getAutoCompactTokenLimit',
        'stream',
        'streamResponses',       // Protected
        'attemptStreamResponses', // Protected
        'getProvider',
        'getModel',
        'getModelFamily',
        'getReasoningEffort',
        'getReasoningSummary',
        'getAuthManager',
        'processSSE',            // Protected
      ];

      const presentMethods = requiredMethods.filter(method => {
        return typeof (client as any)[method] === 'function';
      });

      console.log(`Present: ${presentMethods.length}/${requiredMethods.length} methods`);

      // All required methods should be present
      expect(presentMethods.length).toBe(requiredMethods.length);

      const missingMethods = requiredMethods.filter(m => !presentMethods.includes(m));
      if (missingMethods.length > 0) {
        console.log('Missing methods:', missingMethods);
      }
    });
  });
});
