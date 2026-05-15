// File: src/core/models/__tests__/parallelToolCalls.config.test.ts
//
// Track 11 — verifies the config-driven parallel_tool_calls flag flows
// from client config into the built request payload across every
// OpenAI-compatible client.

import { describe, it, expect, vi } from 'vitest';
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
    // The Chat Completions payload is assembled inside
    // makeChatCompletionsRequest and `parallel_tool_calls` is only set when
    // the prompt has tools (it's a no-op without tools). Capture the params
    // passed to the SDK to assert the real payload, not just the stored field.
    const promptWithTools = {
      input: [],
      tools: [
        {
          type: 'function',
          function: { name: 't', description: 'd', parameters: {} },
        },
      ],
    } as any;

    function chatClient(parallelToolCalls?: boolean) {
      const client = new OpenAIChatCompletionClient({
        apiKey: 'k',
        sessionId: 's',
        modelFamily,
        provider: { ...provider('moonshot'), wire_api: 'Chat' } as any,
        ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
      });
      const captured: any = {};
      (client as any).client = {
        chat: {
          completions: {
            create: vi.fn(async (params: any) => {
              captured.params = params;
              return [] as any;
            }),
          },
        },
      };
      return { client, captured };
    }

    it('emits parallel_tool_calls: false by default in the request payload', async () => {
      const { client, captured } = chatClient();
      await (client as any).makeChatCompletionsRequest(promptWithTools);
      expect(captured.params.parallel_tool_calls).toBe(false);
    });

    it('emits parallel_tool_calls: true in the request payload when configured', async () => {
      const { client, captured } = chatClient(true);
      await (client as any).makeChatCompletionsRequest(promptWithTools);
      expect(captured.params.parallel_tool_calls).toBe(true);
    });
  });
});
