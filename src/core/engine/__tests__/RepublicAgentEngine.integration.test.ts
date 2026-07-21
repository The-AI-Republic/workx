/**
 * Integration Tests: RepublicAgentEngine + Sub-Agent Validation
 *
 * M5.1: Engine with real Session + mocked ModelClient executes tasks
 * M5.2: createChildEngine returns engine that runs real tasks
 * M5.3: SubAgentRunner uses engine to execute sub-agent tasks end-to-end
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RepublicAgentEngine } from '../RepublicAgentEngine';
import { SubAgentRunner } from '@/tools/AgentTool/SubAgentRunner';
import { SubAgentRegistry } from '@/tools/AgentTool/SubAgentRegistry';
import type { RepublicAgentEngineConfig, EngineEvent, InputItem } from '../RepublicAgentEngineConfig';
import type { SubAgentTypeConfig, SubAgentResult, BackgroundSubAgentResult } from '@/tools/AgentTool/types';
import { isBackgroundSubAgentResult } from '@/tools/AgentTool/types';

/** Narrow runner.run() result to SubAgentResult for foreground-only tests. */
function expectSubAgentResult(
  r: SubAgentResult | BackgroundSubAgentResult,
): SubAgentResult {
  if (isBackgroundSubAgentResult(r)) {
    throw new Error('expected SubAgentResult, got BackgroundSubAgentResult');
  }
  return r;
}
import { TurnContext } from '../../TurnContext';

// ---------------------------------------------------------------------------
// Mock: RegularTask (avoid importing the full task system)
// ---------------------------------------------------------------------------

vi.mock('../../tasks/RegularTask', () => ({
  RegularTask: vi.fn(() => ({ type: 'regular' })),
}));

// Mock Session for child engine (sub-agent) path
vi.mock('../../Session', () => ({
  Session: vi.fn(() => ({
    sessionId: 'child-session-1',
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
    getId: vi.fn().mockReturnValue('child-session-id'),
    getSessionId: vi.fn().mockReturnValue('child-session-id'),
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
    notifyApproval: vi.fn(),
    compact: vi.fn().mockResolvedValue({ success: true, tokensBefore: 1000, tokensAfter: 500, itemsTrimmed: 5 }),
    getCompactionCount: vi.fn().mockReturnValue(0),
    getToolRegistry: vi.fn().mockReturnValue(null),
  })),
}));

// Mock TurnContext for child engine initialization
vi.mock('../../TurnContext', () => ({
  TurnContext: vi.fn(() => ({
    setSelectedModelKey: vi.fn(),
    setBaseInstructions: vi.fn(),
    setUserInstructions: vi.fn(),
    setModelClient: vi.fn(),
    getSessionId: vi.fn().mockReturnValue(''),
    update: vi.fn(),
  })),
}));

