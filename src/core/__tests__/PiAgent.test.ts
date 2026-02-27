/**
 * Unit Tests: PiAgent
 *
 * Covers the public API of PiAgent with fully mocked dependencies.
 * All external modules (AgentConfig, Session, ModelClientFactory, ToolRegistry,
 * MessageRouter, UserNotifier, ApprovalManager, DiffTracker, TurnContext,
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
let mockTabManagerInstance: Record<string, any>;
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
  loadPrompt: vi.fn(async () => 'base-instructions'),
  loadUserInstructions: vi.fn(async () => 'user-instructions'),
  isComposerConfigured: vi.fn(() => false),
  configurePromptComposer: vi.fn(),
}));

vi.mock('../../tools/registerPlatformTools', () => ({
  registerPlatformTools: vi.fn(async () => undefined),
}));

vi.mock('../TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(() => mockTabManagerInstance),
  },
}));

vi.mock('../tasks/RegularTask', () => ({
  RegularTask: vi.fn(() => ({})),
}));

vi.mock('../TurnContext', () => ({
  TurnContext: vi.fn(() => ({
    setUserInstructions: vi.fn(),
    setBaseInstructions: vi.fn(),
    getSessionId: vi.fn(() => 'session-1'),
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

import { PiAgent } from '../PiAgent';
import { AgentConfig } from '../../config/AgentConfig';
import { MessageRouter } from '../MessageRouter';
import type { Op } from '../protocol/types';
import type { Event } from '../protocol/events';

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
    getToolsConfig: vi.fn().mockReturnValue({}),
    on: vi.fn(),
    updateToolsConfig: vi.fn(),
  } as unknown as AgentConfig;
}

// ---------------------------------------------------------------------------
// Helper: create mock MessageRouter (plain object, not through vi.mock)
// ---------------------------------------------------------------------------

function createMockRouter(): MessageRouter {
  return {
    updateState: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  } as unknown as MessageRouter;
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('PiAgent', () => {
  let config: AgentConfig;
  let router: MessageRouter;
  let agent: PiAgent;

  beforeEach(() => {
    uuidCounter = 0;

    // Recreate shared mock instances before each test
    mockSessionInstance = {
      conversationId: 'conv-123',
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
        tokensBefore: 5000,
        tokensAfter: 2000,
        itemsTrimmed: 10,
      }),
      getCompactionCount: vi.fn().mockReturnValue(1),
      getDefaultModel: vi.fn().mockReturnValue('test-model'),
      getDefaultCwd: vi.fn().mockReturnValue('/'),
      isStorageEnabled: vi.fn().mockReturnValue(true),
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

    mockTabManagerInstance = {
      onTabClosure: vi.fn(),
      createTab: vi.fn().mockResolvedValue(100),
      validateTab: vi.fn().mockResolvedValue({ status: 'valid' }),
      addTabToGroup: vi.fn().mockResolvedValue(undefined),
      clearAllTabsFromGroup: vi.fn().mockResolvedValue(undefined),
    };

    config = createMockConfig();
    router = createMockRouter();
    agent = new PiAgent(config, router);
  });

  // =========================================================================
  // Constructor & Initialization
  // =========================================================================

  describe('Constructor and initialization', () => {
    it('should generate a unique agentId when none is provided', () => {
      expect(agent.agentId).toMatch(/^agent_mock-uuid-\d+$/);
    });

    it('should use the provided agentId when one is supplied', () => {
      const custom = new PiAgent(config, router, undefined, 'my-agent');
      expect(custom.agentId).toBe('my-agent');
    });

    it('should expose the session via getSession()', () => {
      const session = agent.getSession();
      expect(session).toBeDefined();
      expect(session.conversationId).toBe('conv-123');
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

    it('should expose the diff tracker via getDiffTracker()', () => {
      const dt = agent.getDiffTracker();
      expect(dt).toBeDefined();
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

    it('should wire up session event emitter during construction', () => {
      const session = agent.getSession();
      expect(session.setEventEmitter).toHaveBeenCalledTimes(1);
      expect(session.setEventEmitter).toHaveBeenCalledWith(expect.any(Function));
    });

    it('should subscribe to config-changed events during construction', () => {
      expect(config.on as Mock).toHaveBeenCalledWith('config-changed', expect.any(Function));
    });

    it('should set up notification handlers during construction', () => {
      const notifier = agent.getUserNotifier();
      expect(notifier.onNotification).toHaveBeenCalledWith(expect.any(Function));
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

    it('should emit a warning event when no API key is configured and not backend routing', async () => {
      (config.getProviderApiKey as Mock).mockResolvedValue('');
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.initialize();

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

    it('should process a Shutdown op and emit ShutdownComplete', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'Shutdown' });
      await new Promise(r => setTimeout(r, 0));

      const shutdownEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'ShutdownComplete'
      );
      expect(shutdownEvent).toBeDefined();
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

    it('should process an AddToHistory op and delegate to session', async () => {
      await agent.submitOperation({
        type: 'AddToHistory',
        text: 'Hello world',
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.addToHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Hello world',
          type: 'user',
        })
      );
    });

    it('should emit AgentMessage for unimplemented op types', async () => {
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

    it('should process ExecApproval and delegate to session.notifyApproval', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({
        type: 'ExecApproval',
        id: 'exec-1',
        decision: 'approve',
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.notifyApproval).toHaveBeenCalledWith('exec-1', 'approve');
    });

    it('should process PatchApproval and delegate to session.notifyApproval', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({
        type: 'PatchApproval',
        id: 'patch-1',
        decision: 'reject',
      });
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.notifyApproval).toHaveBeenCalledWith('patch-1', 'reject');
    });

    it('should process Interrupt op and abort all tasks', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'Interrupt' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.requestInterrupt).toHaveBeenCalled();
      expect(mockSessionInstance.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
      expect(mockSessionInstance.clearInterrupt).toHaveBeenCalled();

      const abortEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'TurnAborted'
      );
      expect(abortEvent).toBeDefined();
      expect(abortEvent![0].msg.data.reason).toBe('user_interrupt');
    });

    it('should emit Error event when processing a submission that throws', async () => {
      mockSessionInstance.addToHistory.mockImplementation(() => {
        throw new Error('storage failure');
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
      expect(errorEvent![0].msg.data.message).toContain('storage failure');
    });

    it('should process multiple submissions sequentially', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'AddToHistory', text: 'first' });
      await agent.submitOperation({ type: 'AddToHistory', text: 'second' });
      await new Promise(r => setTimeout(r, 10));

      expect(mockSessionInstance.addToHistory).toHaveBeenCalledTimes(2);
      expect(mockSessionInstance.addToHistory).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'first' })
      );
      expect(mockSessionInstance.addToHistory).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'second' })
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
  // getNextEvent()
  // =========================================================================

  describe('getNextEvent()', () => {
    it('should return null when the event queue is empty', async () => {
      const event = await agent.getNextEvent();
      expect(event).toBeNull();
    });

    it('should return events in FIFO order', async () => {
      agent.setEventDispatcher(vi.fn());

      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      const event1 = await agent.getNextEvent();
      expect(event1).not.toBeNull();
      expect(event1!.id).toMatch(/^evt_/);

      // Pop events until exhausted
      let count = 0;
      while (await agent.getNextEvent() !== null) {
        count++;
        if (count > 20) break; // Safety guard
      }

      const eventAfterDrain = await agent.getNextEvent();
      expect(eventAfterDrain).toBeNull();
    });

    it('should remove events from the queue once returned', async () => {
      agent.setEventDispatcher(vi.fn());

      await agent.submitOperation({ type: 'Shutdown' });
      await new Promise(r => setTimeout(r, 0));

      // Drain all events
      const events: Event[] = [];
      let evt: Event | null;
      while ((evt = await agent.getNextEvent()) !== null) {
        events.push(evt);
      }

      expect(events.length).toBeGreaterThan(0);

      // Queue should now be empty
      expect(await agent.getNextEvent()).toBeNull();
    });
  });

  // =========================================================================
  // cancelTask()
  // =========================================================================

  describe('cancelTask()', () => {
    it('should call session.abortAllTasks when the task is running', async () => {
      mockSessionInstance.hasRunningTask.mockReturnValue(true);

      await agent.cancelTask('sub_1');

      expect(mockSessionInstance.hasRunningTask).toHaveBeenCalledWith('sub_1');
      expect(mockSessionInstance.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
    });

    it('should not call abortAllTasks when no task is running for the given id', async () => {
      mockSessionInstance.hasRunningTask.mockReturnValue(false);

      await agent.cancelTask('sub_nonexistent');

      expect(mockSessionInstance.hasRunningTask).toHaveBeenCalledWith('sub_nonexistent');
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

    it('should clear submission and event queues', async () => {
      agent.setEventDispatcher(vi.fn());
      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      // Verify events exist before cleanup
      const beforeCleanup = await agent.getNextEvent();
      expect(beforeCleanup).not.toBeNull();

      await agent.cleanup();

      // After cleanup, event queue should be empty
      const afterCleanup = await agent.getNextEvent();
      expect(afterCleanup).toBeNull();
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
      await agent.interrupt();
      await new Promise(r => setTimeout(r, 0));

      expect(mockSessionInstance.requestInterrupt).toHaveBeenCalled();
    });

    it('should notify the user about the interruption', async () => {
      await agent.interrupt();
      await new Promise(r => setTimeout(r, 0));

      expect(mockUserNotifierInstance.notifyInfo).toHaveBeenCalledWith(
        'Interruption Requested',
        'The current task will be interrupted'
      );
    });

    it('should submit an Interrupt operation to the submission queue', async () => {
      agent.setEventDispatcher(vi.fn());

      await agent.interrupt();
      await new Promise(r => setTimeout(r, 10));

      // The Interrupt handler calls abortAllTasks
      expect(mockSessionInstance.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
    });

    it('should emit a TurnAborted event after interrupt processing', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.interrupt();
      await new Promise(r => setTimeout(r, 10));

      const abortedEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'TurnAborted'
      );
      expect(abortedEvent).toBeDefined();
      expect(abortedEvent![0].msg.data.reason).toBe('user_interrupt');
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

  // =========================================================================
  // refreshModelClient()
  // =========================================================================

  describe('refreshModelClient()', () => {
    it('should create a new model client and update the session turn context', async () => {
      await agent.refreshModelClient();

      expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalled();
      expect(mockSessionInstance.setTurnContext).toHaveBeenCalled();
    });

    it('should not throw if createClientForCurrentModel fails', async () => {
      mockModelClientFactoryInstance.createClientForCurrentModel.mockRejectedValue(
        new Error('network error')
      );

      // Should swallow the error
      await expect(agent.refreshModelClient()).resolves.toBeUndefined();
    });
  });

  // =========================================================================
  // hotSwapModelClient()
  // =========================================================================

  describe('hotSwapModelClient()', () => {
    it('should clear factory cache before creating new client', async () => {
      const callOrder: string[] = [];
      mockModelClientFactoryInstance.clearCache.mockImplementation(() => {
        callOrder.push('clearCache');
      });
      mockModelClientFactoryInstance.createClientForCurrentModel.mockImplementation(async () => {
        callOrder.push('createClientForCurrentModel');
        return { getModel: vi.fn().mockReturnValue('new-model') };
      });

      await agent.hotSwapModelClient();

      expect(callOrder).toEqual(['clearCache', 'createClientForCurrentModel']);
    });

    it('should create new client via createClientForCurrentModel', async () => {
      await agent.hotSwapModelClient();

      expect(mockModelClientFactoryInstance.createClientForCurrentModel).toHaveBeenCalledTimes(1);
    });

    it('should set new model client on existing TurnContext', async () => {
      const newMockClient = { getModel: vi.fn().mockReturnValue('swapped-model') };
      mockModelClientFactoryInstance.createClientForCurrentModel.mockResolvedValue(newMockClient);

      await agent.hotSwapModelClient();

      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setModelClient).toHaveBeenCalledWith(newMockClient);
    });

    it('should NOT call session.setTurnContext (no new TurnContext created)', async () => {
      await agent.hotSwapModelClient();

      expect(mockSessionInstance.setTurnContext).not.toHaveBeenCalled();
    });

    it('should update selectedModelKey from config on TurnContext', async () => {
      (config.getConfig as Mock).mockReturnValue({
        selectedModelKey: 'anthropic:claude-3-opus',
        tools: {},
      });

      await agent.hotSwapModelClient();

      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setSelectedModelKey).toHaveBeenCalledWith('anthropic:claude-3-opus');
    });

    it('should read config at call time (not stale)', async () => {
      // First call with original config
      await agent.hotSwapModelClient();
      const turnCtx = mockSessionInstance.getTurnContext();
      expect(turnCtx.setSelectedModelKey).toHaveBeenCalledWith('openai:gpt-5');

      // Change config
      (config.getConfig as Mock).mockReturnValue({
        selectedModelKey: 'google:gemini-2.0-flash',
        tools: {},
      });

      await agent.hotSwapModelClient();
      expect(turnCtx.setSelectedModelKey).toHaveBeenCalledWith('google:gemini-2.0-flash');
    });

    it('should propagate errors from createClientForCurrentModel', async () => {
      mockModelClientFactoryInstance.createClientForCurrentModel.mockRejectedValue(
        new Error('auth expired')
      );

      await expect(agent.hotSwapModelClient()).rejects.toThrow('auth expired');
    });

    it('should reuse existing TurnContext unlike refreshModelClient which creates a new one', async () => {
      // hotSwapModelClient: does NOT call session.setTurnContext
      await agent.hotSwapModelClient();
      expect(mockSessionInstance.setTurnContext).not.toHaveBeenCalled();
      expect(mockSessionInstance.getTurnContext().setModelClient).toHaveBeenCalled();

      // refreshModelClient: DOES call session.setTurnContext (creates new TurnContext)
      await agent.refreshModelClient();
      expect(mockSessionInstance.setTurnContext).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Event queue behavior
  // =========================================================================

  describe('Event queue mechanics', () => {
    it('should assign unique, incrementing event IDs', async () => {
      agent.setEventDispatcher(vi.fn());

      await agent.submitOperation({ type: 'GetPath' });
      await new Promise(r => setTimeout(r, 0));

      const events: Event[] = [];
      let evt: Event | null;
      while ((evt = await agent.getNextEvent()) !== null) {
        events.push(evt);
      }

      const ids = events.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      for (const id of ids) {
        expect(id).toMatch(/^evt_\d+$/);
      }
    });

    it('should process events through userNotifier.processEvent', async () => {
      agent.setEventDispatcher(vi.fn());

      await agent.submitOperation({ type: 'Shutdown' });
      await new Promise(r => setTimeout(r, 0));

      expect(mockUserNotifierInstance.processEvent).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Compact operations
  // =========================================================================

  describe('Compact operations', () => {
    it('should emit CompactionCompleted event for Compact op', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'Compact' });
      await new Promise(r => setTimeout(r, 0));

      const compactionEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'CompactionCompleted'
      );
      expect(compactionEvent).toBeDefined();
      expect(compactionEvent![0].msg.data.success).toBe(true);
      expect(compactionEvent![0].msg.data.triggerReason).toBe('auto');
    });

    it('should emit CompactionCompleted event for ManualCompact op', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'ManualCompact' });
      await new Promise(r => setTimeout(r, 0));

      const compactionEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'CompactionCompleted'
      );
      expect(compactionEvent).toBeDefined();
      expect(compactionEvent![0].msg.data.triggerReason).toBe('manual');
    });

    it('should emit Error event when compaction fails', async () => {
      mockSessionInstance.compact.mockRejectedValue(new Error('compaction failed'));

      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'Compact' });
      await new Promise(r => setTimeout(r, 0));

      const errorEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'Error' &&
          call[0]?.msg?.data?.message?.includes('compaction failed')
      );
      expect(errorEvent).toBeDefined();
    });

    it('should include compaction statistics in CompactionCompleted event', async () => {
      const dispatcherSpy = vi.fn();
      agent.setEventDispatcher(dispatcherSpy);

      await agent.submitOperation({ type: 'Compact' });
      await new Promise(r => setTimeout(r, 0));

      const compactionEvent = dispatcherSpy.mock.calls.find(
        (call: any[]) => call[0]?.msg?.type === 'CompactionCompleted'
      );
      expect(compactionEvent).toBeDefined();
      const data = compactionEvent![0].msg.data;
      expect(data.tokensBefore).toBe(5000);
      expect(data.tokensAfter).toBe(2000);
      expect(data.itemsTrimmed).toBe(10);
      expect(data.compactionCount).toBe(1);
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
