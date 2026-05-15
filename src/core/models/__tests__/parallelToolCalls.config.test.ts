// File: src/core/models/__tests__/parallelToolCalls.config.test.ts
//
// Track 11 — verifies the config-driven parallel_tool_calls flag flows
// from client config into the built request payload across every
// OpenAI-compatible client.

import { describe, it, expect } from 'vitest';
import { OpenAIResponsesClient } from '../client/OpenAIResponsesClient';
import { OpenAIChatCompletionClient } from '../client/OpenAIChatCompletionClient';
import { GroqClient } from '../client/GroqClient';
import { FireworksClient } from '../client/FireworksClient';

const modelFamily = {
  family: 'test-model',
  base_instructions: 'You are a helpful assistant.',
  supports_reasoning: false,
  supports_reasoning_summaries: false,
  needs_special_apply_patch_instructions: false,
};

function provider(name: string) {
  return {
    name,
    base_url: 'https://example.com/v1',
    wire_api: 'Responses' as const,
    requires_openai_auth: false,
  };
}

const minimalPrompt = { input: [], tools: [] } as any;

async function payloadFor(client: any) {
  return client.buildRequestPayload(minimalPrompt);
}

describe('Track 11 — parallel_tool_calls config plumbing', () => {
  describe('OpenAIResponsesClient (OpenAI / xAI)', () => {
    it('emits parallel_tool_calls: false by default', async () => {
      const client = new OpenAIResponsesClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('openai') as any,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(false);
    });

    it('emits parallel_tool_calls: true when configured', async () => {
      const client = new OpenAIResponsesClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('openai') as any,
        parallelToolCalls: true,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(true);
    });

    it('emits parallel_tool_calls: true for xAI when configured', async () => {
      const client = new OpenAIResponsesClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('xai') as any,
        parallelToolCalls: true,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(true);
    });
  });

  describe('GroqClient', () => {
    it('defaults to false', async () => {
      const client = new GroqClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('groq') as any,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(false);
    });

    it('emits true when configured', async () => {
      const client = new GroqClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('groq') as any,
        parallelToolCalls: true,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(true);
    });
  });

  describe('FireworksClient', () => {
    it('defaults to false', async () => {
      const client = new FireworksClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('fireworks') as any,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(false);
    });

    it('emits true when configured (no allowlist gate)', async () => {
      const client = new FireworksClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: provider('fireworks') as any,
        parallelToolCalls: true,
      });
      const payload = await payloadFor(client);
      expect(payload.parallel_tool_calls).toBe(true);
    });
  });

  describe('OpenAIChatCompletionClient (Moonshot; base for Together/Fireworks Chat)', () => {
    it('stores the config-driven flag for the Chat Completions path', () => {
      const off = new OpenAIChatCompletionClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: { ...provider('moonshot'), wire_api: 'Chat' } as any,
      });
      const on = new OpenAIChatCompletionClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: { ...provider('moonshot'), wire_api: 'Chat' } as any,
        parallelToolCalls: true,
      });
      // The Chat Completions payload is assembled mid-stream; assert the
      // plumbed value the request builder reads (set via the parent
      // OpenAIResponsesClient constructor from config).
      expect((off as any).parallelToolCalls).toBe(false);
      expect((on as any).parallelToolCalls).toBe(true);
    });
  });
});