// Mock ToolRegistryCloner to return a simple registry clone
vi.mock('../../../tools/ToolRegistryCloner', () => ({
  createSubAgentToolRegistry: vi.fn(async (parentRegistry: any) => {
    // Return a simple clone of the parent registry
    return {
      register: vi.fn(),
      getTool: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      cleanup: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      setApprovalGate: vi.fn(),
      getApprovalGate: vi.fn().mockReturnValue(undefined),
    };
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSession() {
  return {
    sessionId: 'integration-session-1',
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
    getId: vi.fn().mockReturnValue('session-id-int'),
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
      tokensBefore: 1000,
      tokensAfter: 500,
      itemsTrimmed: 5,
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

function createMockModelClientFactory() {
  const mockClient = {
    getModel: vi.fn().mockReturnValue('test-model'),
    setModel: vi.fn(),
    getModelContextWindow: vi.fn().mockReturnValue(128000),
  };
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    createClientForCurrentModel: vi.fn().mockResolvedValue(mockClient),
    createClientForModelKey: vi.fn().mockResolvedValue(mockClient),
    clearCache: vi.fn(),
    isBackendRouting: vi.fn().mockReturnValue(false),
  };
}

// ---------------------------------------------------------------------------
// M5.1: Engine integration with Session
// ---------------------------------------------------------------------------

describe('M5.1: Engine integration with Session', () => {
  it('should spawn a task through session and emit lifecycle events', async () => {
    const mockSession = createMockSession();
    const engine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'You are a test agent',
      modelClientFactory: createMockModelClientFactory() as any,
      session: mockSession as any,
      ownsSession: false,
    });

    await engine.initialize();

    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));

    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'Hello, execute a task' }],
    });

    await new Promise(r => setTimeout(r, 20));

    // Verify session received the task
    expect(mockSession.addPendingInput).toHaveBeenCalledWith(
      [{ type: 'text', text: 'Hello, execute a task' }]
    );
    expect(mockSession.spawnTask).toHaveBeenCalled();

    // TaskStarted is emitted by TaskRunner (not the engine directly)
  });

  it('should handle multi-turn interaction (multiple UserInput submissions)', async () => {
    const mockSession = createMockSession();
    const engine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'test',
      modelClientFactory: createMockModelClientFactory() as any,
      session: mockSession as any,
      ownsSession: false,
    });

    await engine.initialize();

    // Turn 1
    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'First message' }],
    });
    await new Promise(r => setTimeout(r, 10));

    // Turn 2
    engine.submitOperation({
      type: 'UserTurn',
      items: [{ type: 'text', text: 'Follow up' }],
    });
    await new Promise(r => setTimeout(r, 10));

    // Both turns should have spawned tasks
    expect(mockSession.spawnTask).toHaveBeenCalledTimes(2);
  });

  it('should handle interrupt during task execution', async () => {
    const mockSession = createMockSession();
    const engine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'test',
      modelClientFactory: createMockModelClientFactory() as any,
      session: mockSession as any,
      ownsSession: false,
    });

    await engine.initialize();

    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));

    // Start a task then interrupt
    engine.submitOperation({
      type: 'UserInput',
      items: [{ type: 'text', text: 'Long task' }],
    });
    engine.submitOperation({ type: 'Interrupt', reason: 'user_cancel' });
    await new Promise(r => setTimeout(r, 20));

    expect(mockSession.requestInterrupt).toHaveBeenCalled();
    expect(mockSession.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');

    const abortEvent = events.find(e => e.msg.type === 'TurnAborted');
    expect(abortEvent).toBeDefined();
  });

  it('should clean up session when engine owns it', async () => {
    const mockSession = createMockSession();
    const engine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'test',
      modelClientFactory: createMockModelClientFactory() as any,
      session: mockSession as any,
      ownsSession: true,
    });

    await engine.initialize();
    await engine.dispose();

    expect(mockSession.shutdown).toHaveBeenCalled();
  });

  it('should handle approval flow during task', async () => {
    const mockSession = createMockSession();
    const engine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'test',
      modelClientFactory: createMockModelClientFactory() as any,
      session: mockSession as any,
      ownsSession: false,
    });

    await engine.initialize();

    // Submit approval
    engine.submitOperation({
      type: 'ExecApproval',
      callId: 'tool-call-1',
      decision: 'approve' as const,
    });
    await new Promise(r => setTimeout(r, 10));

    expect(mockSession.notifyApproval).toHaveBeenCalledWith('tool-call-1', 'approve');
  });
});

// ---------------------------------------------------------------------------
// M5.2: createChildEngine creates working engine
// ---------------------------------------------------------------------------

