/**
 * Unit tests for FactExtractor.
 *
 * Tests shouldExtract, preprocessForExtraction, extract (with mocked LLM),
 * and parseFacts edge cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FactExtractor, type ConversationMessage } from '../FactExtractor';
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLLM(response: string = '{"facts": []}') {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

function createExtractor(
  llmResponse: string = '{"facts": []}',
  configOverrides: Partial<MemoryConfig> = {}
) {
  const llm = createMockLLM(llmResponse);
  const config = { ...DEFAULT_MEMORY_CONFIG, ...configOverrides };
  const extractor = new FactExtractor(llm, config);
  return { extractor, llm };
}

function userMsg(content: string): ConversationMessage {
  return { role: 'user', content };
}

function assistantMsg(content: string): ConversationMessage {
  return { role: 'assistant', content };
}

// ---------------------------------------------------------------------------
// shouldExtract
// ---------------------------------------------------------------------------

describe('FactExtractor.shouldExtract', () => {
  const { extractor } = createExtractor();

  it('returns false when no messages', () => {
    expect(extractor.shouldExtract([])).toBe(false);
  });

  it('returns false when only system/tool messages', () => {
    const messages: ConversationMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'tool', content: 'tool output' },
    ];
    expect(extractor.shouldExtract(messages)).toBe(false);
  });

  it('returns false when user messages have less than 20 chars total', () => {
    expect(extractor.shouldExtract([userMsg('hi')])).toBe(false);
    expect(extractor.shouldExtract([userMsg('short')])).toBe(false);
  });

  it('returns true when user messages have 20+ chars', () => {
    expect(extractor.shouldExtract([userMsg('This is enough text!')])).toBe(true);
  });

  it('sums across multiple user messages', () => {
    const messages = [
      userMsg('Hello!'),    // 6 chars
      assistantMsg('Hi!'),  // not counted
      userMsg('World here!'), // 11 chars
      userMsg('More.'),       // 5 chars = total 22
    ];
    expect(extractor.shouldExtract(messages)).toBe(true);
  });

  it('handles null/undefined content gracefully', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: undefined as unknown as string },
      { role: 'user', content: null as unknown as string },
    ];
    expect(extractor.shouldExtract(messages)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// preprocessForExtraction
// ---------------------------------------------------------------------------

describe('FactExtractor.preprocessForExtraction', () => {
  const { extractor } = createExtractor();

  it('passes assistant messages through unchanged', () => {
    const msg = assistantMsg('I can help you!');
    const result = extractor.preprocessForExtraction([msg]);
    expect(result[0].content).toBe('I can help you!');
  });

  it('passes system messages through unchanged', () => {
    const msg: ConversationMessage = { role: 'system', content: 'System prompt' };
    const result = extractor.preprocessForExtraction([msg]);
    expect(result[0].content).toBe('System prompt');
  });

  it('strips large code blocks (500+ chars) from user messages', () => {
    const codeBlock = '```\n' + 'x'.repeat(600) + '\n```';
    const msg = userMsg(`Here's some code:\n${codeBlock}\nWhat do you think?`);
    const result = extractor.preprocessForExtraction([msg]);
    expect(result[0].content).toContain('[code block removed]');
    expect(result[0].content).not.toContain('x'.repeat(600));
  });

  it('keeps small code blocks intact', () => {
    const codeBlock = '```\nconsole.log("hi");\n```';
    const msg = userMsg(`Check this:\n${codeBlock}`);
    const result = extractor.preprocessForExtraction([msg]);
    expect(result[0].content).toContain('console.log("hi")');
  });

  it('truncates user messages longer than 2000 chars', () => {
    const longText = 'a'.repeat(3000);
    const msg = userMsg(longText);
    const result = extractor.preprocessForExtraction([msg]);
    expect(result[0].content.length).toBeLessThan(3000);
    expect(result[0].content).toContain('[...truncated for memory extraction]');
  });

  it('leaves user messages under 2000 chars unchanged (no code blocks)', () => {
    const text = 'My name is Alex and I work at Google.';
    const msg = userMsg(text);
    const result = extractor.preprocessForExtraction([msg]);
    expect(result[0].content).toBe(text);
  });

  it('does not mutate the original messages', () => {
    const original = userMsg('a'.repeat(3000));
    const originalContent = original.content;
    extractor.preprocessForExtraction([original]);
    expect(original.content).toBe(originalContent);
  });
});

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

describe('FactExtractor.extract', () => {
  it('returns empty array when shouldExtract is false', async () => {
    const { extractor, llm } = createExtractor();
    const result = await extractor.extract([userMsg('hi')]);
    expect(result).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('calls LLM and returns parsed facts', async () => {
    const response = '{"facts": ["User\'s name is Alex", "User works at Google"]}';
    const { extractor, llm } = createExtractor(response);

    const messages = [
      userMsg('My name is Alex and I work at Google.'),
    ];
    const result = await extractor.extract(messages);

    expect(llm.complete).toHaveBeenCalledOnce();
    expect(result).toEqual(["User's name is Alex", 'User works at Google']);
  });

  it('passes system prompt and conversation text to LLM', async () => {
    const { extractor, llm } = createExtractor('{"facts": ["Fact 1"]}');

    const messages = [
      userMsg('I like TypeScript for web development.'),
      assistantMsg('TypeScript is great!'),
    ];
    await extractor.extract(messages);

    const [systemPrompt, userPrompt] = llm.complete.mock.calls[0];
    expect(typeof systemPrompt).toBe('string');
    expect(userPrompt).toContain('User: I like TypeScript');
    expect(userPrompt).toContain('Assistant: TypeScript is great!');
  });

  it('filters out system and tool messages from conversation text', async () => {
    const { extractor, llm } = createExtractor('{"facts": []}');

    const messages: ConversationMessage[] = [
      { role: 'system', content: 'system prompt' },
      userMsg('I prefer dark mode for everything.'),
      { role: 'tool', content: 'tool output' },
      assistantMsg('Got it!'),
    ];
    await extractor.extract(messages);

    const [, userPrompt] = llm.complete.mock.calls[0];
    expect(userPrompt).not.toContain('system prompt');
    expect(userPrompt).not.toContain('tool output');
    expect(userPrompt).toContain('User: I prefer dark mode');
  });

  it('replaces {{currentDate}} in the system prompt', async () => {
    const { extractor, llm } = createExtractor('{"facts": []}');

    await extractor.extract([userMsg('This is a test message for extraction.')]);

    const [systemPrompt] = llm.complete.mock.calls[0];
    // Should not contain the placeholder
    expect(systemPrompt).not.toContain('{{currentDate}}');
  });

  it('uses custom extraction prompt when configured', async () => {
    const customPrompt = 'Custom prompt with {{currentDate}}';
    const { extractor, llm } = createExtractor('{"facts": ["custom fact"]}', {
      customExtractionPrompt: customPrompt,
    });

    await extractor.extract([userMsg('Test message with enough chars.')]);

    const [systemPrompt] = llm.complete.mock.calls[0];
    expect(systemPrompt).toContain('Custom prompt with');
  });

  it('returns empty array when LLM throws an error', async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new Error('API error')) };
    const extractor = new FactExtractor(llm, DEFAULT_MEMORY_CONFIG);

    const result = await extractor.extract([
      userMsg('My name is Alex and I live in Paris.'),
    ]);
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM returns non-JSON response', async () => {
    const { extractor } = createExtractor('No JSON here, just text.');

    const result = await extractor.extract([
      userMsg('This is a reasonable test message length.'),
    ]);
    expect(result).toEqual([]);
  });

  it('returns empty array when LLM returns JSON without facts key', async () => {
    const { extractor } = createExtractor('{"items": ["fact1"]}');

    const result = await extractor.extract([
      userMsg('This is a reasonable test message length.'),
    ]);
    expect(result).toEqual([]);
  });

  it('filters out non-string and empty facts', async () => {
    const response = '{"facts": ["Valid fact", "", 42, null, "Another valid"]}';
    const { extractor } = createExtractor(response);

    const result = await extractor.extract([
      userMsg('My name is Alex and I have some data.'),
    ]);
    expect(result).toEqual(['Valid fact', 'Another valid']);
  });

  it('extracts JSON from response with surrounding text', async () => {
    const response = 'Here are the facts:\n{"facts": ["Fact A"]}\nEnd.';
    const { extractor } = createExtractor(response);

    const result = await extractor.extract([
      userMsg('Tell me something about this text here.'),
    ]);
    expect(result).toEqual(['Fact A']);
  });
});
