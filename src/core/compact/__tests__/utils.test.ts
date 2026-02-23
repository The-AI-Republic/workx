import { describe, it, expect, vi } from 'vitest';
import type { ResponseItem } from '../../protocol/types';

// Mock constants to avoid ?raw import issues with .md files
vi.mock('../constants', () => ({
  SUMMARIZATION_PROMPT: 'Summarize the conversation.',
  SUMMARY_PREFIX: '[CONVERSATION SUMMARY]',
  NO_SUMMARY_PLACEHOLDER: '(no summary available)',
  TRUNCATION_MARKER: '\n[...tokens truncated]',
  DEFAULT_COMPACTION_CONFIG: {
    triggerThreshold: 0.85,
    userMessageBudget: 20000,
    maxRetries: 3,
    baseBackoffMs: 100,
  },
}));

import { estimateRequestTokens } from '../utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createUserMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

function createAssistantMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

// ---------------------------------------------------------------------------
// Tests: estimateRequestTokens
// ---------------------------------------------------------------------------

describe('estimateRequestTokens', () => {
  it('returns 0 for empty items', () => {
    expect(estimateRequestTokens([])).toBe(0);
  });

  it('estimates single user message correctly', () => {
    const text = 'Hello world'; // 11 chars => ceil(11/4) = 3
    const items = [createUserMessage(text)];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(text.length / 4));
  });

  it('estimates single assistant message correctly', () => {
    const text = 'This is a response from the assistant.'; // 38 chars => ceil(38/4) = 10
    const items = [createAssistantMessage(text)];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(text.length / 4));
  });

  it('sums multiple messages correctly', () => {
    const text1 = 'Hello world'; // 11 chars
    const text2 = 'How are you doing today?'; // 24 chars
    const items = [createUserMessage(text1), createAssistantMessage(text2)];
    const expected = Math.ceil((text1.length + text2.length) / 4);
    expect(estimateRequestTokens(items)).toBe(expected);
  });

  it('adds instructionsLength tokens', () => {
    const items = [createUserMessage('Hi')]; // 2 chars => ceil(2/4) = 1
    const instructionsLength = 400; // ceil(400/4) = 100
    const result = estimateRequestTokens(items, instructionsLength);
    expect(result).toBe(Math.ceil(2 / 4) + Math.ceil(400 / 4));
  });

  it('adds toolCount overhead', () => {
    const items = [createUserMessage('Hi')]; // 2 chars => ceil(2/4) = 1
    const result = estimateRequestTokens(items, 0, 5);
    expect(result).toBe(Math.ceil(2 / 4) + 0 + 5 * 500);
  });

  it('combines all parameters correctly', () => {
    const text = 'a'.repeat(100); // 100 chars => ceil(100/4) = 25
    const items = [createUserMessage(text)];
    const instructionsLength = 200; // ceil(200/4) = 50
    const toolCount = 3; // 3 * 500 = 1500
    const result = estimateRequestTokens(items, instructionsLength, toolCount);
    expect(result).toBe(25 + 50 + 1500);
  });

  it('skips non-text content items', () => {
    const item: ResponseItem = {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,...' } as any,
        { type: 'input_text', text: 'Describe this image' },
      ],
    };
    // Only counts the text: 19 chars => ceil(19/4) = 5
    expect(estimateRequestTokens([item])).toBe(Math.ceil(19 / 4));
  });

  it('counts reasoning item summary text', () => {
    const summaryText = 'thinking about it'; // 17 chars => ceil(17/4) = 5
    const items: ResponseItem[] = [
      {
        type: 'reasoning',
        id: 'r1',
        summary: [{ type: 'summary_text', text: summaryText }],
      },
      createUserMessage('Hello'), // 5 chars => ceil(5/4) = 2
    ];
    // All chars summed then divided: ceil((17 + 5) / 4) = 6
    expect(estimateRequestTokens(items)).toBe(Math.ceil((summaryText.length + 5) / 4));
  });

  it('counts function_call arguments', () => {
    const args = '{"query": "test search"}'; // 24 chars => ceil(24/4) = 6
    const items: ResponseItem[] = [
      {
        type: 'function_call',
        id: 'fc1',
        name: 'search',
        arguments: args,
        call_id: 'call_1',
      },
    ];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(args.length / 4));
  });

  it('counts function_call_output', () => {
    const output = 'Search results: found 5 items'; // 29 chars => ceil(29/4) = 8
    const items: ResponseItem[] = [
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output,
      },
    ];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(output.length / 4));
  });

  it('counts custom_tool_call input', () => {
    const input = '{"url": "https://example.com"}'; // 30 chars => ceil(30/4) = 8
    const items: ResponseItem[] = [
      {
        type: 'custom_tool_call',
        id: 'ct1',
        call_id: 'call_2',
        name: 'fetch',
        input,
      },
    ];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(input.length / 4));
  });

  it('counts custom_tool_call_output', () => {
    const output = 'Page content here'; // 17 chars => ceil(17/4) = 5
    const items: ResponseItem[] = [
      {
        type: 'custom_tool_call_output',
        call_id: 'call_2',
        output,
      },
    ];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(output.length / 4));
  });

  it('counts message tool_calls arguments', () => {
    const args1 = '{"a": 1}'; // 8 chars
    const args2 = '{"b": 2}'; // 8 chars
    const msgText = 'Let me help'; // 11 chars
    const items: ResponseItem[] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: msgText }],
        tool_calls: [
          { id: 'tc1', type: 'function', function: { name: 'fn1', arguments: args1 } },
          { id: 'tc2', type: 'function', function: { name: 'fn2', arguments: args2 } },
        ],
      },
    ];
    const expected = Math.ceil((msgText.length + args1.length + args2.length) / 4);
    expect(estimateRequestTokens(items)).toBe(expected);
  });

  it('counts message reasoning_content', () => {
    const reasoning = 'I need to think about this carefully'; // 36 chars
    const msgText = 'Here is my answer'; // 17 chars
    const items: ResponseItem[] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: msgText }],
        reasoning_content: reasoning,
      },
    ];
    const expected = Math.ceil((msgText.length + reasoning.length) / 4);
    expect(estimateRequestTokens(items)).toBe(expected);
  });

  it('skips web_search_call and other items', () => {
    const items: ResponseItem[] = [
      {
        type: 'web_search_call',
        id: 'ws1',
        action: { type: 'search', query: 'test' },
      } as ResponseItem,
      { type: 'other' } as ResponseItem,
      createUserMessage('Hello'), // 5 chars => ceil(5/4) = 2
    ];
    expect(estimateRequestTokens(items)).toBe(Math.ceil(5 / 4));
  });

  it('handles items with empty content array', () => {
    const item: ResponseItem = {
      type: 'message',
      role: 'user',
      content: [],
    };
    expect(estimateRequestTokens([item])).toBe(0);
  });

  it('handles legacy text type content', () => {
    const item: ResponseItem = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Legacy format response' }],
    };
    expect(estimateRequestTokens([item])).toBe(Math.ceil(22 / 4));
  });
});

