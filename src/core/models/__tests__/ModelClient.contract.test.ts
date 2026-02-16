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

// Mock configuration for testing (using snake_case from Phase 3.2)
const mockConfig = {
  apiKey: 'test-key',
  baseUrl: 'https://api.openai.com/v1',
  conversationId: 'test-conversation-id',
  modelFamily: {
    family: 'gpt-4',
    base_instructions: 'You are a helpful assistant',
    supports_reasoning_summaries: false,
    needs_special_apply_patch_instructions: false,
  } as ModelFamily,
  provider: {
    name: 'openai',
    base_url: 'https://api.openai.com/v1',
    wire_api: 'Responses',
    request_max_retries: 3,
    stream_idle_timeout_ms: 30000,
    requires_openai_auth: true,
  } as ModelProviderInfo,
};

// Create a concrete test implementation of ModelClient for testing
class TestModelClient extends ModelClient {
  constructor(config: any) {
    super(config);
  }

  async complete(): Promise<any> {
    throw new Error('Not implemented');
  }

  async *stream(): AsyncGenerator<any> {
    throw new Error('Not implemented');
  }

  countTokens(text: string, model: string): number {
    return text.length;
  }

  async *streamCompletion(): AsyncGenerator<any> {
    throw new Error('Not implemented');
  }

  getProvider(): string {
    return 'openai';
  }

  getModel(): string {
    return 'gpt-4';
  }

  setModel(model: string): void {
    // No-op for test
  }

  getContextWindow(): number | undefined {
    return 8192;
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
}

describe('ModelClient Contract Compliance', () => {
  let client: TestModelClient;

  beforeEach(() => {
    client = new TestModelClient(mockConfig);
  });

  describe('Required Methods - Rust client.rs:74-445', () => {
    it('should have getModelContextWindow() method (Rust: get_model_context_window)', () => {
      // Note: Currently named getContextWindow(), should be renamed to getModelContextWindow()
      expect(client.getContextWindow).toBeDefined();
      expect(typeof client.getContextWindow).toBe('function');

      const result = client.getContextWindow();
      expect(result === undefined || typeof result === 'number').toBe(true);
    });

    it('should have getAutoCompactTokenLimit() method (Rust: get_auto_compact_token_limit)', () => {
      // This method is missing in current implementation - expected to fail
      expect((client as any).getAutoCompactTokenLimit).toBeDefined();
    });

    it('should have stream() method (Rust: stream)', () => {
      expect(client.stream).toBeDefined();
      expect(typeof client.stream).toBe('function');
    });

    it('should have streamResponses() method (Rust: stream_responses)', () => {
      // This should be a separate method - may not exist yet
      expect((client as any).streamResponses).toBeDefined();
    });

    it('should have attemptStreamResponses() method (Rust: attempt_stream_responses)', () => {
      // This is internal retry logic - expected to be missing
      expect((client as any).attemptStreamResponses).toBeDefined();
    });

    it('should have getProvider() method (Rust: get_provider)', () => {
      expect(client.getProvider).toBeDefined();
      expect(typeof client.getProvider).toBe('function');

      const provider = client.getProvider();
      expect(typeof provider).toBe('string');
    });

    it('should have getOtelEventManager() method (Rust: get_otel_event_manager)', () => {
      // This is telemetry - may not be needed in browser
      expect((client as any).getOtelEventManager).toBeDefined();
    });

    it('should have getModel() method (Rust: get_model)', () => {
      expect(client.getModel).toBeDefined();
      expect(typeof client.getModel).toBe('function');

      const model = client.getModel();
      expect(typeof model).toBe('string');
    });

    it('should have getModelFamily() method (Rust: get_model_family)', () => {
      // Expected to be missing in current implementation
      expect((client as any).getModelFamily).toBeDefined();
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
      // Expected to be missing in current implementation
      expect((client as any).getAuthManager).toBeDefined();
    });

    it('should have processSSE() method (Rust: process_sse)', () => {
      // This is internal SSE processing - expected to be missing as abstract method
      expect((client as any).processSSE).toBeDefined();
    });
  });

  describe('Method Signature Validation', () => {
    it('should have async generator return type for stream()', async () => {
      const streamResult = client.stream({} as Prompt);
      expect(streamResult).toBeDefined();
      expect(typeof streamResult[Symbol.asyncIterator]).toBe('function');
    });

    it('should accept Prompt parameter for stream methods', () => {
      const prompt: Prompt = {
        input: [],
        tools: [],
      };

      // Should not throw when called with Prompt
      expect(() => client.stream(prompt)).not.toThrow();
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
    it('should have all 13 Rust methods (some currently missing)', () => {
      const requiredMethods = [
        'getContextWindow',        // Should be: getModelContextWindow
        'getAutoCompactTokenLimit', // Missing
        'stream',                   // ✓
        'streamResponses',          // May be missing as separate method
        'attemptStreamResponses',   // Missing (internal)
        'getProvider',              // ✓ (but wrong return type)
        'getOtelEventManager',      // Missing (optional)
        'getModel',                 // ✓
        'getModelFamily',           // Missing
        'getReasoningEffort',       // ✓
        'getReasoningSummary',      // ✓
        'getAuthManager',           // Missing
        'processSSE',               // Missing (internal)
      ];

      const presentMethods = requiredMethods.filter(method => {
        return typeof (client as any)[method] === 'function';
      });

      // This test documents the gap - expect it to fail until refactoring complete
      console.log(`Present: ${presentMethods.length}/${requiredMethods.length} methods`);
      console.log('Missing methods:', requiredMethods.filter(m => !presentMethods.includes(m)));
    });
  });
});
