import { describe, it, expect, vi } from 'vitest';

vi.mock('../../models/types/ResponseEvent', () => ({
  isOutputTextDelta: (event: any) => event.type === 'response.output_item.delta',
  isCompleted: (event: any) => event.type === 'response.completed',
}));

vi.mock('../constants', () => ({
  DEFAULT_TITLE_CONFIG: { maxRetries: 2, baseBackoffMs: 1, maxTitleLength: 60 },
  TITLE_GENERATION_PROMPT: 'Generate a title.',
  generatePlaceholderTitle: () => '02-16_12-00_chat',
}));

import { TitleGenerator } from '../TitleGenerator';

// --- Helpers ---

function createMockModelClient(titleText: string = 'Test Title') {
  return {
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_item.delta', delta: titleText };
        yield { type: 'response.completed' };
      },
    }),
  } as any;
}

function createUserMessage(text: string) {
  return {
    type: 'message' as const,
    role: 'user' as const,
    content: [{ type: 'input_text' as const, text }],
  };
}

function createAssistantMessage(text: string) {
  return {
    type: 'message' as const,
    role: 'assistant' as const,
    content: [{ type: 'output_text' as const, text }],
  };
}

// --- Tests ---

describe('TitleGenerator', () => {
  // -------------------------------------------------------
  // extractUserMessages
  // -------------------------------------------------------
  describe('extractUserMessages', () => {
    it('should extract text from user messages', () => {
      const generator = new TitleGenerator();
      const history = [
        createUserMessage('Hello'),
        createUserMessage('How are you?'),
        createUserMessage('What is the weather?'),
      ] as any[];

      const result = generator.extractUserMessages(history);

      expect(result).toEqual(['Hello', 'How are you?', 'What is the weather?']);
    });

    it('should respect the default maxMessages limit of 3', () => {
      const generator = new TitleGenerator();
      const history = [
        createUserMessage('First'),
        createUserMessage('Second'),
        createUserMessage('Third'),
        createUserMessage('Fourth'),
        createUserMessage('Fifth'),
      ] as any[];

      const result = generator.extractUserMessages(history);

      expect(result).toHaveLength(3);
      expect(result).toEqual(['First', 'Second', 'Third']);
    });

    it('should respect a custom maxMessages limit', () => {
      const generator = new TitleGenerator();
      const history = [
        createUserMessage('First'),
        createUserMessage('Second'),
        createUserMessage('Third'),
        createUserMessage('Fourth'),
      ] as any[];

      const result = generator.extractUserMessages(history, 2);

      expect(result).toHaveLength(2);
      expect(result).toEqual(['First', 'Second']);
    });

    it('should return empty array for empty history', () => {
      const generator = new TitleGenerator();

      const result = generator.extractUserMessages([]);

      expect(result).toEqual([]);
    });

    it('should skip non-user messages', () => {
      const generator = new TitleGenerator();
      const history = [
        createAssistantMessage('Hi there!'),
        createUserMessage('Hello'),
        createAssistantMessage('How can I help?'),
        createUserMessage('Tell me a joke'),
      ] as any[];

      const result = generator.extractUserMessages(history);

      expect(result).toEqual(['Hello', 'Tell me a joke']);
    });

    it('should handle messages with string content', () => {
      const generator = new TitleGenerator();
      const history = [
        { type: 'message', role: 'user', content: 'Plain string content' },
      ] as any[];

      const result = generator.extractUserMessages(history);

      expect(result).toEqual(['Plain string content']);
    });
  });

  // -------------------------------------------------------
  // countUserMessages
  // -------------------------------------------------------
  describe('countUserMessages', () => {
    it('should count user messages correctly', () => {
      const generator = new TitleGenerator();
      const history = [
        createUserMessage('Hello'),
        createAssistantMessage('Hi'),
        createUserMessage('Question'),
        createAssistantMessage('Answer'),
        createUserMessage('Follow-up'),
      ] as any[];

      expect(generator.countUserMessages(history)).toBe(3);
    });

    it('should return 0 for empty history', () => {
      const generator = new TitleGenerator();

      expect(generator.countUserMessages([])).toBe(0);
    });

    it('should return 0 when there are no user messages', () => {
      const generator = new TitleGenerator();
      const history = [
        createAssistantMessage('Hello'),
        createAssistantMessage('World'),
      ] as any[];

      expect(generator.countUserMessages(history)).toBe(0);
    });
  });

  // -------------------------------------------------------
  // generateTitle
  // -------------------------------------------------------
  describe('generateTitle', () => {
    it('should return a cleaned title on success', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('Test Title');

      const result = await generator.generateTitle(['Hello world'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Test Title');
      expect(result.error).toBeUndefined();
    });

    it('should remove "Title:" prefix from model response', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('Title: My Title');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('My Title');
    });

    it('should remove "title:" prefix from model response', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('title: My Title');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('My Title');
    });

    it('should remove "TITLE:" prefix from model response', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('TITLE: My Title');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('My Title');
    });

    it('should remove surrounding double quotes from model response', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('"My Title"');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('My Title');
    });

    it('should remove surrounding single quotes from model response', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient("'My Title'");

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('My Title');
    });

    it('should truncate long titles with "..."', async () => {
      const generator = new TitleGenerator();
      // maxTitleLength is 60 in the mock config
      const longTitle = 'A'.repeat(80);
      const mockClient = createMockModelClient(longTitle);

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('A'.repeat(57) + '...');
      expect(result.title!.length).toBe(60);
    });

    it('should not truncate titles at or under the max length', async () => {
      const generator = new TitleGenerator();
      const exactTitle = 'A'.repeat(60);
      const mockClient = createMockModelClient(exactTitle);

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe(exactTitle);
      expect(result.title!.length).toBe(60);
    });

    it('should return an error when no user messages are provided', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient();

      const result = await generator.generateTitle([], mockClient);

      expect(result.success).toBe(false);
      expect(result.error).toBe('No user messages provided');
      expect(result.title).toBeUndefined();
      expect(mockClient.stream).not.toHaveBeenCalled();
    });

    it('should retry on model failure and eventually return an error', async () => {
      const generator = new TitleGenerator();
      const mockClient = {
        stream: vi.fn().mockRejectedValue(new Error('Model unavailable')),
      } as any;

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Model unavailable');
      // Initial attempt + 2 retries = 3 total calls
      expect(mockClient.stream).toHaveBeenCalledTimes(3);
    });

    it('should succeed on retry after initial failure', async () => {
      const generator = new TitleGenerator();
      const mockClient = {
        stream: vi
          .fn()
          .mockRejectedValueOnce(new Error('Temporary error'))
          .mockResolvedValueOnce({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'Recovered Title' };
              yield { type: 'response.completed' };
            },
          }),
      } as any;

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Recovered Title');
      expect(mockClient.stream).toHaveBeenCalledTimes(2);
    });

    it('should return an error when the model returns an empty response', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Generated title is empty');
    });

    it('should return an error when the model returns only whitespace', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('   ');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Generated title is empty');
    });

    it('should pass user messages to the model client', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('Chat About Weather');

      await generator.generateTitle(['What is the weather?', 'In Paris?'], mockClient);

      expect(mockClient.stream).toHaveBeenCalledTimes(1);
      const callArgs = mockClient.stream.mock.calls[0][0];
      expect(callArgs.input).toBeDefined();
      expect(callArgs.tools).toEqual([]);
    });

    it('should respect custom maxRetries configuration', async () => {
      const generator = new TitleGenerator({ maxRetries: 0 });
      const mockClient = {
        stream: vi.fn().mockRejectedValue(new Error('Fail')),
      } as any;

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Fail');
      // maxRetries: 0 means only 1 attempt, no retries
      expect(mockClient.stream).toHaveBeenCalledTimes(1);
    });

    it('should handle both prefix and quotes together', async () => {
      const generator = new TitleGenerator();
      const mockClient = createMockModelClient('Title: "My Quoted Title"');

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('My Quoted Title');
    });

    it('should handle non-Error thrown values during retries', async () => {
      const generator = new TitleGenerator();
      const mockClient = {
        stream: vi.fn().mockRejectedValue('string error'),
      } as any;

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });

    it('should concatenate multiple text deltas from the stream', async () => {
      const generator = new TitleGenerator();
      const mockClient = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'response.output_item.delta', delta: 'Part ' };
            yield { type: 'response.output_item.delta', delta: 'One' };
            yield { type: 'response.completed' };
          },
        }),
      } as any;

      const result = await generator.generateTitle(['Hello'], mockClient);

      expect(result.success).toBe(true);
      expect(result.title).toBe('Part One');
    });
  });
});
