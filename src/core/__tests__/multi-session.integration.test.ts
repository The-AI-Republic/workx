/**
 * Integration tests for multi-session creation
 * Feature: 015-multi-agent-instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import type { SessionConfig } from '@/core/registry/types';

// Mock dependencies
vi.mock('@/core/RepublicAgent', () => ({
  RepublicAgent: class MockRepublicAgent {
    private _session = {
      sessionId: 'session_test_' + Math.random().toString(36).slice(2),
      abortAllTasks: () => {},
      close: () => {},
      setTabId: () => {},
    };
    initialize = async () => undefined;
    setEventDispatcher = (_fn: any) => {};
    getSession = () => this._session;
    submitOperation = async () => 'sub_123';
    cleanup = () => {};
    getApprovalManager = () => ({});
    getToolRegistry = () => ({ setApprovalGate: () => {} });
    agentId = 'agent_mock';
  },
}));

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/core/TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(() => ({
      onTabClosure: vi.fn(() => vi.fn()),
    })),
  },
}));

// Mock chrome API - must return a Promise with .catch method
const mockSendMessage = vi.fn(() => Promise.resolve(undefined));
global.chrome = {
  runtime: {
    sendMessage: mockSendMessage,
  },
} as any;

describe('Multi-Session Integration', () => {
  let mockConfig: any;

  beforeEach(() => {
    AgentRegistry.resetInstance();
    vi.clearAllMocks();

    // Re-set chrome mock after clearAllMocks
    global.chrome = {
      runtime: {
        sendMessage: vi.fn(() => Promise.resolve(undefined)),
      },
    } as any;

    mockConfig = {
      on: vi.fn(),
      off: vi.fn(),
      getConfig: vi.fn().mockReturnValue({}),
      getModelConfig: vi.fn().mockReturnValue({ modelKey: 'test' }),
    };
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  describe('US2: Agent Registry Manages Multiple Sessions', () => {
    it('creates multiple sessions with independent state', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig);

      // Create primary session
      const primarySession = await registry.createSession({ type: 'primary' });

      // Create scheduled task sessions
      const scheduledSession1 = await registry.createSession({
        type: 'scheduled',
      });
      const scheduledSession2 = await registry.createSession({
        type: 'scheduled',
      });

      // Verify all sessions are created
      expect(registry.getActiveCount()).toBe(3);

      // Verify each session has unique ID
      const sessionIds = new Set([
        primarySession.sessionId,
        scheduledSession1.sessionId,
        scheduledSession2.sessionId,
      ]);
      expect(sessionIds.size).toBe(3);

      // Verify each session has unique letter
      expect(primarySession.sessionLetter).toBe('a');
      expect(scheduledSession1.sessionLetter).toBe('b');
      expect(scheduledSession2.sessionLetter).toBe('c');

      // Verify sessions can be retrieved by ID
      expect(registry.getSession(primarySession.sessionId)).toBe(primarySession);
      expect(registry.getSession(scheduledSession1.sessionId)).toBe(scheduledSession1);
      expect(registry.getSession(scheduledSession2.sessionId)).toBe(scheduledSession2);

      // Verify primary session is accessible via convenience method
      expect(registry.getPrimarySession()).toBe(primarySession);
    });

    it('enforces concurrent session limit', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 2 });
      registry.initialize(mockConfig);

      // Create sessions up to limit
      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'scheduled' });

      // Verify we're at limit
      expect(registry.getActiveCount()).toBe(2);
      expect(registry.canCreateSession()).toBe(false);

      // Attempt to create another session should fail
      await expect(
        registry.createSession({ type: 'scheduled' })
      ).rejects.toThrow('Max concurrent sessions reached');
    });

    it('allows new sessions after removal', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 2 });
      registry.initialize(mockConfig);

      // Create sessions up to limit
      const session1 = await registry.createSession({ type: 'primary' });
      const session2 = await registry.createSession({ type: 'scheduled' });

      expect(registry.canCreateSession()).toBe(false);

      // Remove a session
      await registry.removeSession(session2.sessionId);

      // Now we should be able to create another
      expect(registry.canCreateSession()).toBe(true);
      const session3 = await registry.createSession({ type: 'scheduled' });

      expect(registry.getActiveCount()).toBe(2);
      expect(session3.sessionLetter).toBe('b'); // Letter should be reused
    });

    it('emits lifecycle events for session operations', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig);

      const events: any[] = [];
      registry.on((event) => events.push(event));

      // Create session
      const session = await registry.createSession({ type: 'primary' });

      // Verify created event
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session:created',
          sessionId: session.sessionId,
          sessionType: 'primary',
        })
      );

      // Also verify stateChanged event (initializing -> idle)
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session:stateChanged',
          sessionId: session.sessionId,
          previousState: 'initializing',
          newState: 'idle',
        })
      );

      events.length = 0;

      // Remove session
      await registry.removeSession(session.sessionId);

      // Verify terminated event
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session:terminated',
          sessionId: session.sessionId,
          reason: 'manual',
        })
      );
    });

    it('lists all sessions with metadata', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig);

      await registry.createSession({ type: 'primary', tabId: 42 });
      await registry.createSession({
        type: 'scheduled',
        tabId: 43,
      });

      const sessions = registry.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.type === 'primary')).toMatchObject({
        type: 'primary',
        tabId: 42,
        state: 'idle',
        tabGroupName: 'browserx_s_a',
      });
      expect(sessions.find((s) => s.type === 'scheduled')).toMatchObject({
        type: 'scheduled',
        tabId: 43,
        state: 'idle',
        tabGroupName: 'browserx_s_b',
      });
    });

    it('getOrCreatePrimarySession returns existing or creates new', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig);

      // First call creates primary session
      const session1 = await registry.getOrCreatePrimarySession();
      expect(session1.metadata.type).toBe('primary');

      // Second call returns the same session
      const session2 = await registry.getOrCreatePrimarySession();
      expect(session2).toBe(session1);

      // Remove primary session
      await registry.removeSession(session1.sessionId);

      // Next call creates new primary session
      const session3 = await registry.getOrCreatePrimarySession();
      expect(session3).not.toBe(session1);
      expect(session3.metadata.type).toBe('primary');
    });

    it('internal sessions bypass concurrent limit and are excluded from count', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 2 });
      registry.initialize(mockConfig);

      // Fill user-facing slots
      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'scheduled' });
      expect(registry.getActiveCount()).toBe(2);
      expect(registry.canCreateSession()).toBe(false);

      // Internal session bypasses the limit
      const internal = await registry.createSession({ type: 'primary', internal: true });
      expect(internal).toBeDefined();
      expect(internal.internal).toBe(true);

      // Internal session is NOT counted in active count
      expect(registry.getActiveCount()).toBe(2);
      expect(registry.canCreateSession()).toBe(false);

      // Regular session still fails
      await expect(
        registry.createSession({ type: 'scheduled' })
      ).rejects.toThrow('Max concurrent sessions reached');
    });

    it('each session gets a unique sessionId from its agent', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig);

      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'scheduled' });
      const s3 = await registry.createSession({ type: 'scheduled' });

      // Each session should have a unique ID from its agent's session
      const ids = new Set([s1.sessionId, s2.sessionId, s3.sessionId]);
      expect(ids.size).toBe(3);

      // sessionId should match what's used to retrieve the session
      expect(registry.getSession(s1.sessionId)).toBe(s1);
      expect(registry.getSession(s2.sessionId)).toBe(s2);
      expect(registry.getSession(s3.sessionId)).toBe(s3);
    });
  });
});
