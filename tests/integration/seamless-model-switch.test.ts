/**
 * Integration Test: Seamless Model Switch Flow
 *
 * Tests the end-to-end flow when a user changes the model configuration
 * mid-conversation. Verifies that:
 * 1. Conversation history is preserved (not cleared) after model switch
 * 2. TurnContext reflects the new model
 * 3. Assistant ResponseItem modelKey annotation is persisted in history
 *
 * Uses real Session and TurnContext instances with mocked ModelClient
 * and RolloutRecorder.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Session } from '@/core/Session';
import { TurnContext } from '@/core/TurnContext';
import type { ResponseItem } from '@/core/protocol/types';
import type { ModelClient } from '@/core/models/ModelClient';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock RolloutRecorder so the Session constructor never touches IndexedDB
vi.mock('@/storage/rollout', () => ({
  RolloutRecorder: {
    create: vi.fn().mockResolvedValue({
      recordItems: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
      updateTitle: vi.fn().mockResolvedValue(undefined),
    }),
    getRolloutHistory: vi.fn().mockResolvedValue({
      type: 'resumed',
      payload: { history: [] },
    }),
  },
}));

// Mock uuid for deterministic IDs
let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

// Mock TitleGenerator so it never calls a real model
vi.mock('@/core/title', () => ({
  TitleGenerator: vi.fn().mockImplementation(() => ({
    countUserMessages: vi.fn().mockReturnValue(0),
    extractUserMessages: vi.fn().mockReturnValue([]),
    generateTitle: vi.fn().mockResolvedValue({ success: false }),
  })),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal mock ModelClient with a configurable model string */
function createMockModelClient(model: string): ModelClient {
  let currentModel = model;
  return {
    getModel: vi.fn(() => currentModel),
    setModel: vi.fn((m: string) => { currentModel = m; }),
    getModelContextWindow: vi.fn().mockReturnValue(128_000),
    getReasoningEffort: vi.fn().mockReturnValue(undefined),
    setReasoningEffort: vi.fn(),
    getReasoningSummary: vi.fn().mockReturnValue({ enabled: false }),
    setReasoningSummary: vi.fn(),
    stream: vi.fn(),
    complete: vi.fn(),
    countTokens: vi.fn().mockReturnValue(10),
    getProvider: vi.fn().mockReturnValue({ id: 'mock', name: 'Mock' }),
    streamCompletion: vi.fn(),
    getAutoCompactTokenLimit: vi.fn().mockReturnValue(undefined),
    getModelFamily: vi.fn().mockReturnValue(undefined),
    getAuthManager: vi.fn().mockReturnValue(undefined),
  } as unknown as ModelClient;
}

/** Build a user message ResponseItem */
function makeUserMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

