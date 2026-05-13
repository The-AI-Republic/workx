/**
 * Tests for AgentRegistry factory path (server/desktop mode)
 *
 * Validates that when `agentFactory` and `eventDispatcherFactory` are provided
 * in RegistryConfig, the registry uses them instead of the hardcoded Chrome
 * extension logic. Also validates that tab closure handling is skipped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';

// ---------------------------------------------------------------------------
// Mock RepublicAgent used by the extension (non-factory) path
// ---------------------------------------------------------------------------

vi.mock('@/core/RepublicAgent', () => ({
  RepublicAgent: class MockRepublicAgent {
    private _session = {
      sessionId: 'session_ext_' + Math.random().toString(36).slice(2),
      abortAllTasks: () => {},
      close: () => {},
      setTabId: () => {},
    };
    initialize = vi.fn().mockResolvedValue(undefined);
    getSession = vi.fn(() => this._session);
    submitOperation = vi.fn().mockResolvedValue('sub_ext');
    cleanup = vi.fn();
    setEventDispatcher = vi.fn();
    getApprovalManager = vi.fn().mockReturnValue({});
    getToolRegistry = vi.fn().mockReturnValue({ setApprovalGate: vi.fn() });
    getHookDispatcher = vi.fn().mockReturnValue({ fire: vi.fn().mockResolvedValue({}) });
    agentId = 'agent_ext';
  },
}));

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: { getInstance: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@/core/TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(() => ({
      onTabClosure: vi.fn(() => vi.fn()),
    })),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFactoryAgent() {
  const session = {
    sessionId: 'session_factory_' + Math.random().toString(36).slice(2),
    abortAllTasks: () => {},
    close: () => {},
    setTabId: () => {},
    initialize: vi.fn().mockResolvedValue(undefined),
  };
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    getSession: vi.fn(() => session),
    submitOperation: vi.fn().mockResolvedValue('sub_factory'),
    cleanup: vi.fn(),
    setEventDispatcher: vi.fn(),
    getApprovalManager: vi.fn().mockReturnValue({}),
    getToolRegistry: vi.fn().mockReturnValue({ setApprovalGate: vi.fn() }),
    getHookDispatcher: vi.fn().mockReturnValue({ fire: vi.fn().mockResolvedValue({}) }),
    agentId: 'agent_factory',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRegistry — factory path (server/desktop)', () => {
  let mockConfig: any;

  beforeEach(() => {
    AgentRegistry.resetInstance();
    vi.clearAllMocks();

    // Chrome mock for extension path tests
    Object.defineProperty(globalThis, 'chrome', {
      value: {
        runtime: { sendMessage: vi.fn(() => Promise.resolve(undefined)) },
      },
      writable: true,
    });

    mockConfig = {};
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  // =========================================================================
  // agentFactory
  // =========================================================================

  describe('agentFactory', () => {
    it('should use agentFactory to create agent instead of RepublicAgent constructor', async () => {
      const factoryAgent = createFactoryAgent();
      const agentFactory = vi.fn().mockResolvedValue(factoryAgent);

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
      });
      registry.initialize(mockConfig);

      const session = await registry.createSession({ type: 'scheduled' });

      expect(agentFactory).toHaveBeenCalledWith(mockConfig, undefined);
      expect(session.agent).toBe(factoryAgent);
    });

    it('should pass initialHistory to agentFactory when resume config is present', async () => {
      const factoryAgent = createFactoryAgent();
      const agentFactory = vi.fn().mockResolvedValue(factoryAgent);

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
      });
      registry.initialize(mockConfig);

      const resumeData = {
        sessionId: 'conv-123',
        rolloutItems: [{ type: 'event_msg', payload: {} }],
      };

      await registry.createSession({ type: 'primary', resume: resumeData });

      expect(agentFactory).toHaveBeenCalledWith(mockConfig, {
        mode: 'resumed',
        sessionId: 'conv-123',
        rolloutItems: [{ type: 'event_msg', payload: {} }],
      });
    });

    it('should not call agentFactory for extension path (no factory provided)', async () => {
      const registry = new AgentRegistry({ maxConcurrent: 3 });
      registry.initialize(mockConfig);

      const session = await registry.createSession({ type: 'primary' });

      // Agent should be created via the mocked RepublicAgent constructor (extension path)
      expect(session.agent).toBeDefined();
      expect((session.agent as any).agentId).toBe('agent_ext');
    });

    it('should propagate agentFactory errors', async () => {
      const agentFactory = vi.fn().mockRejectedValue(new Error('Factory init failed'));

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
      });
      registry.initialize(mockConfig);

      await expect(registry.createSession({ type: 'scheduled' })).rejects.toThrow(
        'Factory init failed'
      );
    });

    it('should create multiple sessions with separate factory calls', async () => {
      const agentFactory = vi.fn().mockImplementation(async () => createFactoryAgent());

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
      });
      registry.initialize(mockConfig);

      const s1 = await registry.createSession({ type: 'scheduled' });
      const s2 = await registry.createSession({ type: 'scheduled' });

      expect(agentFactory).toHaveBeenCalledTimes(2);
      expect(s1.agent).not.toBe(s2.agent); // Separate instances
    });
  });

  // =========================================================================
  // eventDispatcherFactory
  // =========================================================================

  describe('eventDispatcherFactory', () => {
    it('should wire event dispatcher per session via factory', async () => {
      const factoryAgent = createFactoryAgent();
      const agentFactory = vi.fn().mockResolvedValue(factoryAgent);
      const eventDispatcherFactory = vi.fn().mockReturnValue(vi.fn());

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
        eventDispatcherFactory,
      });
      registry.initialize(mockConfig);

      const session = await registry.createSession({ type: 'scheduled' });

      // Factory should be called with the session ID
      expect(eventDispatcherFactory).toHaveBeenCalledWith(session.sessionId);
      // Agent should have its event dispatcher set
      expect(factoryAgent.setEventDispatcher).toHaveBeenCalledWith(
        eventDispatcherFactory.mock.results[0].value
      );
    });

    it('should use extension event dispatcher when eventDispatcherFactory not provided', async () => {
      const factoryAgent = createFactoryAgent();
      const agentFactory = vi.fn().mockResolvedValue(factoryAgent);

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
        // No eventDispatcherFactory
      });
      registry.initialize(mockConfig);

      await registry.createSession({ type: 'scheduled' });

      // setEventDispatcher IS called even without eventDispatcherFactory (extension fallback path)
      expect(factoryAgent.setEventDispatcher).toHaveBeenCalled();
    });

    it('should create unique dispatchers per session', async () => {
      const dispatchers: any[] = [];
      const agentFactory = vi.fn().mockImplementation(async () => createFactoryAgent());
      const eventDispatcherFactory = vi.fn().mockImplementation((sessionId: string) => {
        const dispatcher = vi.fn();
        dispatchers.push({ sessionId, dispatcher });
        return dispatcher;
      });

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory,
        eventDispatcherFactory,
      });
      registry.initialize(mockConfig);

      const s1 = await registry.createSession({ type: 'scheduled' });
      const s2 = await registry.createSession({ type: 'scheduled' });

      expect(eventDispatcherFactory).toHaveBeenCalledTimes(2);
      expect(dispatchers[0].sessionId).toBe(s1.sessionId);
      expect(dispatchers[1].sessionId).toBe(s2.sessionId);
      expect(dispatchers[0].dispatcher).not.toBe(dispatchers[1].dispatcher);
    });
  });

  // =========================================================================
  // Tab closure handling skip
  // =========================================================================

  describe('tab closure handling', () => {
    it('should skip tab closure handling when agentFactory is provided', async () => {
      const { TabManager } = await import('@/core/TabManager');
      const onTabClosure = vi.fn(() => vi.fn());
      (TabManager.getInstance as any).mockReturnValue({ onTabClosure });

      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory: vi.fn().mockResolvedValue(createFactoryAgent()),
      });
      registry.initialize(mockConfig);

      await registry.createSession({ type: 'scheduled' });

      // TabManager.onTabClosure should NOT be called for factory path
      expect(onTabClosure).not.toHaveBeenCalled();
    });

    it('should set up tab closure handling for extension path (no factory)', async () => {
      const { TabManager } = await import('@/core/TabManager');
      const onTabClosure = vi.fn(() => vi.fn());
      (TabManager.getInstance as any).mockReturnValue({ onTabClosure });

      const registry = new AgentRegistry({ maxConcurrent: 3 });
      registry.initialize(mockConfig);

      await registry.createSession({ type: 'primary' });

      // TabManager.onTabClosure SHOULD be called for extension path
      expect(onTabClosure).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Session lifecycle with factory
  // =========================================================================

  describe('session lifecycle with factory', () => {
    it('should emit session:created event for factory-created sessions', async () => {
      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory: vi.fn().mockResolvedValue(createFactoryAgent()),
      });
      registry.initialize(mockConfig);

      const listener = vi.fn();
      registry.on(listener);

      const session = await registry.createSession({ type: 'scheduled' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session:created',
          sessionId: session.sessionId,
          sessionType: 'scheduled',
        })
      );
    });

    it('should remove factory-created sessions correctly', async () => {
      const registry = new AgentRegistry({
        maxConcurrent: 3,
        agentFactory: vi.fn().mockResolvedValue(createFactoryAgent()),
      });
      registry.initialize(mockConfig);

      const session = await registry.createSession({ type: 'scheduled' });
      expect(registry.getActiveCount()).toBe(1);

      await registry.removeSession(session.sessionId);
      expect(registry.getActiveCount()).toBe(0);
      expect(registry.getSession(session.sessionId)).toBeUndefined();
    });

    it('should respect maxConcurrent for factory-created sessions', async () => {
      const registry = new AgentRegistry({
        maxConcurrent: 1,
        agentFactory: vi.fn().mockResolvedValue(createFactoryAgent()),
      });
      registry.initialize(mockConfig);

      await registry.createSession({ type: 'scheduled' });

      await expect(
        registry.createSession({ type: 'scheduled' })
      ).rejects.toThrow('Max concurrent sessions reached');
    });
  });
});
