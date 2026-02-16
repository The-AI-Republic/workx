/**
 * Unit Tests: convertTokenUsage()
 *
 * Tests the TokenUsage conversion from API format to internal format
 * Rust Reference: browserx-rs/core/src/client.rs lines 525-540
 */

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesClient } from '@/core/models/client/OpenAIResponsesClient';
import type { ModelFamily, ModelProviderInfo } from '@/core/models/types/ResponsesAPI';
import type { ResponseCompletedUsage } from '@/core/models/types/ResponsesAPI';

describe('convertTokenUsage', () => {
  // Helper to create a test client
  const createTestClient = () => {
    const modelFamily: ModelFamily = {
      family: 'gpt-4',
      base_instructions: 'You are a helpful assistant.',
      supports_reasoning_summaries: false,
      needs_special_apply_patch_instructions: false,
    };

    const provider: ModelProviderInfo = {
      name: 'openai',
      base_url: 'https://api.openai.com/v1',
      wire_api: 'Responses',
      request_max_retries: 3,
    };

    return new OpenAIResponsesClient({
      apiKey: 'test-key',
      conversationId: 'test-conv',
      modelFamily,
      provider,
    });
  };

  describe('API Format to Internal Format', () => {
    it('should convert complete usage with all fields', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: {
          cached_tokens: 20,
        },
        output_tokens_details: {
          reasoning_tokens: 10,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage).toEqual({
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 50,
        reasoning_output_tokens: 10,
        total_tokens: 150,
      });
    });

    it('should handle missing input_tokens_details', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage).toEqual({
        input_tokens: 100,
        cached_input_tokens: 0, // Default to 0
        output_tokens: 50,
        reasoning_output_tokens: 0, // Default to 0
        total_tokens: 150,
      });
    });

    it('should handle missing output_tokens_details', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: {
          cached_tokens: 30,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage).toEqual({
        input_tokens: 100,
        cached_input_tokens: 30,
        output_tokens: 50,
        reasoning_output_tokens: 0, // Default to 0
        total_tokens: 150,
      });
    });

    it('should handle missing cached_tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: {
          // cached_tokens missing
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.cached_input_tokens).toBe(0);
    });

    it('should handle missing reasoning_tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        output_tokens_details: {
          // reasoning_tokens missing
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.reasoning_output_tokens).toBe(0);
    });
  });

  describe('With Optional Fields', () => {
    it('should convert usage with only cached tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 200,
        output_tokens: 75,
        total_tokens: 275,
        input_tokens_details: {
          cached_tokens: 50,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.input_tokens).toBe(200);
      expect(internalUsage.cached_input_tokens).toBe(50);
      expect(internalUsage.output_tokens).toBe(75);
      expect(internalUsage.reasoning_output_tokens).toBe(0);
      expect(internalUsage.total_tokens).toBe(275);
    });

    it('should convert usage with only reasoning tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 150,
        output_tokens: 100,
        total_tokens: 250,
        output_tokens_details: {
          reasoning_tokens: 25,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.input_tokens).toBe(150);
      expect(internalUsage.cached_input_tokens).toBe(0);
      expect(internalUsage.output_tokens).toBe(100);
      expect(internalUsage.reasoning_output_tokens).toBe(25);
      expect(internalUsage.total_tokens).toBe(250);
    });

    it('should convert minimal usage (no optional fields)', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 50,
        output_tokens: 25,
        total_tokens: 75,
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.input_tokens).toBe(50);
      expect(internalUsage.cached_input_tokens).toBe(0);
      expect(internalUsage.output_tokens).toBe(25);
      expect(internalUsage.reasoning_output_tokens).toBe(0);
      expect(internalUsage.total_tokens).toBe(75);
    });
  });

  describe('Edge Cases', () => {
    it('should handle zero tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage).toEqual({
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: 0,
      });
    });

    it('should handle large token counts', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 1000000,
        output_tokens: 500000,
        total_tokens: 1500000,
        input_tokens_details: {
          cached_tokens: 100000,
        },
        output_tokens_details: {
          reasoning_tokens: 50000,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.input_tokens).toBe(1000000);
      expect(internalUsage.cached_input_tokens).toBe(100000);
      expect(internalUsage.output_tokens).toBe(500000);
      expect(internalUsage.reasoning_output_tokens).toBe(50000);
      expect(internalUsage.total_tokens).toBe(1500000);
    });

    it('should handle all cached tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: {
          cached_tokens: 100, // All input tokens are cached
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.input_tokens).toBe(100);
      expect(internalUsage.cached_input_tokens).toBe(100);
    });

    it('should handle all reasoning tokens', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        output_tokens_details: {
          reasoning_tokens: 50, // All output tokens are reasoning
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.output_tokens).toBe(50);
      expect(internalUsage.reasoning_output_tokens).toBe(50);
    });
  });

  describe('Field Name Alignment', () => {
    it('should use snake_case for all fields (matching Rust serde)', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_tokens_details: {
          cached_tokens: 20,
        },
        output_tokens_details: {
          reasoning_tokens: 10,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      // Verify all field names are snake_case
      expect(internalUsage).toHaveProperty('input_tokens');
      expect(internalUsage).toHaveProperty('cached_input_tokens');
      expect(internalUsage).toHaveProperty('output_tokens');
      expect(internalUsage).toHaveProperty('reasoning_output_tokens');
      expect(internalUsage).toHaveProperty('total_tokens');

      // Verify no camelCase fields exist
      expect(internalUsage).not.toHaveProperty('inputTokens');
      expect(internalUsage).not.toHaveProperty('cachedInputTokens');
      expect(internalUsage).not.toHaveProperty('outputTokens');
      expect(internalUsage).not.toHaveProperty('reasoningOutputTokens');
      expect(internalUsage).not.toHaveProperty('totalTokens');
    });
  });

  describe('Realistic Scenarios', () => {
    it('should convert GPT-4 usage (no reasoning)', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 1500,
        output_tokens: 500,
        total_tokens: 2000,
        input_tokens_details: {
          cached_tokens: 200,
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.reasoning_output_tokens).toBe(0);
      expect(internalUsage.total_tokens).toBe(2000);
    });

    it('should convert o1 usage (with reasoning)', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 1000,
        output_tokens: 2000,
        total_tokens: 3000,
        output_tokens_details: {
          reasoning_tokens: 1500, // o1 models use reasoning tokens
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.reasoning_output_tokens).toBe(1500);
      expect(internalUsage.output_tokens).toBe(2000);
      expect(internalUsage.total_tokens).toBe(3000);
    });

    it('should convert fully cached request', () => {
      const client = createTestClient();

      const apiUsage: ResponseCompletedUsage = {
        input_tokens: 5000,
        output_tokens: 100,
        total_tokens: 5100,
        input_tokens_details: {
          cached_tokens: 5000, // Entire context cached
        },
      };

      const internalUsage = (client as any).convertTokenUsage(apiUsage);

      expect(internalUsage.cached_input_tokens).toBe(5000);
      expect(internalUsage.input_tokens).toBe(5000);
    });
  });
});
