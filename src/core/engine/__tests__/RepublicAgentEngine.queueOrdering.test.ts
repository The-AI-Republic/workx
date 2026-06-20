// File: src/core/engine/__tests__/RepublicAgentEngine.queueOrdering.test.ts
//
// Track 08 — Integration tests for priority-aware queue draining in the engine.
//
// What we're verifying: when multiple submissions sit in submissionQueue while
// processSubmissionQueue is mid-iteration, dequeue picks the highest-priority
// one for the next iteration — Interrupt / ExecApproval / Shutdown jump
// ahead of queued Compact / AddToHistory.

import { describe, it, expect, vi } from 'vitest';
import { RepublicAgentEngine } from '../RepublicAgentEngine';
import type { RepublicAgentEngineConfig } from '../RepublicAgentEngineConfig';

vi.mock('../../tasks/RegularTask', () => ({
  RegularTask: vi.fn(() => ({ type: 'regular' })),
}));

function createMockSession() {
  return {
    sessionId: 'test-session-1',
    setEventEmitter: vi.fn(),
    setTurnContext: vi.fn(),
    getTurnContext: vi.fn().mockReturnValue({
      setUserInstructions: vi.fn(),
      setBaseInstructions: vi.fn(),
      setModelClient: vi.fn(),
      setSelectedModelKey: vi.fn(),
    }),
    updateTurnContext: vi.fn(),
    getTabId: vi.fn().mockReturnValue(-1),
    setTabId: vi.fn(),
    getId: vi.fn().mockReturnValue('session-id-1'),
    getConversationHistory: vi.fn().mockReturnValue({ items: [] }),
    addPendingInput: vi.fn(),
    spawnTask: vi.fn().mockResolvedValue(undefined),
    requestInterrupt: vi.fn(),
    clearInterrupt: vi.fn(),
    abortAllTasks: vi.fn().mockResolvedValue(undefined),
    hasRunningTask: vi.fn().mockReturnValue(false),
    addToHistory: vi.fn(),
    getHistoryEntry: vi.fn(),
    clearHistory: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    initializeSession: vi.fn().mockResolvedValue(undefined),
    notifyApproval: vi.fn(),
    compact: vi.fn().mockResolvedValue({
      success: true,
      tokensBefore: 0,
      tokensAfter: 0,
      itemsTrimmed: 0,
    }),
    getCompactionCount: vi.fn().mockReturnValue(0),
  };
}

function createMockToolRegistry() {
  return {
    register: vi.fn(),
    getTool: vi.fn(),
    getAllTools: vi.fn().mockReturnValue([]),
    cleanup: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn(),
    setApprovalGate: vi.fn(),
    getApprovalGate: vi.fn().mockReturnValue(undefined),
  };
}

function createMockApprovalManager() {
  return {
    handleDecision: vi.fn().mockResolvedValue(undefined),
  };
}

function createEngine(overrides?: Partial<RepublicAgentEngineConfig>) {
  const mockSession = createMockSession();
  const mockToolRegistry = createMockToolRegistry();
  const mockApprovalManager = createMockApprovalManager();
  const mockModelClientFactory = {
    initialize: vi.fn().mockResolvedValue(undefined),
    createClientForCurrentModel: vi.fn().mockResolvedValue({
      getModel: vi.fn().mockReturnValue('test-model'),
    }),
    clearCache: vi.fn(),
    isBackendRouting: vi.fn().mockReturnValue(false),
  };

  const config: RepublicAgentEngineConfig = {
    agentConfig: {} as any,
    toolRegistry: mockToolRegistry as any,
    systemPrompt: 'test system prompt',
    modelClientFactory: mockModelClientFactory as any,
    session: mockSession as any,
    ownsSession: false,
    approvalManager: mockApprovalManager as any,
    ...overrides,
  };

  const engine = new RepublicAgentEngine(config);
  return { engine, mockSession, mockApprovalManager };
}

// Small helper: yield long enough for all queued promises to drain.
const flush = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

describe('RepublicAgentEngine — queue priority ordering (Track 08)', () => {
  it("higher-priority op jumps ahead of queued 'later' op", async () => {
    const { engine, mockSession, mockApprovalManager } = createEngine();
    await engine.initialize();

    const order: string[] = [];

    // Tag each handler so we observe the order they're called.
    mockSession.spawnTask.mockImplementation(async () => {
      order.push('UserInput');
    });
    mockSession.addToHistory.mockImplementation(() => {
      order.push('AddToHistory');
    });
    mockApprovalManager.handleDecision.mockImplementation(async () => {
      order.push('ExecApproval');
    });

    // Op1 (UserInput, 'next') kicks off processSubmissionQueue. It's dequeued
    // before Op2 and Op3 arrive. Op2 ('later') and Op3 ('now') land in the
    // queue while Op1 is awaiting spawnTask. When Op1's handler resolves,
    // dequeue picks Op3 (priority 'now') before Op2 (priority 'later').
    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'hello' }],
    });
    engine.submitOperation({
      type: 'AddToHistory',
      text: 'background note',
    });
    engine.submitOperation({
      type: 'ExecApproval',
      callId: 'call-1',
      decision: 'approved' as any,
    });

    await flush();

    expect(order).toEqual(['UserInput', 'ExecApproval', 'AddToHistory']);
  });

  it('preserves FIFO for same-priority ops', async () => {
    const { engine, mockSession } = createEngine();
    await engine.initialize();

    const seen: string[] = [];
    mockSession.addPendingInput.mockImplementation((items: any[]) => {
      seen.push(items[0]?.text ?? '');
    });

    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'first' }],
    });
    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'second' }],
    });
    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'third' }],
    });

    await flush();

    expect(seen).toEqual(['first', 'second', 'third']);
  });

  it('Interrupt clears the rest of the queue when it runs', async () => {
    const { engine, mockSession } = createEngine();
    await engine.initialize();

    const order: string[] = [];
    mockSession.spawnTask.mockImplementation(async () => {
      order.push('UserInput');
    });
    mockSession.requestInterrupt.mockImplementation(() => {
      order.push('Interrupt');
    });
    mockSession.addToHistory.mockImplementation(() => {
      order.push('AddToHistory');
    });

    // Op1 (UserInput, 'next') processes first. Op2 (AddToHistory, 'later')
    // is queued, then Op3 (Interrupt, 'now'). Drain order: Op1, then Op3
    // (priority 'now'). Op3's handler clears the rest of the queue, so Op2
    // never runs.
    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'hello' }],
    });
    engine.submitOperation({
      type: 'AddToHistory',
      text: 'should be dropped by Interrupt',
    });
    engine.submitOperation({ type: 'Interrupt' });

    await flush();

    expect(order).toEqual(['UserInput', 'Interrupt']);
    expect(mockSession.addToHistory).not.toHaveBeenCalled();
  });
});
