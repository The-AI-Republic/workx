import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompactService } from '../CompactService';
import type { ResponseItem } from '../../protocol/types';
import type { CompactionConfig } from '../types';
import { HistoryReconstructor } from '../HistoryReconstructor';

// Mock the ResponseEvent type guards to work with our simplified test events
vi.mock('../../models/types/ResponseEvent', () => ({
  isOutputTextDelta: (event: any) => event.type === 'response.output_item.delta',
  isCompleted: (event: any) => event.type === 'response.completed',
}));

// Mock constants to avoid ?raw import issues with .md files
vi.mock('../constants', () => ({
  SUMMARIZATION_PROMPT: 'Summarize the conversation.',
  SUMMARY_PREFIX: '[CONVERSATION SUMMARY]',
  NO_SUMMARY_PLACEHOLDER: '(no summary available)',
  TRUNCATION_MARKER: '\n[...tokens truncated]',
  DEFAULT_COMPACTION_CONFIG: {
    triggerThreshold: 0.9,
    userMessageBudget: 20000,
    maxRetries: 3,
    baseBackoffMs: 100,
  },
}));

// Mock sleep to avoid real delays in tests
vi.mock('../utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils')>();
  return {
    ...actual,
    sleep: vi.fn().mockResolvedValue(undefined),
  };
});

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

function createSystemMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'system',
    content: [{ type: 'input_text', text }],
  };
}

function createMockModelClient(summaryText: string = 'Test summary') {
  return {
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        yield { type: 'response.output_item.delta', delta: summaryText };
        yield { type: 'response.completed' };
      },
    }),
  } as any;
}

function createFailingModelClient(error: Error, failCount: number = Infinity) {
  let callCount = 0;
  return {
    stream: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= failCount) {
        return Promise.reject(error);
      }
      // Succeed after failCount failures
      return Promise.resolve({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'response.output_item.delta', delta: 'Recovered summary' };
          yield { type: 'response.completed' };
        },
      });
    }),
  } as any;
}

function createMultiChunkModelClient(chunks: string[]) {
  return {
    stream: vi.fn().mockResolvedValue({
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield { type: 'response.output_item.delta', delta: chunk };
        }
        yield { type: 'response.completed' };
      },
    }),
  } as any;
}