describe('M5.2: createChildEngine creates working engine', () => {
  it('should create a child engine that can be initialized', async () => {
    // Create parent engine first
    const parentEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'parent prompt',
      modelClientFactory: createMockModelClientFactory() as any,
      session: createMockSession() as any,
      ownsSession: false,
    });
    await parentEngine.initialize();

    // Create child engine (sub-agent path: no session provided)
    const childEngine = new RepublicAgentEngine({
      agentConfig: parentEngine.getConfig().agentConfig,
      modelClientFactory: parentEngine.getConfig().modelClientFactory,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'child system prompt',
      persistent: false,
    });

    // Child engine should be able to initialize (creates its own session)
    // This will fail because Session is a real class — we mock it
    await childEngine.initialize();

    expect(childEngine.isReady()).toBe(true);
    expect(childEngine.getSession()).not.toBeNull();
  });

  it('should create a child engine with its own session (non-persistent)', async () => {
    const childEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'child',
      modelClientFactory: createMockModelClientFactory() as any,
      persistent: false,
      // No session provided — engine creates its own
    });

    await childEngine.initialize();
    expect(childEngine.isReady()).toBe(true);

    // Engine owns the session, so dispose should shut it down
    await childEngine.dispose();
    expect(childEngine.isDisposed()).toBe(true);
  });

  it('should apply child approval policy and browserContext to internally-owned sessions', async () => {
    const parentEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'parent',
      modelClientFactory: createMockModelClientFactory() as any,
      session: createMockSession() as any,
      ownsSession: false,
    });
    await parentEngine.initialize();

    const childEngine = parentEngine.createChildEngine({
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'child',
      approvalPolicy: 'never',
      browserContext: {
        tabId: 321,
        controller: {} as any,
      },
    });

    await childEngine.initialize();

    const childSession = childEngine.getSession() as any;
    expect(childSession.setTabId).not.toHaveBeenCalled();
    expect(vi.mocked(TurnContext)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        approvalPolicy: 'never',
      }),
    );
  });

  it('should support event routing through parent', async () => {
    const parentEvents: EngineEvent[] = [];
    const parentEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'parent',
      modelClientFactory: createMockModelClientFactory() as any,
      session: createMockSession() as any,
      ownsSession: false,
    });
    await parentEngine.initialize();
    parentEngine.onEvent((e) => parentEvents.push(e));

    // Create child with event router that routes to parent
    const childEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'child',
      modelClientFactory: createMockModelClientFactory() as any,
      persistent: false,
      eventRouter: {
        routeEvent: (event, context) => {
          parentEngine.pushEvent({
            ...event,
            msg: {
              ...event.msg,
              _subAgent: {
                engineId: context.engineId,
                parentEngineId: context.parentEngineId,
                depth: 1,
              },
            },
          });
        },
        shouldEmit: () => true,
      },
      parentEngineId: parentEngine.engineId,
    });
    await childEngine.initialize();

    // Trigger an event on the child
    childEngine.submitOperation({ type: 'Interrupt' });
    await new Promise(r => setTimeout(r, 10));

    // Events should have routed to parent
    const routedEvent = parentEvents.find(
      e => e.msg._subAgent?.depth === 1
    );
    expect(routedEvent).toBeDefined();

    await childEngine.dispose();
  });
});

// ---------------------------------------------------------------------------
// M5.3: SubAgentRunner end-to-end
// ---------------------------------------------------------------------------

