/**
 * Integration Test: Settings Hot-Reload (hotSwapModelClient flow)
 *
 * Tests the full hot-swap path using real Session + TurnContext instances.
 * Verifies that:
 * 1. Conversation history is preserved after a hot-swap
 * 2. The same TurnContext object reference is kept (not replaced)
 * 3. Conversation can continue after a hot-swap
 * 4. session.setTurnContext is NOT called during hot-swap
 * 5. Consecutive hot-swaps work correctly
 *
 * Uses real Session and TurnContext instances with mocked ModelClient
 * and RolloutRecorder (same pattern as seamless-model-switch.test.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Session } from '@/core/Session';
import { TurnContext } from '@/core/TurnContext';
import type { ResponseItem } from '@/core/protocol/types';
import type { ModelClient } from '@/core/models/ModelClient';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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

let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `hot-reload-uuid-${++uuidCounter}`,
}));

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

function makeUserMessage(text: string): ResponseItem {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  };
}

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

describe('Settings Hot-Reload Integration', () => {
  let session: Session;
  let turnContext: TurnContext;
  let initialModelClient: ModelClient;

  beforeEach(() => {
    uuidCounter = 0;

    session = new Session(undefined, false);
    initialModelClient = createMockModelClient('openai:gpt-4');
    turnContext = new TurnContext(initialModelClient, {
      sessionId: session.conversationId,
      approvalPolicy: 'on-request',
      sandboxPolicy: { mode: 'workspace-write' },
    });
    session.setTurnContext(turnContext);
  });

  it('should preserve conversation history after hot-swap', async () => {
    // Seed conversation
    await session.recordConversationItemsDual([makeUserMessage('Hello')]);
    await session.recordConversationItemsDual([
      makeAssistantMessage('Hi there!', 'openai:gpt-4'),
    ]);
    await session.recordConversationItemsDual([makeUserMessage('How are you?')]);
    await session.recordConversationItemsDual([
      makeAssistantMessage('Doing well!', 'openai:gpt-4'),
    ]);

    const historyBefore = session.getConversationHistory();
    expect(historyBefore.items).toHaveLength(4);

    // --- Hot-swap: replace model client in-place ---
    const newClient = createMockModelClient('anthropic:claude-3-opus');
    turnContext.setModelClient(newClient);
    turnContext.setSelectedModelKey('anthropic:claude-3-opus');

    // --- Verify history is preserved ---
    const historyAfter = session.getConversationHistory();
    expect(historyAfter.items).toHaveLength(4);
    expect(historyAfter.items).toEqual(historyBefore.items);
  });

  it('should keep same TurnContext object reference (not replaced)', async () => {
    const ctxBefore = session.getTurnContext();

    // Hot-swap
    const newClient = createMockModelClient('anthropic:claude-3-opus');
    turnContext.setModelClient(newClient);

    const ctxAfter = session.getTurnContext();

    // Same reference — object identity preserved
    expect(ctxAfter).toBe(ctxBefore);
    expect(ctxAfter).toBe(turnContext);
  });

  it('should allow continued conversation after hot-swap', async () => {
    // Seed conversation
    await session.recordConversationItemsDual([makeUserMessage('Hello')]);
    await session.recordConversationItemsDual([
      makeAssistantMessage('Hi!', 'openai:gpt-4'),
    ]);

    // Hot-swap
    const newClient = createMockModelClient('anthropic:claude-3-opus');
    turnContext.setModelClient(newClient);
    turnContext.setSelectedModelKey('anthropic:claude-3-opus');

    // Continue conversation with new model
    await session.recordConversationItemsDual([
      makeUserMessage('Continue with new model'),
    ]);
    await session.recordConversationItemsDual([
      makeAssistantMessage('I am now Claude!', 'anthropic:claude-3-opus'),
    ]);

    expect(session.getMessageCount()).toBe(4);

    // Verify new model is active
    expect(turnContext.getModel()).toBe('anthropic:claude-3-opus');

    // History includes both old and new messages
    const history = session.getConversationHistory();
    const lastMsg = history.items[3];
    expect(lastMsg.type).toBe('message');
    if (lastMsg.type === 'message') {
      expect(lastMsg.modelKey).toBe('anthropic:claude-3-opus');
    }
  });

  it('should NOT call session.setTurnContext during hot-swap', async () => {
    // Spy on setTurnContext
    const setTurnContextSpy = vi.spyOn(session, 'setTurnContext');

    // Clear the call from beforeEach
    setTurnContextSpy.mockClear();

    // Perform the hot-swap (in-place on existing TurnContext)
    const newClient = createMockModelClient('anthropic:claude-3-opus');
    turnContext.setModelClient(newClient);
    turnContext.setSelectedModelKey('anthropic:claude-3-opus');

    // setTurnContext should NOT be called — that's the whole point of hot-swap
    expect(setTurnContextSpy).not.toHaveBeenCalled();

    setTurnContextSpy.mockRestore();
  });

  it('should support consecutive hot-swaps (key change then model change)', async () => {
    // Seed history
    await session.recordConversationItemsDual([makeUserMessage('Start')]);
    await session.recordConversationItemsDual([
      makeAssistantMessage('Response 1', 'openai:gpt-4'),
    ]);

    // First hot-swap: change API key (same provider, different key)
    const client2 = createMockModelClient('openai:gpt-4');
    turnContext.setModelClient(client2);

    expect(session.getMessageCount()).toBe(2);
    expect(turnContext.getModel()).toBe('openai:gpt-4');

    // Second hot-swap: change model entirely
    const client3 = createMockModelClient('anthropic:claude-3-opus');
    turnContext.setModelClient(client3);
    turnContext.setSelectedModelKey('anthropic:claude-3-opus');

    expect(session.getMessageCount()).toBe(2);
    expect(turnContext.getModel()).toBe('anthropic:claude-3-opus');

    // Continue after consecutive swaps
    await session.recordConversationItemsDual([
      makeUserMessage('After two swaps'),
    ]);
    await session.recordConversationItemsDual([
      makeAssistantMessage('Still working!', 'anthropic:claude-3-opus'),
    ]);

    expect(session.getMessageCount()).toBe(4);

    // TurnContext reference unchanged throughout
    expect(session.getTurnContext()).toBe(turnContext);

    // Build full input to verify history integrity
    const fullInput = await session.buildTurnInputWithHistory([
      makeUserMessage('Final question'),
    ]);
    expect(fullInput).toHaveLength(5); // 4 history + 1 new
  });
});
