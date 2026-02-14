/**
 * Integration tests for multi-session creation
 * Feature: 015-multi-agent-instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import type { SessionConfig } from '@/core/registry/types';

// Mock dependencies
vi.mock('../../src/core/BrowserxAgent', () => ({
  BrowserxAgent: class MockBrowserxAgent {
    initialize = async () => undefined;
    getSession = () => ({
      conversationId: 'conv_test_' + Math.random().toString(36).slice(2),
      abortAllTasks: () => {},
      close: () => {},
      setTabId: () => {},
    });
    submitOperation = async () => 'sub_123';
    cleanup = () => {};
    agentId = 'agent_mock';
  },
}));

vi.mock('../../src/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../src/core/MessageRouter', () => ({
  MessageRouter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../src/core/TabManager', () => ({
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
  let mockRouter: any;

  beforeEach(() => {
    AgentRegistry.resetInstance();
    vi.clearAllMocks();

    mockConfig = {};
    mockRouter = {};
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  describe('US2: Agent Registry Manages Multiple Sessions', () => {
    it('creates multiple sessions with independent state', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create primary session
      const primarySession = await registry.createSession({ type: 'primary' });

      // Create scheduled task sessions
      const scheduledSession1 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_1',
      });
      const scheduledSession2 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_2',
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
      registry.initialize(mockConfig, mockRouter);

      // Create sessions up to limit
      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'scheduled', scheduledTaskId: 'task_1' });

      // Verify we're at limit
      expect(registry.getActiveCount()).toBe(2);
      expect(registry.canCreateSession()).toBe(false);

      // Attempt to create another session should fail
      await expect(
        registry.createSession({ type: 'scheduled', scheduledTaskId: 'task_2' })
      ).rejects.toThrow('Max concurrent sessions reached');
    });

    it('allows new sessions after removal', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 2 });
      registry.initialize(mockConfig, mockRouter);

      // Create sessions up to limit
      const session1 = await registry.createSession({ type: 'primary' });
      const session2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 'task_1' });

      expect(registry.canCreateSession()).toBe(false);

      // Remove a session
      await registry.removeSession(session2.sessionId);

      // Now we should be able to create another
      expect(registry.canCreateSession()).toBe(true);
      const session3 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 'task_2' });

      expect(registry.getActiveCount()).toBe(2);
      expect(session3.sessionLetter).toBe('b'); // Letter should be reused
    });

    it('emits lifecycle events for session operations', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

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

      // Also verify stateChanged event (initializing → idle)
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
      registry.initialize(mockConfig, mockRouter);

      await registry.createSession({ type: 'primary', tabId: 42 });
      await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_1',
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
        scheduledTaskId: 'task_1',
        tabId: 43,
        state: 'idle',
        tabGroupName: 'browserx_s_b',
      });
    });

    it('getOrCreatePrimarySession returns existing or creates new', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

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
  });
});