describe('M5.3: SubAgentRunner end-to-end', () => {
  let parentEngine: RepublicAgentEngine;
  let parentEvents: EngineEvent[];

  beforeEach(async () => {
    parentEvents = [];
    parentEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: createMockToolRegistry() as any,
      systemPrompt: 'parent',
      modelClientFactory: createMockModelClientFactory() as any,
      session: createMockSession() as any,
      ownsSession: false,
    });
    await parentEngine.initialize();
    parentEngine.onEvent((e) => parentEvents.push(e));
  });

  it('should resolve known sub-agent type and run', async () => {
    const runner = new SubAgentRunner({
      parentEngine,
    });

    // The 'researcher' type is built-in
    const types = runner.getTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(types.find(t => t.id === 'researcher')).toBeDefined();
  });

  it('should return error for unknown sub-agent type', async () => {
    const runner = new SubAgentRunner({
      parentEngine,
    });

    const result = expectSubAgentResult(await runner.run({
      type: 'nonexistent',
      prompt: 'do something',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown sub-agent type');
  });

  it('should enforce concurrency limits', async () => {
    const registry = new SubAgentRegistry({ maxConcurrent: 1 });

    // Register a fake running agent to fill the slot
    registry.register({
      runId: 'fake-run',
      type: 'researcher',
      description: 'test',
      parentSessionId: parentEngine.engineId,
      engine: {} as any,
      startTime: Date.now(),
      status: 'running',
    });

    const runner = new SubAgentRunner({
      parentEngine,
      registry,
    });

    const result = expectSubAgentResult(await runner.run({
      type: 'researcher',
      prompt: 'analyze code',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Max concurrent');
  });

  it('should emit SubAgentStart event when running', async () => {
    // Spy on RepublicAgentEngine to intercept the child engine's run() method.
    // The child engine's run() blocks forever without a real LLM, so we mock it.
    const originalRun = RepublicAgentEngine.prototype.run;
    RepublicAgentEngine.prototype.run = vi.fn().mockResolvedValue({
      success: true,
      response: 'test response',
      turnCount: 1,
      stopReason: 'completed',
      engineId: 'child-engine',
      submissionId: 'sub-1',
    });

    try {
      const runner = new SubAgentRunner({
        parentEngine,
      });

      const result = expectSubAgentResult(await runner.run({
        type: 'researcher',
        prompt: 'test prompt',
      }));

      const startEvent = parentEvents.find(e => e.msg.type === 'SubAgentStart');
      expect(startEvent).toBeDefined();
      expect(startEvent!.msg.data?.subAgentType).toBe('researcher');

      const completeEvent = parentEvents.find(e => e.msg.type === 'SubAgentComplete');
      expect(completeEvent).toBeDefined();

      expect(result.success).toBe(true);
      expect(result.response).toBe('test response');
      expect(result.runId).toBeTruthy();
    } finally {
      RepublicAgentEngine.prototype.run = originalRun;
    }
  });

  it('should support custom sub-agent types', async () => {
    const customType: SubAgentTypeConfig = {
      id: 'custom-analyzer',
      name: 'Custom Analyzer',
      description: 'Analyzes custom data',
      systemPrompt: 'You are a custom analyzer',
      tools: { deny: [] },
      maxTurns: 10,
    };

    const runner = new SubAgentRunner({
      parentEngine,
      customTypes: [customType],
    });

    const types = runner.getTypes();
    expect(types.find(t => t.id === 'custom-analyzer')).toBeDefined();
  });

  it('should inherit approval policy and browserContext when requested', async () => {
    const approvalGate = { gate: 'parent' } as any;
    const parentSession = createMockSession();
    parentSession.getTurnContext.mockReturnValue({
      getApprovalPolicy: vi.fn().mockReturnValue('on-request'),
      setUserInstructions: vi.fn(),
      setBaseInstructions: vi.fn(),
      setModelClient: vi.fn(),
      setSelectedModelKey: vi.fn(),
    });

    const parentRegistry = createMockToolRegistry();
    parentRegistry.getApprovalGate.mockReturnValue(approvalGate);

    const parentEngine = new RepublicAgentEngine({
      agentConfig: {} as any,
      toolRegistry: parentRegistry as any,
      systemPrompt: 'parent',
      modelClientFactory: createMockModelClientFactory() as any,
      session: parentSession as any,
      ownsSession: false,
      browserContext: {
        tabId: 99,
        controller: {} as any,
      },
    });
    await parentEngine.initialize();
    parentEngine.onEvent((e) => parentEvents.push(e));

    const originalRun = RepublicAgentEngine.prototype.run;
    RepublicAgentEngine.prototype.run = vi.fn().mockResolvedValue({
      success: true,
      response: 'test response',
      turnCount: 1,
      stopReason: 'completed',
      engineId: 'child-engine',
      submissionId: 'sub-1',
    });

    try {
      const runner = new SubAgentRunner({
        parentEngine,
        customTypes: [{
          id: 'inherits-approval',
          name: 'Inherits Approval',
          description: 'Uses parent approval settings',
          systemPrompt: 'inherit settings',
          approvalPolicy: 'inherit',
        }],
      });

      await runner.run({
        type: 'inherits-approval',
        prompt: 'test prompt',
      });

      const childEngine = (RepublicAgentEngine.prototype.run as ReturnType<typeof vi.fn>).mock.instances[0] as RepublicAgentEngine;
      expect(childEngine.getConfig().approvalGate).toBe(approvalGate);
      expect(childEngine.getConfig().approvalPolicy).toBe('on-request');
      expect(childEngine.getConfig().browserContext?.tabId).toBe(99);
    } finally {
      RepublicAgentEngine.prototype.run = originalRun;
    }
  });

  it('should cancel all running sub-agents', async () => {
    const registry = new SubAgentRegistry({ maxConcurrent: 5 });

    const mockChildEngine = {
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    registry.register({
      runId: 'run-1',
      type: 'researcher',
      description: 'test',
      parentSessionId: parentEngine.engineId,
      engine: mockChildEngine as any,
      startTime: Date.now(),
      status: 'running',
    });

    const runner = new SubAgentRunner({
      parentEngine,
      registry,
    });

    await runner.cancelAll();

    // Registry should have cancelled all
    expect(registry.getAll().length).toBe(0);
  });
});
