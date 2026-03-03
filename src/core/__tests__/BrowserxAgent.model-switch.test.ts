/**
 * Unit Tests: BrowserxAgent - Model Switch (handleModelConfigChange)
 *
 * Covers the model switching behavior triggered by config-changed events:
 * 1. Model switch without active task applies immediately
 * 2. Model switch with active task stores pendingModelKey
 * 3. pendingModelKey is applied on next user submission (via processUserInputWithTask)
 * 4. Rapid switches A->B->C resolves to C (last write wins for pendingModelKey)
 * 5. Conversation history is NOT cleared on model switch
 *
 * All external modules are mocked so the tests are deterministic
 * and have no external side effects.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock instances - recreated in beforeEach for test isolation
// ---------------------------------------------------------------------------

let mockSessionInstance: Record<string, any>;
let mockToolRegistryInstance: Record<string, any>;
let mockModelClientFactoryInstance: Record<string, any>;
let mockUserNotifierInstance: Record<string, any>;
let mockApprovalManagerInstance: Record<string, any>;
let mockDiffTrackerInstance: Record<string, any>;
let mockTabManagerInstance: Record<string, any>;
let mockTurnContextInstance: Record<string, any>;
let uuidCounter: number;

// ---------------------------------------------------------------------------
// vi.mock() declarations
// These return factories that reference the shared mutable instances above.
// The actual mock implementations are assigned in beforeEach.
// ---------------------------------------------------------------------------

vi.mock('uuid', () => ({
  v4: () => `mock-uuid-${++uuidCounter}`,
}));

vi.mock('@/core/PromptLoader', () => ({
  loadPrompt: vi.fn(async () => 'base-instructions'),
  loadUserInstructions: vi.fn(async () => 'user-instructions'),
  isComposerConfigured: vi.fn(() => false),
  configurePromptComposer: vi.fn(),
}));

vi.mock('@/tools/registerPlatformTools', () => ({
  registerPlatformTools: vi.fn(async () => undefined),
}));

vi.mock('@/core/TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(() => mockTabManagerInstance),
  },
}));

vi.mock('@/core/tasks/RegularTask', () => ({
  RegularTask: vi.fn(() => ({})),
}));

vi.mock('@/core/TurnContext', () => ({
  TurnContext: vi.fn(() => mockTurnContextInstance),
}));

vi.mock('@/core/ApprovalManager', () => ({
  ApprovalManager: vi.fn(() => mockApprovalManagerInstance),
}));

vi.mock('@/core/DiffTracker', () => ({
  DiffTracker: vi.fn(() => mockDiffTrackerInstance),
}));

vi.mock('@/core/UserNotifier', () => ({
  UserNotifier: vi.fn(() => mockUserNotifierInstance),
}));

vi.mock('@/tools/ToolRegistry', () => ({
  ToolRegistry: vi.fn(() => mockToolRegistryInstance),
}));

vi.mock('@/core/models/ModelClientFactory', () => ({
  ModelClientFactory: vi.fn(() => mockModelClientFactoryInstance),
}));

vi.mock('@/core/Session', () => ({
  Session: vi.fn(() => mockSessionInstance),
}));

// Declare __BUILD_MODE__ global so the constructor path for extension mode works
declare const __BUILD_MODE__: string;
(globalThis as any).__BUILD_MODE__ = 'extension';

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { RepublicAgent as BrowserxAgent } from '@/core/RepublicAgent';
import { AgentConfig } from '@/config/AgentConfig';
import { MessageRouter } from '@/core/MessageRouter';
import type { IConfigChangeEvent } from '@/config/types';

// ---------------------------------------------------------------------------
// Helper: create mock AgentConfig with working event emitter
// ---------------------------------------------------------------------------

function createMockConfig(): AgentConfig & {
  _handlers: Map<string, Set<(e: IConfigChangeEvent) => void>>;
  _emit: (event: IConfigChangeEvent) => void;
} {
  const handlers = new Map<string, Set<(e: IConfigChangeEvent) => void>>();

  const config = {
    getConfig: vi.fn().mockReturnValue({
      selectedModelKey: 'openai:gpt-5',
      tools: {},
    }),
    getModelByKey: vi.fn().mockReturnValue({
      model: {
        name: 'GPT-5',
        modelKey: 'gpt-5',
        supportsImage: true,
        contextWindow: 128000,
        maxOutputTokens: 16384,
      },
      provider: {
        id: 'openai',
        name: 'OpenAI',
      },
    }),
    getProviderApiKey: vi.fn().mockResolvedValue('sk-test-key-123'),
    getToolsConfig: vi.fn().mockReturnValue({}),
    on: vi.fn((event: string, handler: (e: IConfigChangeEvent) => void) => {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
    }),
    off: vi.fn(),
    updateToolsConfig: vi.fn(),
    _handlers: handlers,
    _emit: (event: IConfigChangeEvent) => {
      const eventHandlers = handlers.get('config-changed');
      if (eventHandlers) {
        eventHandlers.forEach(handler => handler(event));
      }
    },
  } as unknown as AgentConfig & {
    _handlers: Map<string, Set<(e: IConfigChangeEvent) => void>>;
    _emit: (event: IConfigChangeEvent) => void;
  };

  return config;
}

// ---------------------------------------------------------------------------
// Helper: create mock MessageRouter
// ---------------------------------------------------------------------------

function createMockRouter(): MessageRouter {
  return {
    updateState: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessageRouter;
}

// ---------------------------------------------------------------------------
// Helper: create a config-changed event for model switching
// ---------------------------------------------------------------------------

function makeModelChangeEvent(
  oldValue: string,
  newValue: string
): IConfigChangeEvent {
  return {
    type: 'config-changed',
    section: 'model',
    oldValue,
    newValue,
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helper: create a mock model client with an identifying label
// ---------------------------------------------------------------------------

function makeMockModelClient(label: string) {
  return {
    getModel: vi.fn().mockReturnValue(label),
    setModel: vi.fn(),
    getModelContextWindow: vi.fn().mockReturnValue(128000),
    _label: label,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('BrowserxAgent - handleModelConfigChange', () => {
  let config: ReturnType<typeof createMockConfig>;
  let router: MessageRouter;
  let agent: BrowserxAgent;

  beforeEach(() => {
    uuidCounter = 0;

    // Create a shared TurnContext mock with setModelClient tracking
    mockTurnContextInstance = {
      setUserInstructions: vi.fn(),
      setBaseInstructions: vi.fn(),
      setModelClient: vi.fn(),
      setSelectedModelKey: vi.fn(),
      getModelClient: vi.fn().mockReturnValue(makeMockModelClient('initial-model')),
      getSessionId: vi.fn(() => 'session-1'),
    };

    // Recreate shared mock instances before each test
    mockSessionInstance = {
      conversationId: 'conv-123',
      setEventEmitter: vi.fn(),
      setTurnContext: vi.fn(),
      getTurnContext: vi.fn().mockReturnValue(mockTurnContextInstance),
      updateTurnContext: vi.fn(),
      getTabId: vi.fn().mockReturnValue(-1),
      setTabId: vi.fn(),
      getId: vi.fn().mockReturnValue('session-id-1'),
      getConversationHistory: vi.fn().mockReturnValue({
        items: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi there' }] },
        ],
      }),
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
        tokensBefore: 5000,
        tokensAfter: 2000,
        itemsTrimmed: 10,
      }),
      getCompactionCount: vi.fn().mockReturnValue(1),
      getRunningTasks: vi.fn().mockReturnValue(new Map()),
    };

    mockToolRegistryInstance = {
      register: vi.fn(),
      getTool: vi.fn(),
      getAllTools: vi.fn().mockReturnValue([]),
      cleanup: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      setApprovalGate: vi.fn(),
    };

    mockModelClientFactoryInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      createClientForCurrentModel: vi.fn().mockResolvedValue(
        makeMockModelClient('default-model')
      ),
      isBackendRouting: vi.fn().mockReturnValue(false),
    };

    mockUserNotifierInstance = {
      onNotification: vi.fn(),
      processEvent: vi.fn(),
      notifyWarning: vi.fn().mockResolvedValue('notif-1'),
      notifyInfo: vi.fn().mockResolvedValue('notif-2'),
      notifyProgress: vi.fn().mockResolvedValue('notif-3'),
      updateProgress: vi.fn().mockResolvedValue(undefined),
      clearAll: vi.fn().mockResolvedValue(undefined),
    };

    mockApprovalManagerInstance = {
      getApproval: vi.fn(),
      createApproval: vi.fn(),
      resolveApproval: vi.fn(),
      handleDecision: vi.fn().mockResolvedValue(undefined),
    };

    mockDiffTrackerInstance = {
      addChange: vi.fn(),
      getChanges: vi.fn().mockReturnValue([]),
    };

    mockTabManagerInstance = {
      onTabClosure: vi.fn(),
      createTab: vi.fn().mockResolvedValue(100),
      validateTab: vi.fn().mockResolvedValue({ status: 'valid' }),
      addTabToGroup: vi.fn().mockResolvedValue(undefined),
      clearAllTabsFromGroup: vi.fn().mockResolvedValue(undefined),
    };

    config = createMockConfig();
    router = createMockRouter();
    agent = new BrowserxAgent(config as unknown as AgentConfig, router);
  });

  // =========================================================================
  // 1. Model switch without active task applies immediately
  // =========================================================================

  describe('Immediate switch (no active task)', () => {
    it('should create a new model client and update TurnContext when no task is running', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      const newClient = makeMockModelClient('new-model-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(newClient);

      // No running tasks (default mock returns empty Map)
      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));

      // handleModelConfigChange is async, give it time to resolve
      await vi.waitFor(() => {
        expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      });

      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledWith(newClient);
      expect(mockTurnContextInstance.setSelectedModelKey).toHaveBeenCalledWith('anthropic:claude-4');

      // Should emit a BackgroundEvent confirming the immediate switch
      const infoEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) =>
          call[0]?.msg?.type === 'BackgroundEvent' &&
          call[0]?.msg?.data?.level === 'info' &&
          call[0]?.msg?.data?.message?.includes('Model switched to anthropic:claude-4')
      );
      expect(infoEvent).toBeDefined();
    });

    it('should not call createClientForCurrentModel when oldValue equals newValue', async () => {
      config._emit(makeModelChangeEvent('openai:gpt-5', 'openai:gpt-5'));

      // Allow any pending microtasks
      await new Promise(r => setTimeout(r, 10));

      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();
    });

    it('should emit Error event when createClientForCurrentModel fails', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      mockModelClientFactoryInstance.createClientForCurrentModel.mockRejectedValueOnce(
        new Error('Provider unavailable')
      );

      config._emit(makeModelChangeEvent('openai:gpt-5', 'xai:grok-3'));

      await vi.waitFor(() => {
        expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      });

      // Wait for the async error handling
      await new Promise(r => setTimeout(r, 20));

      const errorEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) =>
          call[0]?.msg?.type === 'Error' &&
          call[0]?.msg?.data?.message?.includes('Failed to switch model')
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent![0].msg.data.message).toContain('Provider unavailable');
    });

    it('should not update TurnContext.setModelClient when createClientForCurrentModel fails', async () => {
      agent.setEventDispatcher(vi.fn());

      mockModelClientFactoryInstance.createClientForCurrentModel.mockRejectedValueOnce(
        new Error('Network error')
      );

      config._emit(makeModelChangeEvent('openai:gpt-5', 'xai:grok-3'));

      await new Promise(r => setTimeout(r, 20));

      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });

    it('should clear stale pendingModelKey when an immediate switch is applied', async () => {
      // Step 1: Defer a switch while a task is running
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      // Verify deferred (no client created)
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();

      // Step 2: Task completes, then a second model switch happens immediately
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      const xaiClient = makeMockModelClient('grok-3-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(xaiClient);

      config._emit(makeModelChangeEvent('anthropic:claude-4', 'xai:grok-3'));

      await vi.waitFor(() => {
        expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      });

      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledWith(xaiClient);

      // Step 3: Reset mocks and submit user input — the stale pendingModelKey should NOT trigger another switch
      mockModelClientFactoryInstance.createClientForCurrentModel.mockClear();
      mockTurnContextInstance.setModelClient.mockClear();
      mockTurnContextInstance.setSelectedModelKey.mockClear();

      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'test' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // No additional model switch should have been applied from the stale pending key
      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Model switch with active task stores pendingModelKey
  // =========================================================================

  describe('Deferred switch (task running)', () => {
    it('should store pendingModelKey instead of switching immediately when a task is running', async () => {
      // Simulate a running task
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));

      // Allow any pending microtasks
      await new Promise(r => setTimeout(r, 10));

      // Should NOT have called createClientForCurrentModel
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();
      // Should NOT have called setModelClient
      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });

    it('should emit a BackgroundEvent info message when deferring a model switch', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      // Simulate a running task
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));

      await new Promise(r => setTimeout(r, 10));

      const infoEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) =>
          call[0]?.msg?.type === 'BackgroundEvent' &&
          call[0]?.msg?.data?.level === 'info' &&
          call[0]?.msg?.data?.message?.includes('Model switch to anthropic:claude-4 will take effect after the current task completes')
      );
      expect(infoEvent).toBeDefined();
    });

    it('should not store pendingModelKey when oldValue equals newValue even with running tasks', async () => {
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'openai:gpt-5'));

      // Allow any pending microtasks
      await new Promise(r => setTimeout(r, 10));

      // Now clear running tasks and submit a user input to check pendingModelKey was not set
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      // Submit a user input - if pendingModelKey was stored, createClientForCurrentModel would be called
      // during processUserInputWithTask
      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'test' }],
      });
      await new Promise(r => setTimeout(r, 10));

      // createClientForCurrentModel should only be called once (for the user input tab handling, NOT for pendingModelKey)
      // Actually with no pending model key, it should not be called at all from the pending path
      // The assertion is that setModelClient is not called from the pending model path
      // (it may be called during initialize(), but not from pendingModelKey application)
      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. pendingModelKey applied on next user submission
  // =========================================================================

  describe('Pending model key applied on submission', () => {
    it('should apply pending model switch when processUserInputWithTask is called', async () => {
      // Step 1: Set up a running task so the switch is deferred
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      // Verify no immediate switch happened
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();

      // Step 2: Clear running tasks (task completed)
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      // Step 3: Set up the new model client that will be created
      const pendingClient = makeMockModelClient('claude-4-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(pendingClient);

      // Step 4: Submit a new user input, which triggers processUserInputWithTask
      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Hello Claude' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // The pending model switch should have been applied
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledWith(pendingClient);
      expect(mockTurnContextInstance.setSelectedModelKey).toHaveBeenCalledWith('anthropic:claude-4');
    });

    it('should clear pendingModelKey after applying the switch', async () => {
      // Step 1: Defer a model switch
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Clear running tasks
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      // Step 3: First user submission - should apply pending model
      const pendingClient = makeMockModelClient('claude-4-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(pendingClient);

      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'First message' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // Reset mocks to track second submission
      mockModelClientFactoryInstance.createClientForCurrentModel.mockClear();
      mockTurnContextInstance.setModelClient.mockClear();

      // Step 4: Second user submission - should NOT apply pending model again
      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Second message' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // createClientForCurrentModel should not have been called for the pending model path
      // (it might be called for other reasons, but setModelClient from the pending path should not fire)
      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });

    it('should handle failure during pending model application gracefully', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      // Step 1: Defer a model switch
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Clear running tasks, but make client creation fail
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());
      mockModelClientFactoryInstance.createClientForCurrentModel.mockRejectedValueOnce(
        new Error('Rate limit exceeded')
      );

      // Step 3: Submit user input - pending model application should fail but not crash
      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Hello' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // The pending key should still be cleared (set to null) even on failure
      // Verify by submitting again - should NOT attempt another model switch
      mockModelClientFactoryInstance.createClientForCurrentModel.mockClear();
      mockTurnContextInstance.setModelClient.mockClear();

      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Hello again' }],
      });
      await new Promise(r => setTimeout(r, 20));

      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Rapid switches A->B->C resolves to C (last write wins)
  // =========================================================================

  describe('Rapid model switches (last write wins)', () => {
    it('should resolve A->B->C to C when all switches happen during a running task', async () => {
      // Simulate a running task
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      // Rapid switches: A -> B -> C
      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      config._emit(makeModelChangeEvent('anthropic:claude-4', 'xai:grok-3'));
      config._emit(makeModelChangeEvent('xai:grok-3', 'google:gemini-2'));

      await new Promise(r => setTimeout(r, 10));

      // No immediate switch should have happened
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();

      // Step 2: Clear running tasks
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      // The model client factory should create a client for the LAST model (google:gemini-2)
      const geminiClient = makeMockModelClient('gemini-2-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(geminiClient);

      // Step 3: Submit user input to trigger pending model application
      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Test' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // Should have created a client only once (for the final model)
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalledTimes(1);
      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledTimes(1);
      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledWith(geminiClient);
    });

    it('should apply only the last switch when alternating between models rapidly', async () => {
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      // Switch back and forth: A -> B -> A -> B
      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      config._emit(makeModelChangeEvent('anthropic:claude-4', 'openai:gpt-5'));
      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      config._emit(makeModelChangeEvent('anthropic:claude-4', 'openai:gpt-5'));

      await new Promise(r => setTimeout(r, 10));

      // Clear running tasks
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      const gpt5Client = makeMockModelClient('gpt-5-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(gpt5Client);

      // Submit user input
      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Test' }],
      });
      await new Promise(r => setTimeout(r, 20));

      // The last value was 'openai:gpt-5', so pendingModelKey should be 'openai:gpt-5'
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalledTimes(1);
      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledWith(gpt5Client);
    });

    it('should not create a client if rapid switches result in same-model no-op via early return', async () => {
      // No running tasks for immediate switches
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      // Switch to same model (triggers early return due to oldValue === newValue)
      config._emit(makeModelChangeEvent('openai:gpt-5', 'openai:gpt-5'));

      await new Promise(r => setTimeout(r, 10));

      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();
      expect(mockTurnContextInstance.setModelClient).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Conversation history is NOT cleared on model switch
  // =========================================================================

  describe('History preservation', () => {
    it('should NOT call session.clearHistory() when model is switched immediately', async () => {
      const newClient = makeMockModelClient('new-model');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(newClient);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));

      await vi.waitFor(() => {
        expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      });

      expect(mockSessionInstance.clearHistory).not.toHaveBeenCalled();
    });

    it('should NOT call session.clearHistory() when deferred model switch is applied', async () => {
      // Step 1: Defer a switch
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      // Step 2: Clear tasks and submit
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(
        makeMockModelClient('claude-4')
      );

      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Test' }],
      });
      await new Promise(r => setTimeout(r, 20));

      expect(mockSessionInstance.clearHistory).not.toHaveBeenCalled();
    });

    it('should preserve existing conversation history items after model switch', async () => {
      const historyBefore = mockSessionInstance.getConversationHistory();

      const newClient = makeMockModelClient('new-model');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(newClient);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));

      await vi.waitFor(() => {
        expect(mockTurnContextInstance.setModelClient).toHaveBeenCalled();
      });

      const historyAfter = mockSessionInstance.getConversationHistory();

      // History should remain exactly the same
      expect(historyAfter.items).toEqual(historyBefore.items);
      expect(historyAfter.items.length).toBe(2);
    });

    it('should NOT call session.clearHistory() even after multiple rapid switches', async () => {
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      const clients = ['client-a', 'client-b', 'client-c'].map(label =>
        makeMockModelClient(label)
      );

      // Queue up sequential resolved clients
      mockModelClientFactoryInstance.createClientForCurrentModel
        .mockResolvedValueOnce(clients[0])
        .mockResolvedValueOnce(clients[1])
        .mockResolvedValueOnce(clients[2]);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      config._emit(makeModelChangeEvent('anthropic:claude-4', 'xai:grok-3'));
      await new Promise(r => setTimeout(r, 10));

      config._emit(makeModelChangeEvent('xai:grok-3', 'google:gemini-2'));
      await new Promise(r => setTimeout(r, 10));

      // clearHistory should never have been called
      expect(mockSessionInstance.clearHistory).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('Edge cases', () => {
    it('should ignore config-changed events with non-model section', async () => {
      // Emit a non-model config change - the handler should not fire
      const handlers = config._handlers.get('config-changed');
      expect(handlers).toBeDefined();
      expect(handlers!.size).toBeGreaterThan(0);

      // Emit a provider change
      config._emit({
        type: 'config-changed',
        section: 'provider',
        oldValue: null,
        newValue: { id: 'new-provider' },
        timestamp: Date.now(),
      });

      await new Promise(r => setTimeout(r, 10));

      // Should not have called createClientForCurrentModel
      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();
    });

    it('should subscribe to config-changed event during construction', () => {
      expect(config.on).toHaveBeenCalledWith('config-changed', expect.any(Function));
    });

    it('should handle the case where getRunningTasks transitions from populated to empty between events', async () => {
      // First switch: task is running -> deferred
      const runningTasksMap = new Map([['task-1', { id: 'task-1' }]]);
      mockSessionInstance.getRunningTasks.mockReturnValue(runningTasksMap);

      config._emit(makeModelChangeEvent('openai:gpt-5', 'anthropic:claude-4'));
      await new Promise(r => setTimeout(r, 10));

      expect(mockModelClientFactoryInstance.createClientForCurrentModel).not.toHaveBeenCalled();

      // Second switch: task completed -> immediate
      mockSessionInstance.getRunningTasks.mockReturnValue(new Map());

      const xaiClient = makeMockModelClient('grok-3-client');
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValueOnce(xaiClient);

      config._emit(makeModelChangeEvent('anthropic:claude-4', 'xai:grok-3'));

      await vi.waitFor(() => {
        expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      });

      // The second switch should apply immediately (overwriting the pending key implicitly)
      expect(mockTurnContextInstance.setModelClient).toHaveBeenCalledWith(xaiClient);
    });
  });
});
