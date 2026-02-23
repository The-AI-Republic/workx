import { describe, it, expect, vi } from 'vitest';

vi.mock('../constants', () => ({
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

import { SummaryGenerator } from '../SummaryGenerator';

function userMessage(text: string) {
  return {
    type: 'message' as const,
    role: 'user' as const,
    content: [{ type: 'input_text' as const, text }],
  };
}

function assistantMessage(text: string) {
  return {
    type: 'message' as const,
    role: 'assistant' as const,
    content: [{ type: 'output_text' as const, text }],
  };
}

describe('SummaryGenerator', () => {
  const generator = new SummaryGenerator();

  describe('collectUserMessages', () => {
    it('extracts text from user messages', () => {
      const history = [
        userMessage('Hello'),
        userMessage('How are you?'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Hello', 'How are you?']);
    });

    it('skips non-user messages (assistant)', () => {
      const history = [
        userMessage('Hello'),
        assistantMessage('Hi there!'),
        userMessage('Thanks'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Hello', 'Thanks']);
    });

    it('skips summary messages starting with SUMMARY_PREFIX', () => {
      const history = [
        userMessage('[CONVERSATION SUMMARY]\nPrevious context here'),
        userMessage('What is the weather?'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['What is the weather?']);
    });

    it('skips system context messages containing <user_instructions>', () => {
      const history = [
        userMessage('<user_instructions>Be helpful</user_instructions>'),
        userMessage('Real user question'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Real user question']);
    });

    it('skips system context messages containing <environment_context>', () => {
      const history = [
        userMessage('<environment_context>prod</environment_context>'),
        userMessage('Actual question'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Actual question']);
    });

    it('skips system context messages containing # AGENTS.md instructions', () => {
      const history = [
        userMessage('# AGENTS.md instructions\nFollow these rules'),
        userMessage('My real message'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['My real message']);
    });

    it('skips system context messages containing <INSTRUCTIONS>', () => {
      const history = [
        userMessage('<INSTRUCTIONS>Do something</INSTRUCTIONS>'),
        userMessage('User message'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['User message']);
    });

    it('skips system context messages containing <ENVIRONMENT_CONTEXT>', () => {
      const history = [
        userMessage('<ENVIRONMENT_CONTEXT>info</ENVIRONMENT_CONTEXT>'),
        userMessage('Normal message'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Normal message']);
    });

    it('returns empty array for empty history', () => {
      const result = generator.collectUserMessages([]);

      expect(result).toEqual([]);
    });

    it('skips items that lack content array', () => {
      const history = [
        { type: 'message', role: 'user' },
        userMessage('Valid message'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Valid message']);
    });

    it('skips content items without text', () => {
      const history = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'image_url', url: 'http://example.com/img.png' }],
        },
        userMessage('Text message'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['Text message']);
    });

    it('handles mixed history with all message types', () => {
      const history = [
        userMessage('[CONVERSATION SUMMARY]\nOld summary'),
        assistantMessage('Acknowledged'),
        userMessage('<user_instructions>Be concise</user_instructions>'),
        userMessage('First real question'),
        assistantMessage('Answer to first'),
        userMessage('Second real question'),
      ];

      const result = generator.collectUserMessages(history as any);

      expect(result).toEqual(['First real question', 'Second real question']);
    });
  });

  describe('formatSummaryWithPrefix', () => {
    it('prepends SUMMARY_PREFIX to the summary text', () => {
      const result = generator.formatSummaryWithPrefix('User asked about weather.');

      expect(result).toBe('[CONVERSATION SUMMARY]\nUser asked about weather.');
    });

    it('uses NO_SUMMARY_PLACEHOLDER for empty text', () => {
      const result = generator.formatSummaryWithPrefix('');

      expect(result).toBe('[CONVERSATION SUMMARY]\n(no summary available)');
    });

    it('uses NO_SUMMARY_PLACEHOLDER for whitespace-only text', () => {
      const result = generator.formatSummaryWithPrefix('   \n\t  ');

      expect(result).toBe('[CONVERSATION SUMMARY]\n(no summary available)');
    });

    it('preserves multiline summary text', () => {
      const summary = 'Line one.\nLine two.\nLine three.';
      const result = generator.formatSummaryWithPrefix(summary);

      expect(result).toBe('[CONVERSATION SUMMARY]\nLine one.\nLine two.\nLine three.');
    });
  });

  describe('isSummaryMessage', () => {
    it('returns true when text starts with SUMMARY_PREFIX', () => {
      expect(generator.isSummaryMessage('[CONVERSATION SUMMARY]\nSome summary')).toBe(true);
    });

    it('returns true when text is exactly SUMMARY_PREFIX', () => {
      expect(generator.isSummaryMessage('[CONVERSATION SUMMARY]')).toBe(true);
    });

    it('returns false for normal text', () => {
      expect(generator.isSummaryMessage('Hello, world!')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(generator.isSummaryMessage('')).toBe(false);
    });

    it('returns false when prefix appears mid-text', () => {
      expect(
        generator.isSummaryMessage('Some text [CONVERSATION SUMMARY] more text')
      ).toBe(false);
    });
  });
});
