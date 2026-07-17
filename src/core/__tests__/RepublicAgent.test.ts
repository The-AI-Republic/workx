/**
 * Unit Tests: RepublicAgent
 *
 * Covers the public API of RepublicAgent with fully mocked dependencies.
 * All external modules (AgentConfig, Session, ModelClientFactory, ToolRegistry,
 * UserNotifier, ApprovalManager, DiffTracker, TurnContext,
 * RegularTask, PromptLoader, registerPlatformTools, TabManager) are mocked
 * so the tests are deterministic and have no external side effects.
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
let mockPlatformAdapter: Record<string, any>;
let mockEngineInstance: Record<string, any>;
let mockPromptLoader: Record<string, any>;
let uuidCounter: number;

// ---------------------------------------------------------------------------
// vi.mock() declarations
// These return factories that reference the shared mutable instances above.
// The actual mock implementations are assigned in beforeEach.
// ---------------------------------------------------------------------------

vi.mock('uuid', () => ({
  v4: () => `mock-uuid-${++uuidCounter}`,
}));

vi.mock('../PromptLoader', () => ({
  createPromptLoader: vi.fn(() => mockPromptLoader),
  loadUserInstructions: vi.fn(async () => 'user-instructions'),
}));

vi.mock('../../tools/registerPlatformTools', () => ({
  registerPlatformTools: vi.fn(async () => undefined),
}));


vi.mock('../tasks/RegularTask', () => ({
  RegularTask: vi.fn(() => ({})),
}));

vi.mock('../engine/RepublicAgentEngine', () => ({
  RepublicAgentEngine: vi.fn(() => mockEngineInstance),
}));

vi.mock('../../tools/MemoryTools', () => ({
  registerMemoryTools: vi.fn(async () => undefined),
}));

vi.mock('../TurnContext', () => ({
  TurnContext: vi.fn(() => ({
    setUserInstructions: vi.fn(),
    setBaseInstructions: vi.fn(),
    getSessionId: vi.fn(() => 'session-1'),
    getAgentMode: vi.fn(() => 'general'),
    setAgentMode: vi.fn(),
  })),
}));

vi.mock('../ApprovalManager', () => ({
  ApprovalManager: vi.fn(() => mockApprovalManagerInstance),
}));

vi.mock('../DiffTracker', () => ({
  DiffTracker: vi.fn(() => mockDiffTrackerInstance),
}));

vi.mock('../UserNotifier', () => ({
  UserNotifier: vi.fn(() => mockUserNotifierInstance),
}));

vi.mock('../../tools/ToolRegistry', () => ({
  ToolRegistry: vi.fn(() => mockToolRegistryInstance),
}));

vi.mock('../models/ModelClientFactory', () => ({
  ModelClientFactory: vi.fn(() => mockModelClientFactoryInstance),
}));

vi.mock('../Session', () => ({
  Session: vi.fn(() => mockSessionInstance),
}));

// Declare __BUILD_MODE__ global so the constructor path for extension mode works
declare const __BUILD_MODE__: string;
(globalThis as any).__BUILD_MODE__ = 'extension';

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { RepublicAgent } from '../RepublicAgent';
import { AgentConfig } from '../../config/AgentConfig';
import { ModelClientFactory } from '../models/ModelClientFactory';
import { Session } from '../Session';
import type { Op } from '../protocol/types';

// ---------------------------------------------------------------------------
// Helper: create mock AgentConfig (plain object, not through vi.mock)
// ---------------------------------------------------------------------------

function createMockConfig(): AgentConfig {
  return {
    getConfig: vi.fn().mockReturnValue({
      selectedModelKey: 'openai:gpt-5',
      tools: {},
    }),
    getModelByKey: vi.fn().mockReturnValue({
      model: {
        name: 'GPT-5',
        key: 'gpt-5',
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
    getProvider: vi.fn().mockReturnValue({ id: 'openai', name: 'OpenAI' }),
    getToolsConfig: vi.fn().mockReturnValue({}),
    on: vi.fn(),
    off: vi.fn(),
    updateToolsConfig: vi.fn(),
  } as unknown as AgentConfig;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('RepublicAgent', () => {
  let config: AgentConfig;
  let agent: RepublicAgent;

  beforeEach(() => {
    uuidCounter = 0;

    // Recreate shared mock instances before each test
    mockSessionInstance = {
      sessionId: 'conv-123',
      setPromptLoader: vi.fn(),
      setEventEmitter: vi.fn(),
      setHookDispatcher: vi.fn(),
      getHookDispatcher: vi.fn().mockReturnValue(null),
      setTurnContext: vi.fn(),
      getTurnContext: vi.fn().mockReturnValue({
        setUserInstructions: vi.fn(),
        setBaseInstructions: vi.fn(),
        setModelClient: vi.fn(),
        setSelectedModelKey: vi.fn(),
        getAgentMode: vi.fn(() => 'general'),
        setAgentMode: vi.fn(),
      }),
      updateTurnContext: vi.fn(),
      getTabId: vi.fn().mockReturnValue(-1),
      setTabId: vi.fn(),
      getId: vi.fn().mockReturnValue('session-id-1'),
      getSessionId: vi.fn().mockReturnValue('conv-123'),
      getAgentMode: vi.fn().mockReturnValue('general'),
      setAgentMode: vi.fn(),
      getConversationHistory: vi.fn().mockReturnValue({ items: [] }),
      addPendingInput: vi.fn(),
      spawnTask: vi.fn().mockResolvedValue(undefined),
      requestInterrupt: vi.fn(),
      clearInterrupt: vi.fn(),
      abortAllTasks: vi.fn().mockResolvedValue(undefined),
      // Track 04: per-task abort path
      abortTask: vi.fn().mockResolvedValue(undefined),
      hasRunningTask: vi.fn().mockReturnValue(false),
      getRunningTasks: vi.fn().mockReturnValue(new Map()),
      hasLiveBackgroundWork: vi.fn().mockReturnValue(false),
      beginLifecycleWork: vi.fn().mockReturnValue({
        token: 'lease-1',
        signal: new AbortController().signal,
        finish: vi.fn(),
      }),
      trackLifecycleWork: vi.fn((_lease, work) => work),
      addToHistory: vi.fn(),
      getHistoryEntry: vi.fn(),
      clearHistory: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      refreshMemoryService: vi.fn().mockResolvedValue(undefined),
      // Track 05b: session-summary hook accessors
      setSessionSummaryHook: vi.fn(),
      getSessionSummaryHook: vi.fn().mockReturnValue(null),
      registerPostTurnHook: vi.fn().mockReturnValue(() => undefined),
      initialize: vi.fn().mockResolvedValue(undefined),
      initializeSession: vi.fn().mockResolvedValue(undefined),
      notifyApproval: vi.fn(),
      compact: vi.fn().mockResolvedValue({
        success: true,
        tokensBefore: 5000,
        tokensAfter: 2000,
        itemsTrimmed: 10,
      }),
      getCompactionCount: vi.fn().mockReturnValue(1),
      getDefaultModel: vi.fn().mockReturnValue('test-model'),
      getDefaultCwd: vi.fn().mockReturnValue('/'),
      isStorageEnabled: vi.fn().mockReturnValue(true),
      getMemoryService: vi.fn().mockReturnValue(null),
    };

    mockToolRegistryInstance = {
      register: vi.fn(),
      unregister: vi.fn().mockResolvedValue(undefined),
      getTool: vi.fn().mockReturnValue(null),
      getAllTools: vi.fn().mockReturnValue([]),
      cleanup: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      setApprovalGate: vi.fn(),
      getApprovalGate: vi.fn().mockReturnValue(undefined),
    };

    mockModelClientFactoryInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      createClientForCurrentModel: vi.fn().mockResolvedValue({
        getModel: vi.fn().mockReturnValue('test-model'),
        setModel: vi.fn(),
        getModelContextWindow: vi.fn().mockReturnValue(8192),
      }),
      clearCache: vi.fn(),
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
    };

    mockDiffTrackerInstance = {
      addChange: vi.fn(),
      getChanges: vi.fn().mockReturnValue([]),
    };

    mockPlatformAdapter = {
      platformId: 'extension',
      hasRealTabs: true,
      hasBrowserTools: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      createTab: vi.fn().mockResolvedValue(100),
      closeTab: vi.fn().mockResolvedValue(undefined),
      validateTab: vi.fn().mockResolvedValue({ valid: true }),
      switchTab: vi.fn().mockResolvedValue(undefined),
      getBrowserController: vi.fn().mockResolvedValue(null),
      registerPlatformTools: vi.fn().mockResolvedValue(undefined),
      getConfigStorage: vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn() }),
      getCredentialStore: vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
      getStorageProvider: vi.fn().mockReturnValue({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }),
      createScheduler: vi.fn().mockReturnValue({ schedule: vi.fn(), cancel: vi.fn() }),
      dispose: vi.fn().mockResolvedValue(undefined),
    };

    mockEngineInstance = {
      initialize: vi.fn().mockResolvedValue(undefined),
      submitOperation: vi.fn().mockReturnValue('engine-sub-1'),
      submitTrackedOperation: vi.fn().mockReturnValue({
        submissionId: 'engine-tracked-1',
        settled: Promise.resolve({ outcome: 'completed' }),
        cancel: vi.fn(),
      }),
      onEvent: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(mockSessionInstance),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistryInstance),
      isReady: vi.fn().mockReturnValue(true),
      isDisposed: vi.fn().mockReturnValue(false),
    };

    mockPromptLoader = {
      load: vi.fn().mockResolvedValue('base-instructions'),
      supportsMode: vi.fn().mockReturnValue(true),
      registerExtension: vi.fn().mockReturnValue(vi.fn()),
      dispose: vi.fn(),
    };

    config = createMockConfig();
    agent = new RepublicAgent(config, mockPlatformAdapter as any, undefined, undefined, mockUserNotifierInstance as any);
  });

  // =========================================================================
  // Constructor & Initialization
  // =========================================================================

  describe('Constructor and initialization', () => {
    it('should generate a unique agentId when none is provided', () => {
      expect(agent.agentId).toMatch(/^agent_mock-uuid-\d+$/);
    });

    it('should use the provided agentId when one is supplied', () => {
      const custom = new RepublicAgent(config, mockPlatformAdapter as any, undefined, 'my-agent');
      expect(custom.agentId).toBe('my-agent');
    });

    it('should expose the session via getSession()', () => {
      const session = agent.getSession();
      expect(session).toBeDefined();
      expect(session.sessionId).toBe('conv-123');
    });

    it('should expose the tool registry via getToolRegistry()', () => {
      const registry = agent.getToolRegistry();
      expect(registry).toBeDefined();
      expect(registry.cleanup).toBeDefined();
    });

    it('should expose the approval manager via getApprovalManager()', () => {
      const approvalMgr = agent.getApprovalManager();
      expect(approvalMgr).toBeDefined();
      expect(approvalMgr.getApproval).toBeDefined();
    });

    it('should expose the model client factory via getModelClientFactory()', () => {
      const factory = agent.getModelClientFactory();
      expect(factory).toBeDefined();
      expect(factory.initialize).toBeDefined();
    });

    it('should expose the user notifier via getUserNotifier()', () => {
      const notifier = agent.getUserNotifier();
      expect(notifier).toBeDefined();
      expect(notifier.notifyInfo).toBeDefined();
    });

    it('passes supplied SessionServices to Session construction', () => {
      const services = {
        rollout: null,
        notifier: { notify: vi.fn(), error: vi.fn(), success: vi.fn() },
        showRawAgentReasoning: false,
      };

      new RepublicAgent(
        config,
        mockPlatformAdapter as any,
        undefined,
        'with-services',
        mockUserNotifierInstance as any,
        services as any,
      );

      expect(Session).toHaveBeenLastCalledWith(
        config,
        true,
        services,
        mockToolRegistryInstance,
        undefined,
      );
    });

    it('should wire up session event emitter during construction', () => {
      const session = agent.getSession();
      expect(session.setEventEmitter).toHaveBeenCalledTimes(1);
      expect(session.setEventEmitter).toHaveBeenCalledWith(expect.any(Function));
    });

    it('does not subscribe directly to config changes', async () => {
      expect(config.on as Mock).not.toHaveBeenCalledWith('config-changed', expect.any(Function));
      await agent.initialize();
      expect(config.on as Mock).not.toHaveBeenCalledWith('config-changed', expect.any(Function));
    });
  });

  // =========================================================================
  // initialize()
  // =========================================================================

  describe('initialize()', () => {
    it('should initialize the model client factory with config', async () => {
      await agent.initialize();
      expect(mockModelClientFactoryInstance.initialize).toHaveBeenCalledWith(config);
    });

    it('should throw when the selected model key is not found', async () => {
      (config.getModelByKey as Mock).mockReturnValue(null);
      await expect(agent.initialize()).rejects.toThrow('Selected model openai:gpt-5 not found');
    });

    it('routes the model factory missing-key callback through the agent dispatcher', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);
      const factoryCalls = vi.mocked(ModelClientFactory).mock.calls;
      const options = factoryCalls[factoryCalls.length - 1]?.[0] as {
        onMissingKey?: (providerId: string) => void;
      };
      options.onMissingKey?.('openai');

      const warningEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'BackgroundEvent' &&
          call[0]?.msg?.data?.level === 'warning'
      );
      expect(warningEvent).toBeDefined();
    });

    it('should skip API key validation when using backend routing', async () => {
      mockModelClientFactoryInstance.isBackendRouting.mockReturnValue(true);

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.initialize();

      const warningEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'BackgroundEvent' &&
          call[0]?.msg?.data?.message?.includes('No API key configured')
      );
      expect(warningEvent).toBeUndefined();
    });

    it('should set the turn context on the session', async () => {
      await agent.initialize();
      expect(mockSessionInstance.setTurnContext).toHaveBeenCalled();
    });

    // ─── Track 05b: session-summary hook wiring ────────────────────────────
    describe('syncSessionSummaryHook', () => {
      it('does NOT construct a hook when preferences.sessionSummaryEnabled is false', async () => {
        // Default mock has the flag absent → defaults to false
        await agent.initialize();
        expect(mockSessionInstance.setSessionSummaryHook).not.toHaveBeenCalled();
      });

      it('detaches an existing hook when the flag flips off', async () => {
        const existingHook = { detach: vi.fn() };
        mockSessionInstance.getSessionSummaryHook.mockReturnValue(existingHook);

        await agent.initialize();

        expect(existingHook.detach).toHaveBeenCalledTimes(1);
        expect(mockSessionInstance.setSessionSummaryHook).toHaveBeenCalledWith(null);
      });

      it('does not crash when build mode is not desktop/server (extension build)', async () => {
        // The default test env defines __BUILD_MODE__ via vitest config or a
        // global; the function gracefully returns early on extension builds.
        // Either path is acceptable — this assertion just guards against an
        // unhandled rejection from syncSessionSummaryHook.
        (config.getConfig as Mock).mockReturnValue({
          ...((config.getConfig as Mock)() as Record<string, unknown>),
          preferences: { sessionSummaryEnabled: true },
        });

        await expect(agent.initialize()).resolves.toBeUndefined();
      });
    });
  });

  // =========================================================================
  // submitOperation()
  // =========================================================================

  describe('submitOperation()', () => {
    it('should return an incremental submission id', async () => {
      const id1 = await agent.submitOperation({ type: 'GetPath' });
      const id2 = await agent.submitOperation({ type: 'GetPath' });

      expect(id1).toMatch(/^sub_\d+$/);
      expect(id2).toMatch(/^sub_\d+$/);
      expect(id1).not.toBe(id2);
    });

    it('should process a Shutdown op by disposing the engine', async () => {
      await agent.initialize();

      await agent.submitOperation({ type: 'Shutdown' });
      await new Promise(r => setTimeout(r, 0));

      // Shutdown now goes straight to dispose(); we no longer also submit a
      // separate Shutdown op (that double-handles teardown).
      expect(mockEngineInstance.dispose).toHaveBeenCalled();
      expect(mockEngineInstance.submitOperation).not.toHaveBeenCalledWith({ type: 'Shutdown' });
    });

    it('should process a GetPath op and emit ConversationPath', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      const pathEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'ConversationPath'
      );
      expect(pathEvent).toBeDefined();
      expect(pathEvent![0].msg.data.path).toBe('conv-123');
    });

    it('should no-op SetSessionMode when requested mode is already active', async () => {
      await agent.initialize();
      mockPromptLoader.load.mockClear();
      mockSessionInstance.setAgentMode.mockClear();

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'SetSessionMode', mode: 'general' });
      await new Promise(r => setTimeout(r, 0));

      const modeEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'ModeChanged'
      );
      expect(modeEvent?.[0].msg.data).toEqual({
        sessionId: 'session-id-1',
        mode: 'general',
        applied: true,
      });
      expect(mockSessionInstance.setAgentMode).not.toHaveBeenCalled();
      expect(mockPromptLoader.load).not.toHaveBeenCalled();
    });

    it('should defer SetSessionMode while a task is running and apply it on next user input', async () => {
      await agent.initialize();
      const turnContext = mockSessionInstance.getTurnContext();
      mockPromptLoader.load.mockClear();
      mockSessionInstance.setAgentMode.mockClear();
      turnContext.setAgentMode.mockClear();
      turnContext.setBaseInstructions.mockClear();

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      mockSessionInstance.hasLiveBackgroundWork.mockReturnValue(true);

      await agent.submitOperation({ type: 'SetSessionMode', mode: 'code' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.setAgentMode).not.toHaveBeenCalled();
      expect(dispatcherSpy.mock.calls.some(
        (call: any[]) =>
          call[0]?.msg?.type === 'ModeChanged' &&
          call[0]?.msg?.data?.mode === 'code' &&
          call[0]?.msg?.data?.applied === false
      )).toBe(true);

      mockSessionInstance.hasLiveBackgroundWork.mockReturnValue(false);

      await agent.submitOperation({
        type: 'UserInput',
        items: [{ type: 'text', text: 'apply the pending mode' }],
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.setAgentMode).toHaveBeenCalledWith('code');
      expect(turnContext.setAgentMode).toHaveBeenCalledWith('code');
      expect(mockPromptLoader.load).toHaveBeenCalledWith(
        'code',
        expect.objectContaining({ sessionId: 'conv-123' }),
      );
      expect(turnContext.setBaseInstructions).toHaveBeenCalledWith('base-instructions');
      expect(dispatcherSpy.mock.calls.some(
        (call: any[]) =>
          call[0]?.msg?.type === 'ModeChanged' &&
          call[0]?.msg?.data?.mode === 'code' &&
          call[0]?.msg?.data?.applied === true
      )).toBe(true);
    });

    it('should process an AddToHistory op and delegate to engine', async () => {
      await agent.initialize();

      await agent.submitOperation({
        type: 'AddToHistory',
        text: 'Hello world',
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith({
        type: 'AddToHistory',
        text: 'Hello world',
      });
    });

    it('should emit AgentMessage for unimplemented op types', async () => {
      await agent.initialize();
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({
        type: 'Review',
        review_request: { id: 'r1', content: 'test' },
      } as Op);
      await new Promise(r => setTimeout(r, 0));

      const agentMsg = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'AgentMessage'
      );
      expect(agentMsg).toBeDefined();
      expect(agentMsg![0].msg.data.message).toContain('not yet implemented');
    });

    it('should process ExecApproval and delegate to engine', async () => {
      await agent.initialize();

      await agent.submitOperation({
        type: 'ExecApproval',
        id: 'exec-1',
        decision: 'approve',
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith({
        type: 'ExecApproval',
        callId: 'exec-1',
        decision: 'approve',
        remember: undefined,
        alternativeText: undefined,
      });
    });

    it('should process PatchApproval and delegate to engine', async () => {
      await agent.initialize();

      await agent.submitOperation({
        type: 'PatchApproval',
        id: 'patch-1',
        decision: 'reject',
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith({
        type: 'PatchApproval',
        patchId: 'patch-1',
        decision: 'reject',
      });
    });

    it('should process Interrupt op and delegate to engine', async () => {
      await agent.initialize();

      await agent.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockUserNotifierInstance.notifyWarning).toHaveBeenCalledWith(
        'Task Interrupted',
        'The current task has been interrupted by user request'
      );
      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith({
        type: 'Interrupt',
        reason: 'user_interrupt',
      });
    });

    it('should emit Error event when processing a submission that throws', async () => {
      await agent.initialize();
      mockEngineInstance.submitOperation.mockImplementation(() => {
        throw new Error('engine failure');
      });

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'AddToHistory', text: 'fail' });
      await new Promise(r => setTimeout(r, 0));

      const turnAbortedEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'TurnAborted'
      );
      expect(turnAbortedEvent).toBeDefined();
      expect(turnAbortedEvent![0].msg.data.reason).toBe('error');

      const errorEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'Error'
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent![0].msg.data.message).toContain('engine failure');
    });

    it('should process multiple submissions sequentially', async () => {
      await agent.initialize();

      await agent.submitOperation({ type: 'AddToHistory', text: 'first' });
      await agent.submitOperation({ type: 'AddToHistory', text: 'second' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'AddToHistory', text: 'first' })
      );
      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'AddToHistory', text: 'second' })
      );
    });

    it('should include messages_count in ConversationPath event', async () => {
      mockSessionInstance.getConversationHistory.mockReturnValue({
        items: [{ type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      });

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      const pathEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'ConversationPath'
      );
      expect(pathEvent).toBeDefined();
      expect(pathEvent![0].msg.data.messages_count).toBe(1);
    });
  });

  // =========================================================================
  // cancelTask()
  // =========================================================================

  describe('cancelTask()', () => {
    it('should call session.abortTask with the specific submission id (Track 04)', async () => {
      mockSessionInstance.hasRunningTask.mockReturnValue(true);

      await agent.cancelTask('sub_1');

      expect(mockSessionInstance.hasRunningTask).toHaveBeenCalledWith('sub_1');
      // Track 04: per-task abort, not blanket abortAllTasks, so cancelling
      // task A doesn't kill unrelated background tasks.
      expect(mockSessionInstance.abortTask).toHaveBeenCalledWith('sub_1', 'UserInterrupt');
      expect(mockSessionInstance.abortAllTasks).not.toHaveBeenCalled();
    });

    it('should not call abortTask when no task is running for the given id', async () => {
      mockSessionInstance.hasRunningTask.mockReturnValue(false);

      await agent.cancelTask('sub_nonexistent');

      expect(mockSessionInstance.hasRunningTask).toHaveBeenCalledWith('sub_nonexistent');
      expect(mockSessionInstance.abortTask).not.toHaveBeenCalled();
      expect(mockSessionInstance.abortAllTasks).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // cleanup()
  // =========================================================================

  describe('cleanup()', () => {
    it('should call toolRegistry.cleanup() and toolRegistry.clear()', async () => {
      await agent.cleanup();

      expect(mockToolRegistryInstance.cleanup).toHaveBeenCalled();
      expect(mockToolRegistryInstance.clear).toHaveBeenCalled();
    });

    it('should call userNotifier.clearAll()', async () => {
      await agent.cleanup();

      expect(mockUserNotifierInstance.clearAll).toHaveBeenCalled();
    });

    it('disposes the session graph before its prompt loader', async () => {
      await agent.cleanup();

      expect(mockSessionInstance.dispose).toHaveBeenCalled();
      expect(mockSessionInstance.dispose.mock.invocationCallOrder[0]).toBeLessThan(
        mockPromptLoader.dispose.mock.invocationCallOrder[0],
      );
    });

    it('removes config hooks without owning the manager config subscription', async () => {
      await agent.initialize();
      await agent.cleanup();

      expect(config.off as Mock).not.toHaveBeenCalledWith('config-changed', expect.any(Function));
      expect(agent.getHookRegistry().getMatchingHooks('PreToolUse')).toHaveLength(0);
    });

  });

  // =========================================================================
  // isReady()
  // =========================================================================

  describe('isReady()', () => {
    it('should return ready=true with authMode=api_key when API key is configured', async () => {
      const result = await agent.isReady();

      expect(result.ready).toBe(true);
      expect(result.authMode).toBe('api_key');
      expect(result.provider).toBe('OpenAI');
      expect(result.model).toBe('GPT-5');
    });

    it('should return ready=true with authMode=login when using backend routing', async () => {
      mockModelClientFactoryInstance.isBackendRouting.mockReturnValue(true);

      const result = await agent.isReady();

      expect(result.ready).toBe(true);
      expect(result.authMode).toBe('login');
      expect(result.provider).toBe('OpenAI');
      expect(result.model).toBe('GPT-5');
    });

    it('should return ready=false when no API key is configured and not backend routing', async () => {
      (config.getProviderApiKey as Mock).mockResolvedValue('');

      const result = await agent.isReady();

      expect(result.ready).toBe(false);
      expect(result.authMode).toBe('api_key');
      expect(result.message).toContain('No API key configured');
    });

    it('should return ready=false when API key is whitespace only', async () => {
      (config.getProviderApiKey as Mock).mockResolvedValue('   ');

      const result = await agent.isReady();

      expect(result.ready).toBe(false);
      expect(result.authMode).toBe('api_key');
    });

    it('should return ready=false when API key is null', async () => {
      (config.getProviderApiKey as Mock).mockResolvedValue(null);

      const result = await agent.isReady();

      expect(result.ready).toBe(false);
      expect(result.authMode).toBe('api_key');
    });

    it('should return ready=false when the selected model is not found', async () => {
      (config.getModelByKey as Mock).mockReturnValue(null);

      const result = await agent.isReady();

      expect(result.ready).toBe(false);
      expect(result.authMode).toBe('none');
      expect(result.message).toContain('not found');
    });

    it('should return ready=false with error message when config throws', async () => {
      (config.getConfig as Mock).mockImplementation(() => {
        throw new Error('config corrupted');
      });

      const result = await agent.isReady();

      expect(result.ready).toBe(false);
      expect(result.authMode).toBe('none');
      expect(result.message).toBe('config corrupted');
    });
  });

  // =========================================================================
  // interrupt()
  // =========================================================================

  describe('interrupt()', () => {
    it('should call session.requestInterrupt()', async () => {
      await agent.initialize();

      await agent.interrupt();
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.requestInterrupt).toHaveBeenCalled();
    });

    it('should notify the user about the interruption', async () => {
      await agent.initialize();

      await agent.interrupt();
      await new Promise(r => setTimeout(r, 0));

      expect(mockUserNotifierInstance.notifyInfo).toHaveBeenCalledWith(
        'Interruption Requested',
        'The current task will be interrupted'
      );
    });

    it('should submit an Interrupt operation to the engine', async () => {
      await agent.initialize();
      agent.setEventDispatcher(vi.fn());

      await agent.interrupt();
      await new Promise(r => setTimeout(r, 10));

      expect(mockEngineInstance.submitOperation).toHaveBeenCalledWith({
        type: 'Interrupt',
        reason: 'user_interrupt',
      });
    });
  });

  // =========================================================================
  // setEventDispatcher()
  // =========================================================================

  describe('setEventDispatcher()', () => {
    it('should cause emitted events to be dispatched to the provided function', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      expect(dispatcherSpy).toHaveBeenCalled();
      const firstCall = dispatcherSpy.mock.calls[0][0];
      expect(firstCall).toHaveProperty('id');
      expect(firstCall).toHaveProperty('msg');
    });

    it('should not throw when no dispatcher is set and events are emitted', async () => {
      await expect(
        agent.submitOperation({ type: 'GetPath' })
      ).resolves.toBeDefined();
    });

    it('should catch errors thrown by the dispatcher without propagating', async () => {
      const badDispatcher = vi.fn(() => {
        throw new Error('dispatcher exploded');
      });
      agent.setEventDispatcher(badDispatcher);

      await expect(
        agent.submitOperation({ type: 'GetPath' })
      ).resolves.toBeDefined();
      await new Promise(r => setTimeout(r, 0));

      expect(badDispatcher).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // showProgress() / updateProgress()
  // =========================================================================

  describe('showProgress() and updateProgress()', () => {
    it('should delegate showProgress to userNotifier.notifyProgress', async () => {
      const id = await agent.showProgress('Downloading', 'Fetching data...', 3, 10);

      expect(mockUserNotifierInstance.notifyProgress).toHaveBeenCalledWith(
        'Downloading', 'Fetching data...', 3, 10
      );
      expect(id).toBe('notif-3');
    });

    it('should delegate updateProgress to userNotifier.updateProgress', async () => {
      await agent.updateProgress('notif-3', 7, 10);

      expect(mockUserNotifierInstance.updateProgress).toHaveBeenCalledWith('notif-3', 7, 10);
    });
  });

  describe('rebuildExecutionContext()', () => {
    it('should clear factory cache before creating new client', async () => {
      const callOrder: string[] = [];
      mockModelClientFactoryInstance.clearCache.mockImplementation(() => {
        callOrder.push('clearCache');
      });
      mockModelClientFactoryInstance.createClientForCurrentModel.mockImplementation(async () => {
        callOrder.push('createClientForCurrentModel');
        return { getModel: vi.fn().mockReturnValue('new-model') };
      });

      await agent.rebuildExecutionContext(new Set(['full']));

      expect(callOrder).toEqual(['clearCache', 'createClientForCurrentModel']);
    });

    it('should create new client via createClientForCurrentModel', async () => {
      await agent.rebuildExecutionContext(new Set(['full']));

      expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalledTimes(1);
    });

    it('should set new model client on existing TurnContext', async () => {
      const newMockClient = { getModel: vi.fn().mockReturnValue('swapped-model') };
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValue(newMockClient);

      await agent.rebuildExecutionContext(new Set(['full']));

      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setModelClient).toHaveBeenCalledWith(newMockClient);
    });

    it('should NOT call session.setTurnContext (no new TurnContext created)', async () => {
      await agent.rebuildExecutionContext(new Set(['full']));

      expect(mockSessionInstance.setTurnContext).not.toHaveBeenCalled();
    });

    it('should update selectedModelKey from config on TurnContext', async () => {
      (config.getConfig as Mock).mockReturnValue({
        selectedModelKey: 'anthropic:claude-3-opus',
        tools: {},
      });

      await agent.rebuildExecutionContext(new Set(['full']));

      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setSelectedModelKey).toHaveBeenCalledWith('anthropic:claude-3-opus');
    });

    it('should read config at call time (not stale)', async () => {
      // First call with original config
      await agent.rebuildExecutionContext(new Set(['full']));
      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setSelectedModelKey).toHaveBeenCalledWith('openai:gpt-5');

      // Change config
      (config.getConfig as Mock).mockReturnValue({
        selectedModelKey: 'google:gemini-2.0-flash',
        tools: {},
      });

      await agent.rebuildExecutionContext(new Set(['full']));
      expect(turnCtx.setSelectedModelKey).toHaveBeenCalledWith('google:gemini-2.0-flash');
    });

    it('should propagate errors from createClientForCurrentModel', async () => {
      mockModelClientFactoryInstance.createClientForCurrentModel.mockRejectedValue(
        new Error('auth expired')
      );

      await expect(agent.rebuildExecutionContext(new Set(['full']))).rejects.toThrow('auth expired');
      expect(mockSessionInstance.getTurnContext().setModelClient).not.toHaveBeenCalled();
    });

    it('should reload user instructions onto TurnContext', async () => {
      await agent.rebuildExecutionContext(new Set(['full']));

      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setUserInstructions).toHaveBeenCalledWith('user-instructions');
    });

    it('should reload base instructions onto TurnContext', async () => {
      await agent.rebuildExecutionContext(new Set(['full']));

      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setBaseInstructions).toHaveBeenCalledWith('base-instructions');
    });

    it('should refresh the memory service after hot-swapping the model client', async () => {
      await agent.rebuildExecutionContext(new Set(['full']));

      expect(mockSessionInstance.refreshMemoryService).toHaveBeenCalledWith(config);
    });

    it('should reuse the existing TurnContext', async () => {
      await agent.rebuildExecutionContext(new Set(['full']));
      expect(mockSessionInstance.setTurnContext).not.toHaveBeenCalled();
      expect(mockSessionInstance.getTurnContext().setModelClient).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Event dispatch behavior
  // =========================================================================

  describe('Event dispatch mechanics', () => {
    it('should assign unique, incrementing event IDs', async () => {
      const dispatcher = vi.fn();
      agent.setEventDispatcher(dispatcher);

      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      const events = dispatcher.mock.calls.map(([event]) => event);

      const ids = events.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      for (const id of ids) {
        expect(id).toMatch(/^evt_\d+$/);
      }
    });

    it('should process events through userNotifier.processEvent', async () => {
      agent.setEventDispatcher(vi.fn());

      // Use GetPath (orchestration op, no engine needed)
      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockUserNotifierInstance.processEvent).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Compact operations
  // =========================================================================

  describe('Compact operations', () => {
    it('should delegate Compact op to engine', async () => {
      await agent.initialize();

      await agent.submitOperation({ type: 'Compact' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockEngineInstance.submitTrackedOperation).toHaveBeenCalledWith({
        type: 'Compact',
        mode: 'auto',
      });
    });

    it('should delegate ManualCompact op to engine', async () => {
      await agent.initialize();

      await agent.submitOperation({ type: 'ManualCompact' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockEngineInstance.submitTrackedOperation).toHaveBeenCalledWith({
        type: 'ManualCompact',
      });
    });
  });

  // =========================================================================
  // GetHistoryEntryRequest
  // =========================================================================

  describe('GetHistoryEntryRequest', () => {
    it('should emit BackgroundEvent when history entry is found', async () => {
      mockSessionInstance.getHistoryEntry.mockReturnValue({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      });

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({
        type: 'GetHistoryEntryRequest',
        offset: 0,
        log_id: 1,
      });
      await new Promise(r => setTimeout(r, 0));

      const bgEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'BackgroundEvent' &&
          call[0]?.msg?.data?.message?.includes('History entry 0')
      );
      expect(bgEvent).toBeDefined();
    });

    it('should emit Error when history entry is not found', async () => {
      mockSessionInstance.getHistoryEntry.mockReturnValue(undefined);

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({
        type: 'GetHistoryEntryRequest',
        offset: 99,
        log_id: 2,
      });
      await new Promise(r => setTimeout(r, 0));

      const errorEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'Error' &&
          call[0]?.msg?.data?.message?.includes('History entry 99 not found')
      );
      expect(errorEvent).toBeDefined();
    });

    it('should emit Error when getHistoryEntry throws', async () => {
      mockSessionInstance.getHistoryEntry.mockImplementation(() => {
        throw new Error('history read error');
      });

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({
        type: 'GetHistoryEntryRequest',
        offset: 5,
        log_id: 3,
      });
      await new Promise(r => setTimeout(r, 0));

      const errorEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'Error' &&
          call[0]?.msg?.data?.message?.includes('history read error')
      );
      expect(errorEvent).toBeDefined();
    });
  });

  // =========================================================================
  // OverrideTurnContext
  // =========================================================================

  describe('OverrideTurnContext', () => {
    it('should delegate updates to session.updateTurnContext', async () => {
      await agent.submitOperation({
        type: 'OverrideTurnContext',
        model: 'new-model',
        effort: { effort: 'high' },
      } as Op);
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.updateTurnContext).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'new-model',
          effort: { effort: 'high' },
        })
      );
    });

    it('should only pass defined fields to updateTurnContext', async () => {
      await agent.submitOperation({
        type: 'OverrideTurnContext',
        model: 'my-model',
      } as Op);
      await new Promise(r => setTimeout(r, 0));

      const callArgs = mockSessionInstance.updateTurnContext.mock.calls[0][0];
      expect(callArgs).toHaveProperty('model', 'my-model');
      expect(callArgs).not.toHaveProperty('effort');
      expect(callArgs).not.toHaveProperty('tabId');
    });
  });
});