// ---------------------------------------------------------------------------
// Tests: Accuracy validation (T010)
// ---------------------------------------------------------------------------

describe('estimateRequestTokens accuracy', () => {
  it('estimates 1000-character English text within 20% of expected ~250 tokens', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(23).trim(); // ~1035 chars
    const items = [createUserMessage(text)];
    const result = estimateRequestTokens(items);
    const expected = Math.ceil(text.length / 4);
    // Verify within 20% of the expected value
    expect(result).toBe(expected);
    // Also verify the estimate is reasonable (between 200 and 300 for ~1000 chars)
    expect(result).toBeGreaterThanOrEqual(200);
    expect(result).toBeLessThanOrEqual(300);
  });

  it('estimates 10000-character text within 20% of expected ~2500 tokens', () => {
    const text = 'a'.repeat(10000);
    const items = [createUserMessage(text)];
    const result = estimateRequestTokens(items);
    expect(result).toBe(2500);
    // Within 20%: 2000 to 3000
    expect(result).toBeGreaterThanOrEqual(2000);
    expect(result).toBeLessThanOrEqual(3000);
  });

  it('completes estimation for 100-item history in under 10ms', () => {
    const items: ResponseItem[] = [];
    for (let i = 0; i < 100; i++) {
      items.push(createUserMessage('This is a test message with some content for estimation. '.repeat(10)));
      items.push(createAssistantMessage('Here is a response from the assistant with relevant information. '.repeat(10)));
    }

    const start = performance.now();
    estimateRequestTokens(items);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
  });
});