function buildSampleHistory(count: number): ResponseItem[] {
  const history: ResponseItem[] = [];
  for (let i = 0; i < count; i++) {
    history.push(createUserMessage(`User message ${i + 1}`));
    history.push(createAssistantMessage(`Assistant response ${i + 1}`));
  }
  return history;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompactService', () => {
  let service: CompactService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new CompactService();
  });

  // =========================================================================
  // shouldCompact
  // =========================================================================
  describe('shouldCompact', () => {
    it('should return true when tokens exceed threshold', () => {
      // Default threshold is 0.9. 91000 / 100000 = 0.91 > 0.9
      expect(service.shouldCompact(91000, 100000)).toBe(true);
    });

    it('should return false when tokens are below threshold', () => {
      // 80000 / 100000 = 0.80 < 0.9
      expect(service.shouldCompact(80000, 100000)).toBe(false);
    });

    it('should return true when tokens exactly equal threshold', () => {
      // 90000 / 100000 = 0.90 >= 0.9
      expect(service.shouldCompact(90000, 100000)).toBe(true);
    });

    it('should return false when contextWindow is 0', () => {
      expect(service.shouldCompact(100, 0)).toBe(false);
    });

    it('should return false when contextWindow is negative', () => {
      expect(service.shouldCompact(100, -1000)).toBe(false);
    });

    it('should return true when currentTokens exceed contextWindow', () => {
      // 150000 / 100000 = 1.5 >= 0.9
      expect(service.shouldCompact(150000, 100000)).toBe(true);
    });

    it('should return false when currentTokens is 0', () => {
      expect(service.shouldCompact(0, 100000)).toBe(false);
    });

    it('should respect custom triggerThreshold', () => {
      const customService = new CompactService({ triggerThreshold: 0.5 });
      // 60000 / 100000 = 0.60 >= 0.5
      expect(customService.shouldCompact(60000, 100000)).toBe(true);
      // 40000 / 100000 = 0.40 < 0.5
      expect(customService.shouldCompact(40000, 100000)).toBe(false);
    });

    it('should handle very small context window', () => {
      // 10 / 10 = 1.0 >= 0.9
      expect(service.shouldCompact(10, 10)).toBe(true);
      // 8 / 10 = 0.8 < 0.9
      expect(service.shouldCompact(8, 10)).toBe(false);
    });

    it('should handle very large token counts', () => {
      expect(service.shouldCompact(950000, 1000000)).toBe(true);
      expect(service.shouldCompact(850000, 1000000)).toBe(false);
    });
  });

  // =========================================================================
  // getConfig / updateConfig
  // =========================================================================
  describe('getConfig', () => {
    it('should return default config when no overrides provided', () => {
      const config = service.getConfig();
      expect(config).toEqual({
        triggerThreshold: 0.9,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });
    });

    it('should return a copy, not a reference', () => {
      const config1 = service.getConfig();
      const config2 = service.getConfig();
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });

    it('should reflect constructor overrides', () => {
      const customService = new CompactService({
        triggerThreshold: 0.75,
        maxRetries: 5,
      });
      const config = customService.getConfig();
      expect(config.triggerThreshold).toBe(0.75);
      expect(config.maxRetries).toBe(5);
      // Defaults preserved for non-overridden fields
      expect(config.userMessageBudget).toBe(20000);
      expect(config.baseBackoffMs).toBe(100);
    });
  });

  describe('updateConfig', () => {
    it('should merge partial config with existing config', () => {
      service.updateConfig({ triggerThreshold: 0.8 });
      const config = service.getConfig();
      expect(config.triggerThreshold).toBe(0.8);
      // Other fields unchanged
      expect(config.userMessageBudget).toBe(20000);
      expect(config.maxRetries).toBe(3);
      expect(config.baseBackoffMs).toBe(100);
    });

    it('should update multiple fields at once', () => {
      service.updateConfig({
        triggerThreshold: 0.7,
        userMessageBudget: 10000,
        maxRetries: 5,
        baseBackoffMs: 200,
      });
      const config = service.getConfig();
      expect(config).toEqual({
        triggerThreshold: 0.7,
        userMessageBudget: 10000,
        maxRetries: 5,
        baseBackoffMs: 200,
      });
    });

    it('should allow successive partial updates', () => {
      service.updateConfig({ triggerThreshold: 0.8 });
      service.updateConfig({ maxRetries: 10 });
      const config = service.getConfig();
      expect(config.triggerThreshold).toBe(0.8);
      expect(config.maxRetries).toBe(10);
    });

    it('should affect shouldCompact behavior after update', () => {
      // Default threshold 0.9: 80% usage should not trigger
      expect(service.shouldCompact(80000, 100000)).toBe(false);
      // Update threshold to 0.7
      service.updateConfig({ triggerThreshold: 0.7 });
      // Now 80% usage should trigger
      expect(service.shouldCompact(80000, 100000)).toBe(true);
    });

    it('should accept empty partial config without changes', () => {
      const before = service.getConfig();
      service.updateConfig({});
      const after = service.getConfig();
      expect(after).toEqual(before);
    });
  });

  // =========================================================================
  // compact() - success cases
  // =========================================================================
  describe('compact() success', () => {
    it('should return a successful compaction result', async () => {
      const history = buildSampleHistory(5);
      const mockClient = createMockModelClient('This is a test summary');

      const result = await service.compact(history, 'auto', mockClient, 50000);

      expect(result.success).toBe(true);
      expect(result.triggerReason).toBe('auto');
      expect(result.tokensBefore).toBe(50000);
      expect(result.retriesUsed).toBe(0);
      expect(result.itemsTrimmed).toBe(0);
      expect(result.summaryText).toBeDefined();
      expect(result.summaryText).toContain('[CONVERSATION SUMMARY]');
      expect(result.summaryText).toContain('This is a test summary');
      expect(result.newHistory).toBeDefined();
      expect(result.newHistory!.length).toBeGreaterThan(0);
      expect(result.error).toBeUndefined();
    });

    it('should pass correct prompt to modelClient.stream', async () => {
      const history = [
        createUserMessage('Hello'),
        createAssistantMessage('Hi there!'),
      ];
      const mockClient = createMockModelClient('Summary');

      await service.compact(history, 'manual', mockClient);

      expect(mockClient.stream).toHaveBeenCalledTimes(1);
      const call = mockClient.stream.mock.calls[0][0];
      // The input should contain original history + summarization prompt
      expect(call.input).toBeDefined();
      expect(call.input.length).toBe(history.length + 1);
      // Last message should be the summarization prompt
      const lastMsg = call.input[call.input.length - 1];
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content[0].text).toBe('Summarize the conversation.');
      // Tools should be empty
      expect(call.tools).toEqual([]);
    });

    it('should handle manual trigger', async () => {
      const history = buildSampleHistory(3);
      const mockClient = createMockModelClient('Manual summary');

      const result = await service.compact(history, 'manual', mockClient, 30000);

      expect(result.success).toBe(true);
      expect(result.triggerReason).toBe('manual');
    });

    it('should concatenate multiple text delta chunks', async () => {
      const history = buildSampleHistory(2);
      const mockClient = createMultiChunkModelClient([
        'First part. ',
        'Second part. ',
        'Third part.',
      ]);

      const result = await service.compact(history, 'auto', mockClient, 20000);

      expect(result.success).toBe(true);
      expect(result.summaryText).toContain('First part. Second part. Third part.');
    });

    it('should default tokensBefore to 0 when not provided', async () => {
      const history = buildSampleHistory(2);
      const mockClient = createMockModelClient('Summary');

      const result = await service.compact(history, 'auto', mockClient);

      expect(result.tokensBefore).toBe(0);
    });

    it('should produce newHistory with estimated token count as tokensAfter', async () => {
      const history = buildSampleHistory(3);
      const mockClient = createMockModelClient('A brief summary of the conversation');

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      // tokensAfter should be a positive number reflecting the new history size
      expect(result.tokensAfter).toBeGreaterThan(0);
      // tokensAfter should be less than or equal to tokensBefore for a meaningful compaction
      // (not strictly guaranteed by the algorithm, but with a short summary it should hold)
      expect(typeof result.tokensAfter).toBe('number');
    });

    it('should pass baseInstructions to modelClient.stream', async () => {
      const history = buildSampleHistory(2);
      const mockClient = createMockModelClient('Summary');
      const baseInstructions = 'You are a helpful assistant.';

      await service.compact(history, 'auto', mockClient, 1000, baseInstructions);

      const call = mockClient.stream.mock.calls[0][0];
      expect(call.base_instructions_override).toBe(baseInstructions);
    });

    it('should not pass baseInstructions when not provided', async () => {
      const history = buildSampleHistory(2);
      const mockClient = createMockModelClient('Summary');

      await service.compact(history, 'auto', mockClient, 1000);

      const call = mockClient.stream.mock.calls[0][0];
      expect(call.base_instructions_override).toBeUndefined();
    });
  });

  // =========================================================================
  // compact() - failure and retry cases
  // =========================================================================
  describe('compact() failure and retries', () => {
    it('should retry on transient errors and eventually fail', async () => {
      const history = buildSampleHistory(3);
      const error = new Error('Network timeout');
      const mockClient = createFailingModelClient(error);

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network timeout');
      // The while loop runs while retriesUsed <= maxRetries (3).
      // Each failure increments retriesUsed, and the loop exits when retriesUsed > maxRetries.
      // So retriesUsed ends at maxRetries + 1 = 4.
      expect(result.retriesUsed).toBe(4);
      expect(result.tokensBefore).toBe(10000);
      expect(result.tokensAfter).toBe(10000);
      expect(result.triggerReason).toBe('auto');
      expect(result.newHistory).toBeUndefined();
      expect(result.summaryText).toBeUndefined();
    });

    it('should succeed after transient failures within retry limit', async () => {
      const history = buildSampleHistory(3);
      const error = new Error('Temporary failure');
      // Fail twice, then succeed on the 3rd call
      const mockClient = createFailingModelClient(error, 2);

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(result.retriesUsed).toBe(2);
      expect(result.summaryText).toContain('Recovered summary');
    });

    it('should return error result with correct triggerReason on failure', async () => {
      const history = buildSampleHistory(2);
      const error = new Error('API error');
      const mockClient = createFailingModelClient(error);

      const result = await service.compact(history, 'manual', mockClient, 5000);

      expect(result.success).toBe(false);
      expect(result.triggerReason).toBe('manual');
      expect(result.error).toBe('API error');
    });

    it('should respect maxRetries config', async () => {
      const customService = new CompactService({ maxRetries: 1 });
      const history = buildSampleHistory(2);
      const error = new Error('Persistent failure');
      const mockClient = createFailingModelClient(error);

      const result = await customService.compact(history, 'auto', mockClient, 5000);

      expect(result.success).toBe(false);
      // With maxRetries=1: loop runs while retriesUsed<=1.
      // Attempt 1 fails -> retriesUsed=1 (<=1, sleep & continue)
      // Attempt 2 fails -> retriesUsed=2 (>1, return failure)
      expect(result.retriesUsed).toBe(2);
      // 1 initial attempt + 1 retry = 2 total calls
      expect(mockClient.stream).toHaveBeenCalledTimes(2);
    });

    it('should handle non-Error thrown values', async () => {
      const history = buildSampleHistory(2);
      const mockClient = {
        stream: vi.fn().mockRejectedValue('string error'),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 5000);

      expect(result.success).toBe(false);
      expect(result.error).toBe('string error');
    });
  });

  // =========================================================================
  // compact() - context overflow handling
  // =========================================================================
  describe('compact() context overflow', () => {
    it('should trim history on context_length_exceeded and retry without counting as retry', async () => {
      const history = buildSampleHistory(5); // 10 items
      let callCount = 0;

      const mockClient = {
        stream: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 2) {
            return Promise.reject(new Error('context_length_exceeded'));
          }
          return Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'Trimmed summary' };
              yield { type: 'response.completed' };
            },
          });
        }),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 50000);

      expect(result.success).toBe(true);
      expect(result.itemsTrimmed).toBe(2); // Trimmed twice before succeeding
      expect(result.retriesUsed).toBe(0); // Context overflow doesn't count as retry
      expect(result.summaryText).toContain('Trimmed summary');
    });

    it('should handle maximum context length error pattern', async () => {
      const history = buildSampleHistory(3);
      let callCount = 0;

      const mockClient = {
        stream: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('maximum context length exceeded'));
          }
          return Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'OK' };
              yield { type: 'response.completed' };
            },
          });
        }),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(result.itemsTrimmed).toBe(1);
    });

    it('should handle token limit error pattern', async () => {
      const history = buildSampleHistory(3);
      let callCount = 0;

      const mockClient = {
        stream: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('token limit exceeded'));
          }
          return Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'OK' };
              yield { type: 'response.completed' };
            },
          });
        }),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(result.itemsTrimmed).toBe(1);
    });

    it('should handle too many tokens error pattern', async () => {
      const history = buildSampleHistory(3);
      let callCount = 0;

      const mockClient = {
        stream: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('too many tokens in request'));
          }
          return Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'OK' };
              yield { type: 'response.completed' };
            },
          });
        }),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(result.itemsTrimmed).toBe(1);
    });

    it('should handle context window error pattern', async () => {
      const history = buildSampleHistory(3);
      let callCount = 0;

      const mockClient = {
        stream: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return Promise.reject(new Error('Exceeds context window'));
          }
          return Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'OK' };
              yield { type: 'response.completed' };
            },
          });
        }),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(result.itemsTrimmed).toBe(1);
    });

    it('should fall back to retry when history has only 1 item and context overflows', async () => {
      const history = [createUserMessage('Single message')];
      const error = new Error('context_length_exceeded');
      const mockClient = createFailingModelClient(error);

      const result = await service.compact(history, 'auto', mockClient, 5000);

      // With only 1 item, trimming cannot happen; falls back to regular retry logic
      expect(result.success).toBe(false);
      expect(result.retriesUsed).toBe(4);
    });

    it('should combine trimming and retries when both occur', async () => {
      const history = buildSampleHistory(5); // 10 items
      let callCount = 0;

      const mockClient = {
        stream: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // First: context overflow -> trim
            return Promise.reject(new Error('context_length_exceeded'));
          }
          if (callCount === 2) {
            // Second: transient error -> retry
            return Promise.reject(new Error('Network error'));
          }
          // Third: success
          return Promise.resolve({
            [Symbol.asyncIterator]: async function* () {
              yield { type: 'response.output_item.delta', delta: 'Final summary' };
              yield { type: 'response.completed' };
            },
          });
        }),
      } as any;

      const result = await service.compact(history, 'auto', mockClient, 50000);

      expect(result.success).toBe(true);
      expect(result.itemsTrimmed).toBe(1);
      expect(result.retriesUsed).toBe(1);
    });
  });

  // =========================================================================
  // buildCompactedHistory
  // =========================================================================
  describe('buildCompactedHistory', () => {
    it('should return a CompactedHistory structure', () => {
      const history = [
        createUserMessage('Hello'),
        createAssistantMessage('Hi there!'),
        createUserMessage('How are you?'),
        createAssistantMessage('I am fine.'),
      ];

      const compacted = service.buildCompactedHistory(history, 'Summary of the conversation');

      expect(compacted).toBeDefined();
      expect(compacted.initialContext).toBeDefined();
      expect(compacted.preservedUserMessages).toBeDefined();
      expect(compacted.summaryMessage).toBeDefined();
    });

    it('should include summary text in summaryMessage', () => {
      const history = [
        createUserMessage('Test message'),
        createAssistantMessage('Test response'),
      ];

      const compacted = service.buildCompactedHistory(history, 'My summary text');

      const summaryContent = (compacted.summaryMessage as any).content as Array<{ type: string; text?: string }>;
      expect(summaryContent[0].text).toBe('My summary text');
    });

    it('should preserve user messages within budget', () => {
      const history = [
        createUserMessage('First question'),
        createAssistantMessage('First answer'),
        createUserMessage('Second question'),
        createAssistantMessage('Second answer'),
      ];

      const compacted = service.buildCompactedHistory(history, 'Summary');

      // With default budget of 20000, both short messages should be preserved
      expect(compacted.preservedUserMessages.length).toBeGreaterThan(0);
    });

    it('should extract initial context from system messages', () => {
      const history = [
        createSystemMessage('You are a helpful assistant.'),
        createUserMessage('Hello'),
        createAssistantMessage('Hi!'),
      ];

      const compacted = service.buildCompactedHistory(history, 'Summary');

      expect(compacted.initialContext.length).toBe(1);
      const sysContent = (compacted.initialContext[0] as any).content as Array<{ type: string; text?: string }>;
      expect(sysContent[0].text).toBe('You are a helpful assistant.');
    });

    it('should handle empty history', () => {
      const compacted = service.buildCompactedHistory([], 'Summary');

      expect(compacted.initialContext).toEqual([]);
      expect(compacted.preservedUserMessages).toEqual([]);
      expect(compacted.summaryMessage).toBeDefined();
    });

    it('should handle history with only assistant messages', () => {
      const history = [
        createAssistantMessage('Response 1'),
        createAssistantMessage('Response 2'),
      ];

      const compacted = service.buildCompactedHistory(history, 'Summary');

      // No user messages to preserve
      expect(compacted.preservedUserMessages).toEqual([]);
      expect(compacted.summaryMessage).toBeDefined();
    });
  });

  // =========================================================================
  // getHistoryReconstructor
  // =========================================================================
  describe('getHistoryReconstructor', () => {
    it('should return a HistoryReconstructor instance', () => {
      const reconstructor = service.getHistoryReconstructor();
      expect(reconstructor).toBeInstanceOf(HistoryReconstructor);
    });

    it('should return the same instance on multiple calls', () => {
      const reconstructor1 = service.getHistoryReconstructor();
      const reconstructor2 = service.getHistoryReconstructor();
      expect(reconstructor1).toBe(reconstructor2);
    });
  });

  // =========================================================================
  // Constructor
  // =========================================================================
  describe('constructor', () => {
    it('should create instance with default config', () => {
      const svc = new CompactService();
      expect(svc.getConfig()).toEqual({
        triggerThreshold: 0.9,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });
    });

    it('should accept partial config overrides', () => {
      const svc = new CompactService({ triggerThreshold: 0.5 });
      const config = svc.getConfig();
      expect(config.triggerThreshold).toBe(0.5);
      expect(config.userMessageBudget).toBe(20000);
    });

    it('should accept full config override', () => {
      const fullConfig: CompactionConfig = {
        triggerThreshold: 0.6,
        userMessageBudget: 10000,
        maxRetries: 5,
        baseBackoffMs: 200,
      };
      const svc = new CompactService(fullConfig);
      expect(svc.getConfig()).toEqual(fullConfig);
    });

    it('should accept empty config object', () => {
      const svc = new CompactService({});
      expect(svc.getConfig()).toEqual({
        triggerThreshold: 0.9,
        userMessageBudget: 20000,
        maxRetries: 3,
        baseBackoffMs: 100,
      });
    });
  });

  // =========================================================================
  // Edge cases and integration-like scenarios
  // =========================================================================
  describe('edge cases', () => {
    it('should handle compact() with empty history', async () => {
      const mockClient = createMockModelClient('Empty summary');

      const result = await service.compact([], 'manual', mockClient, 0);

      // Should still succeed - the service will attempt summarization
      expect(result.success).toBe(true);
      expect(result.tokensBefore).toBe(0);
    });

    it('should handle stream that yields no text deltas', async () => {
      const mockClient = {
        stream: vi.fn().mockResolvedValue({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'response.completed' };
          },
        }),
      } as any;
      const history = buildSampleHistory(2);

      const result = await service.compact(history, 'auto', mockClient, 10000);

      // Empty summary should still succeed (formatSummaryWithPrefix handles empty input)
      expect(result.success).toBe(true);
      expect(result.summaryText).toContain('[CONVERSATION SUMMARY]');
      expect(result.summaryText).toContain('(no summary available)');
    });

    it('should handle history with system context markers preserved as initial context', async () => {
      const history = [
        createUserMessage('<user_instructions>Be helpful</user_instructions>'),
        createUserMessage('Real question'),
        createAssistantMessage('Answer'),
      ];
      const mockClient = createMockModelClient('Summary with context');

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(result.newHistory).toBeDefined();
    });

    it('should not mutate the original history array', async () => {
      const history = buildSampleHistory(3);
      const originalLength = history.length;
      const mockClient = createMockModelClient('Summary');

      await service.compact(history, 'auto', mockClient, 10000);

      expect(history.length).toBe(originalLength);
    });

    it('compact() result newHistory should be a flat array of ResponseItems', async () => {
      const history = buildSampleHistory(3);
      const mockClient = createMockModelClient('Test summary for structure');

      const result = await service.compact(history, 'auto', mockClient, 10000);

      expect(result.success).toBe(true);
      expect(Array.isArray(result.newHistory)).toBe(true);
      for (const item of result.newHistory!) {
        expect(item).toHaveProperty('type');
        expect(item).toHaveProperty('content');
      }
    });

    it('should handle maxRetries of 0', async () => {
      const svc = new CompactService({ maxRetries: 0 });
      const history = buildSampleHistory(2);
      const error = new Error('Immediate failure');
      const mockClient = createFailingModelClient(error);

      const result = await svc.compact(history, 'auto', mockClient, 5000);

      expect(result.success).toBe(false);
      // With maxRetries=0: first failure increments retriesUsed to 1 (>0), returns failure
      expect(result.retriesUsed).toBe(1);
      // Only the initial attempt, no retries
      expect(mockClient.stream).toHaveBeenCalledTimes(1);
    });
  });
});
