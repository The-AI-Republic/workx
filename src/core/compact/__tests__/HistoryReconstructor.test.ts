import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ResponseItem } from '../../protocol/types';

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

import { HistoryReconstructor } from '../HistoryReconstructor';

// ---- helpers ----

function systemMsg(text: string): ResponseItem {
  return {
    type: 'message' as const,
    role: 'system',
    content: [{ type: 'input_text' as const, text }],
  } as ResponseItem;
}

function userMsg(text: string): ResponseItem {
  return {
    type: 'message' as const,
    role: 'user',
    content: [{ type: 'input_text' as const, text }],
  } as ResponseItem;
}

function assistantMsg(text: string): ResponseItem {
  return {
    type: 'message' as const,
    role: 'assistant',
    content: [{ type: 'output_text' as const, text }],
  } as ResponseItem;
}

// ---- tests ----

describe('HistoryReconstructor', () => {
  let reconstructor: HistoryReconstructor;

  beforeEach(() => {
    reconstructor = new HistoryReconstructor();
  });

  // ------------------------------------------------------------------
  // extractInitialContext
  // ------------------------------------------------------------------
  describe('extractInitialContext', () => {
    it('returns system messages at the start of history', () => {
      const history: ResponseItem[] = [
        systemMsg('You are a helpful assistant.'),
        systemMsg('Second system instruction.'),
        userMsg('Hello!'),
        assistantMsg('Hi there!'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(history[0]);
      expect(result[1]).toBe(history[1]);
    });

    it('includes user messages with <user_instructions> system context marker', () => {
      const history: ResponseItem[] = [
        systemMsg('System prompt'),
        userMsg('<user_instructions>do stuff</user_instructions>'),
        userMsg('Regular user message'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(2);
      expect(result[0]).toBe(history[0]);
      expect(result[1]).toBe(history[1]);
    });

    it('includes user messages with <environment_context> marker', () => {
      const history: ResponseItem[] = [
        userMsg('<environment_context>Linux x86_64</environment_context>'),
        userMsg('Hello'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(history[0]);
    });

    it('includes user messages with # AGENTS.md instructions marker', () => {
      const history: ResponseItem[] = [
        systemMsg('System prompt'),
        userMsg('# AGENTS.md instructions\nFollow these rules.'),
        userMsg('What is the weather?'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(2);
    });

    it('includes user messages with <INSTRUCTIONS> marker', () => {
      const history: ResponseItem[] = [
        userMsg('<INSTRUCTIONS>Some directives</INSTRUCTIONS>'),
        userMsg('Regular question'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(1);
    });

    it('includes user messages with <ENVIRONMENT_CONTEXT> marker', () => {
      const history: ResponseItem[] = [
        userMsg('<ENVIRONMENT_CONTEXT>context data</ENVIRONMENT_CONTEXT>'),
        userMsg('Hello'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(1);
    });

    it('stops at the first non-initial-context item', () => {
      const history: ResponseItem[] = [
        systemMsg('System prompt'),
        userMsg('<user_instructions>instructions</user_instructions>'),
        userMsg('Regular message'),  // <-- stops here
        systemMsg('Late system message'),
        userMsg('<user_instructions>more instructions</user_instructions>'),
      ];

      const result = reconstructor.extractInitialContext(history);

      // Only the first two items are initial context; the third is a regular
      // user message which breaks the sequence. Items after it are NOT included.
      expect(result).toHaveLength(2);
      expect(result[0]).toBe(history[0]);
      expect(result[1]).toBe(history[1]);
    });

    it('stops at an assistant message even if followed by system messages', () => {
      const history: ResponseItem[] = [
        systemMsg('System prompt'),
        assistantMsg('Hello, how can I help?'),
        systemMsg('Another system prompt'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toHaveLength(1);
      expect(result[0]).toBe(history[0]);
    });

    it('returns an empty array for empty history', () => {
      const result = reconstructor.extractInitialContext([]);

      expect(result).toEqual([]);
    });

    it('returns an empty array when history starts with a regular user message', () => {
      const history: ResponseItem[] = [
        userMsg('Hello!'),
        systemMsg('System prompt'),
      ];

      const result = reconstructor.extractInitialContext(history);

      expect(result).toEqual([]);
    });
  });

  // ------------------------------------------------------------------
  // selectUserMessages
  // ------------------------------------------------------------------
  describe('selectUserMessages', () => {
    it('returns all messages when they fit within budget', () => {
      const messages = ['Hello', 'World', 'Test'];

      const result = reconstructor.selectUserMessages(messages, {
        triggerThreshold: 0.85,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      expect(result.messages).toEqual(['Hello', 'World', 'Test']);
      expect(result.truncatedCount).toBe(0);
      expect(result.omittedCount).toBe(0);
      expect(result.totalTokens).toBeGreaterThan(0);
    });

    it('prioritizes most recent messages when budget is small', () => {
      // Create messages with enough text that only the last fits
      const longText = 'word '.repeat(200).trim(); // ~200 words => ~260 tokens
      const messages = [longText, longText, 'short recent'];

      const result = reconstructor.selectUserMessages(messages, {
        triggerThreshold: 0.85,
        userMessageBudget: 10, // very small budget
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      // Only the most recent message should be kept (possibly truncated)
      // Earlier messages should be omitted
      expect(result.messages.length).toBeGreaterThanOrEqual(1);
      expect(result.omittedCount).toBeGreaterThanOrEqual(1);
      // Most recent message ("short recent") should be preserved or truncated
      expect(result.messages[result.messages.length - 1]).toContain('short');
    });

    it('returns messages in chronological order even though selection is reverse', () => {
      const messages = ['first', 'second', 'third'];

      const result = reconstructor.selectUserMessages(messages, {
        triggerThreshold: 0.85,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      expect(result.messages).toEqual(['first', 'second', 'third']);
    });

    it('truncates a message that partially fits the budget', () => {
      // Create a message big enough that it exceeds a tight budget
      const longMessage = 'word '.repeat(500).trim(); // ~500 words => ~650 tokens
      const messages = [longMessage];

      const result = reconstructor.selectUserMessages(messages, {
        triggerThreshold: 0.85,
        userMessageBudget: 50, // tight budget forces truncation
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      expect(result.messages).toHaveLength(1);
      expect(result.truncatedCount).toBe(1);
      expect(result.omittedCount).toBe(0);
      // Truncated message should have truncation marker
      expect(result.messages[0]).toContain('[...tokens truncated]');
    });

    it('omits messages that cannot fit at all', () => {
      const longMessage = 'word '.repeat(500).trim();
      const messages = [longMessage, longMessage, 'recent short'];

      const result = reconstructor.selectUserMessages(messages, {
        triggerThreshold: 0.85,
        userMessageBudget: 10, // extremely tight
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      // With such a small budget, at least some messages are omitted
      expect(result.omittedCount).toBeGreaterThanOrEqual(1);
      // Truncated messages are still included in result.messages, so the invariant is:
      // selected count + omitted count = total input count
      expect(result.messages.length + result.omittedCount).toBe(messages.length);
    });

    it('uses DEFAULT_COMPACTION_CONFIG when no config is provided', () => {
      const messages = ['Hello', 'World'];

      const result = reconstructor.selectUserMessages(messages);

      // Should work with the default config (budget of 20000)
      expect(result.messages).toEqual(['Hello', 'World']);
      expect(result.truncatedCount).toBe(0);
      expect(result.omittedCount).toBe(0);
    });

    it('returns empty result for empty messages array', () => {
      const result = reconstructor.selectUserMessages([], {
        triggerThreshold: 0.85,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      expect(result.messages).toEqual([]);
      expect(result.totalTokens).toBe(0);
      expect(result.truncatedCount).toBe(0);
      expect(result.omittedCount).toBe(0);
    });

    it('tracks totalTokens accurately as budget minus remaining', () => {
      const messages = ['Hello world'];

      const result = reconstructor.selectUserMessages(messages, {
        triggerThreshold: 0.85,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });

      // totalTokens should equal the tokens consumed, which is > 0 for non-empty input
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.totalTokens).toBeLessThanOrEqual(20000);
    });
  });

  // ------------------------------------------------------------------
  // truncateMessage
  // ------------------------------------------------------------------
  describe('truncateMessage', () => {
    it('delegates to truncateText and returns truncated result', () => {
      const longMessage = 'word '.repeat(500).trim();

      const result = reconstructor.truncateMessage(longMessage, 20);

      // Should be shorter than the original
      expect(result.length).toBeLessThan(longMessage.length);
      expect(result).toContain('[...tokens truncated]');
    });

    it('returns original message if within token limit', () => {
      const shortMessage = 'Hello world';

      const result = reconstructor.truncateMessage(shortMessage, 20000);

      expect(result).toBe(shortMessage);
    });
  });

  // ------------------------------------------------------------------
  // buildHistory
  // ------------------------------------------------------------------
  describe('buildHistory', () => {
    it('creates correct CompactedHistory structure', () => {
      const initialContext: ResponseItem[] = [
        systemMsg('System prompt'),
        userMsg('<user_instructions>instructions</user_instructions>'),
      ];
      const userMessages = ['Hello', 'How are you?'];
      const summaryText = '[CONVERSATION SUMMARY] The user asked about the weather.';

      const result = reconstructor.buildHistory(initialContext, userMessages, summaryText);

      // initialContext should be passed through
      expect(result.initialContext).toBe(initialContext);

      // preservedUserMessages should be converted to ResponseItem format
      expect(result.preservedUserMessages).toHaveLength(2);
      expect(result.preservedUserMessages[0]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      });
      expect(result.preservedUserMessages[1]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'How are you?' }],
      });

      // summaryMessage should be a user-role ResponseItem
      expect(result.summaryMessage).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: summaryText }],
      });
    });

    it('handles empty user messages array', () => {
      const initialContext: ResponseItem[] = [systemMsg('System prompt')];
      const summaryText = '[CONVERSATION SUMMARY] No messages.';

      const result = reconstructor.buildHistory(initialContext, [], summaryText);

      expect(result.initialContext).toBe(initialContext);
      expect(result.preservedUserMessages).toEqual([]);
      expect(result.summaryMessage).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: summaryText }],
      });
    });

    it('handles empty initial context', () => {
      const userMessages = ['Hello'];
      const summaryText = '[CONVERSATION SUMMARY] Summary.';

      const result = reconstructor.buildHistory([], userMessages, summaryText);

      expect(result.initialContext).toEqual([]);
      expect(result.preservedUserMessages).toHaveLength(1);
      expect((result.summaryMessage as any).role).toBe('user');
    });
  });

  // ------------------------------------------------------------------
  // toResponseItems
  // ------------------------------------------------------------------
  describe('toResponseItems', () => {
    it('flattens CompactedHistory to [initialContext, preservedUserMessages, summaryMessage]', () => {
      const initialContext: ResponseItem[] = [
        systemMsg('System prompt'),
        userMsg('<user_instructions>instructions</user_instructions>'),
      ];

      const compacted = reconstructor.buildHistory(
        initialContext,
        ['Hello', 'World'],
        '[CONVERSATION SUMMARY] Summary here.'
      );

      const items = reconstructor.toResponseItems(compacted);

      // Total: 2 initial + 2 user + 1 summary = 5
      expect(items).toHaveLength(5);

      // Order: initial context first
      expect(items[0]).toBe(initialContext[0]);
      expect(items[1]).toBe(initialContext[1]);

      // Then preserved user messages
      expect(items[2]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }],
      });
      expect(items[3]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'World' }],
      });

      // Then summary message last
      expect(items[4]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[CONVERSATION SUMMARY] Summary here.' }],
      });
    });

    it('works with empty initial context and no user messages', () => {
      const compacted = reconstructor.buildHistory(
        [],
        [],
        '[CONVERSATION SUMMARY] Empty conversation.'
      );

      const items = reconstructor.toResponseItems(compacted);

      // Only the summary message
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '[CONVERSATION SUMMARY] Empty conversation.' }],
      });
    });

    it('returns items as a new flat array (not referencing compacted sub-arrays)', () => {
      const compacted = reconstructor.buildHistory(
        [systemMsg('System prompt')],
        ['Hello'],
        '[CONVERSATION SUMMARY] Summary.'
      );

      const items = reconstructor.toResponseItems(compacted);

      // The returned array is a new spread, so mutating it should not affect compacted
      expect(items).toHaveLength(3);
      items.pop();
      expect(compacted.initialContext).toHaveLength(1);
      expect(compacted.preservedUserMessages).toHaveLength(1);
    });
  });
});