/** Build an assistant message ResponseItem with optional modelKey */
function makeAssistantMessage(text: string, modelKey?: string): ResponseItem {
  const item: ResponseItem = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
  if (modelKey !== undefined) {
    (item as any).modelKey = modelKey;
  }
  return item;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Seamless Model Switch Integration', () => {
  let session: Session;
  let turnContext: TurnContext;
  let initialModelClient: ModelClient;

  beforeEach(() => {
    uuidCounter = 0;

    // Create a non-persistent Session to avoid background RolloutRecorder work
    session = new Session(undefined, false);

    // Create the initial model client and TurnContext
    initialModelClient = createMockModelClient('openai:gpt-4');
    turnContext = new TurnContext(initialModelClient, {
      sessionId: session.conversationId,
      approvalPolicy: 'on-request',
      sandboxPolicy: { mode: 'workspace-write' },
    });
    session.setTurnContext(turnContext);
  });

  // =========================================================================
  // 1. Seed conversation history, switch model, verify history preserved
  // =========================================================================
  describe('History preservation after model switch', () => {
    it('should preserve conversation history when model is changed via setModelClient', async () => {
      // Seed some conversation history
      const userMsg1 = makeUserMessage('Hello, how are you?');
      const assistantMsg1 = makeAssistantMessage('I am doing well!', 'openai:gpt-4');
      const userMsg2 = makeUserMessage('Tell me about TypeScript');
      const assistantMsg2 = makeAssistantMessage(
        'TypeScript is a typed superset of JavaScript.',
        'openai:gpt-4',
      );

      await session.recordConversationItemsDual([userMsg1]);
      await session.recordConversationItemsDual([assistantMsg1]);
      await session.recordConversationItemsDual([userMsg2]);
      await session.recordConversationItemsDual([assistantMsg2]);

      const historyBefore = session.getConversationHistory();
      expect(historyBefore.items).toHaveLength(4);

      // --- Trigger model switch ---
      const newModelClient = createMockModelClient('anthropic:claude-3-opus');
      turnContext.setModelClient(newModelClient);

      // --- Verify history is NOT cleared ---
      const historyAfter = session.getConversationHistory();
      expect(historyAfter.items).toHaveLength(4);
      expect(historyAfter.items).toEqual(historyBefore.items);
    });

    it('should preserve history when model is changed via TurnContext.update()', async () => {
      // Seed history
      await session.recordConversationItemsDual([makeUserMessage('Question 1')]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('Answer 1', 'openai:gpt-4'),
      ]);

      const countBefore = session.getMessageCount();
      expect(countBefore).toBe(2);

      // Switch model via update()
      turnContext.update({ model: 'gpt-4o-mini' });

      // History count unchanged
      expect(session.getMessageCount()).toBe(countBefore);

      // History content unchanged
      const history = session.getConversationHistory();
      expect(history.items[0]).toMatchObject({
        type: 'message',
        role: 'user',
      });
      expect(history.items[1]).toMatchObject({
        type: 'message',
        role: 'assistant',
      });
    });

    it('should NOT call clearHistory during model switch', async () => {
      // Seed history
      await session.recordConversationItemsDual([makeUserMessage('Hello')]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('Hi there!', 'openai:gpt-4'),
      ]);

      // Spy on clearHistory
      const clearSpy = vi.spyOn(session, 'clearHistory');

      // Perform the model switch
      const newClient = createMockModelClient('anthropic:claude-3-opus');
      turnContext.setModelClient(newClient);

      expect(clearSpy).not.toHaveBeenCalled();

      clearSpy.mockRestore();
    });
  });

  // =========================================================================
  // 2. TurnContext reflects new model after switch
  // =========================================================================
  describe('TurnContext model update', () => {
    it('should reflect new model via getModel() after setModelClient()', () => {
      expect(turnContext.getModel()).toBe('openai:gpt-4');

      const newClient = createMockModelClient('anthropic:claude-3-opus');
      turnContext.setModelClient(newClient);

      expect(turnContext.getModel()).toBe('anthropic:claude-3-opus');
    });

    it('should reflect new model via getModel() after update({ model })', () => {
      expect(turnContext.getModel()).toBe('openai:gpt-4');

      turnContext.update({ model: 'openai:gpt-4o' });

      expect(turnContext.getModel()).toBe('openai:gpt-4o');
    });

    it('should replace the model client instance when using setModelClient', () => {
      const oldClient = turnContext.getModelClient();
      const newClient = createMockModelClient('google:gemini-2.0-flash');
      turnContext.setModelClient(newClient);

      expect(turnContext.getModelClient()).toBe(newClient);
      expect(turnContext.getModelClient()).not.toBe(oldClient);
    });

    it('should use updated model for session TurnContext reference', () => {
      const newClient = createMockModelClient('anthropic:claude-3-opus');
      turnContext.setModelClient(newClient);

      // Session holds the same TurnContext by reference
      const sessionCtx = session.getTurnContext();
      expect(sessionCtx.getModel()).toBe('anthropic:claude-3-opus');
    });
  });

  // =========================================================================
  // 3. modelKey annotation persisted on assistant ResponseItems
  // =========================================================================
  describe('modelKey annotation persistence', () => {
    it('should persist modelKey on assistant messages via recordConversationItemsDual', async () => {
      const assistantMsg = makeAssistantMessage(
        'This response was generated by GPT-4.',
        'openai:gpt-4',
      );

      await session.recordConversationItemsDual([assistantMsg]);

      const history = session.getConversationHistory();
      expect(history.items).toHaveLength(1);

      const recorded = history.items[0];
      expect(recorded.type).toBe('message');
      if (recorded.type === 'message') {
        expect(recorded.modelKey).toBe('openai:gpt-4');
      }
    });

    it('should persist modelKey from the new model after switching', async () => {
      // Record a message from model A
      await session.recordConversationItemsDual([
        makeAssistantMessage('Response from model A', 'openai:gpt-4'),
      ]);

      // Switch to model B
      const newClient = createMockModelClient('anthropic:claude-3-opus');
      turnContext.setModelClient(newClient);

      // Record a message from model B
      await session.recordConversationItemsDual([
        makeAssistantMessage('Response from model B', 'anthropic:claude-3-opus'),
      ]);

      const history = session.getConversationHistory();
      expect(history.items).toHaveLength(2);

      // First message has model A's key
      const first = history.items[0];
      expect(first.type).toBe('message');
      if (first.type === 'message') {
        expect(first.modelKey).toBe('openai:gpt-4');
      }

      // Second message has model B's key
      const second = history.items[1];
      expect(second.type).toBe('message');
      if (second.type === 'message') {
        expect(second.modelKey).toBe('anthropic:claude-3-opus');
      }
    });

    it('should allow messages without modelKey (field is optional)', async () => {
      const msgWithoutKey = makeAssistantMessage('No model annotation');
      // Explicitly no modelKey set

      await session.recordConversationItemsDual([msgWithoutKey]);

      const history = session.getConversationHistory();
      expect(history.items).toHaveLength(1);

      const recorded = history.items[0];
      expect(recorded.type).toBe('message');
      if (recorded.type === 'message') {
        expect(recorded.modelKey).toBeUndefined();
      }
    });

    it('should preserve modelKey across history retrieval methods', async () => {
      await session.recordConversationItemsDual([
        makeAssistantMessage('Test message', 'openai:gpt-4o'),
      ]);

      // getConversationHistory
      const history = session.getConversationHistory();
      const itemFromHistory = history.items[0];
      expect(itemFromHistory.type).toBe('message');
      if (itemFromHistory.type === 'message') {
        expect(itemFromHistory.modelKey).toBe('openai:gpt-4o');
      }

      // getLastMessage
      const last = session.getLastMessage();
      expect(last).toBeDefined();
      expect(last!.type).toBe('message');
      if (last!.type === 'message') {
        expect(last!.modelKey).toBe('openai:gpt-4o');
      }

      // getHistoryEntry (offset -1 = last item)
      const entry = session.getHistoryEntry(-1);
      expect(entry).toBeDefined();
      expect(entry!.type).toBe('message');
      if (entry!.type === 'message') {
        expect(entry!.modelKey).toBe('openai:gpt-4o');
      }
    });
  });

  // =========================================================================
  // 4. End-to-end: full model switch flow
  // =========================================================================
  describe('End-to-end model switch flow', () => {
    it('should complete a full model switch without data loss', async () => {
      // Step 1: Seed conversation with model A
      const modelAKey = 'openai:gpt-4';
      await session.recordConversationItemsDual([makeUserMessage('Hello')]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('Hi! I am GPT-4.', modelAKey),
      ]);
      await session.recordConversationItemsDual([
        makeUserMessage('What can you do?'),
      ]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('I can help with many tasks.', modelAKey),
      ]);

      expect(session.getMessageCount()).toBe(4);
      expect(turnContext.getModel()).toBe(modelAKey);

      // Step 2: Simulate model config change event (cross-provider switch)
      const modelBKey = 'anthropic:claude-3-opus';
      const newModelClient = createMockModelClient(modelBKey);
      turnContext.setModelClient(newModelClient);

      // Step 3: Verify history is preserved
      expect(session.getMessageCount()).toBe(4);
      const history = session.getConversationHistory();
      expect(history.items[0]).toMatchObject({ type: 'message', role: 'user' });
      expect(history.items[1]).toMatchObject({
        type: 'message',
        role: 'assistant',
        modelKey: modelAKey,
      });
      expect(history.items[2]).toMatchObject({ type: 'message', role: 'user' });
      expect(history.items[3]).toMatchObject({
        type: 'message',
        role: 'assistant',
        modelKey: modelAKey,
      });

      // Step 4: Verify TurnContext has the new model
      expect(turnContext.getModel()).toBe(modelBKey);
      expect(session.getTurnContext().getModel()).toBe(modelBKey);

      // Step 5: Continue conversation with model B
      await session.recordConversationItemsDual([
        makeUserMessage('Now continue with new model'),
      ]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('I am Claude, happy to help!', modelBKey),
      ]);

      // Step 6: Verify full history integrity
      expect(session.getMessageCount()).toBe(6);

      const fullHistory = session.getConversationHistory();

      // First 4 items have model A annotations on assistant messages
      for (const item of fullHistory.items.slice(0, 4)) {
        if (item.type === 'message' && item.role === 'assistant') {
          expect(item.modelKey).toBe(modelAKey);
        }
      }

      // Last assistant message has model B annotation
      const lastItem = fullHistory.items[5];
      expect(lastItem.type).toBe('message');
      if (lastItem.type === 'message') {
        expect(lastItem.role).toBe('assistant');
        expect(lastItem.modelKey).toBe(modelBKey);
      }
    });

    it('should handle rapid consecutive model switches', async () => {
      // Seed initial history
      await session.recordConversationItemsDual([makeUserMessage('Start')]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('Response A', 'openai:gpt-4'),
      ]);

      // Rapid model switches
      const modelsToSwitch = [
        'anthropic:claude-3-opus',
        'google:gemini-2.0-flash',
        'openai:gpt-4o',
        'anthropic:claude-3-haiku',
      ];

      for (const modelKey of modelsToSwitch) {
        const client = createMockModelClient(modelKey);
        turnContext.setModelClient(client);
      }

      // History should still be intact
      expect(session.getMessageCount()).toBe(2);

      // TurnContext should reflect the last model
      expect(turnContext.getModel()).toBe('anthropic:claude-3-haiku');

      // Record a new message with the final model
      await session.recordConversationItemsDual([
        makeAssistantMessage('Final response', 'anthropic:claude-3-haiku'),
      ]);

      expect(session.getMessageCount()).toBe(3);
      const last = session.getLastMessage();
      expect(last!.type).toBe('message');
      if (last!.type === 'message') {
        expect(last!.modelKey).toBe('anthropic:claude-3-haiku');
      }
    });

    it('should preserve buildTurnInputWithHistory results after model switch', async () => {
      // Seed history
      await session.recordConversationItemsDual([makeUserMessage('Hello')]);
      await session.recordConversationItemsDual([
        makeAssistantMessage('Hi!', 'openai:gpt-4'),
      ]);

      // Switch model
      const newClient = createMockModelClient('anthropic:claude-3-opus');
      turnContext.setModelClient(newClient);

      // buildTurnInputWithHistory should include all previous history
      const newInput = [makeUserMessage('Continue conversation')];
      const fullInput = await session.buildTurnInputWithHistory(newInput);

      // Should be 2 history items + 1 new item
      expect(fullInput).toHaveLength(3);
      expect(fullInput[0]).toMatchObject({ type: 'message', role: 'user' });
      expect(fullInput[1]).toMatchObject({
        type: 'message',
        role: 'assistant',
        modelKey: 'openai:gpt-4',
      });
      expect(fullInput[2]).toMatchObject({ type: 'message', role: 'user' });
    });
  });
});
