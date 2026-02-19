/**
 * Integration tests for parallel user + scheduled task execution
 * Feature: 015-multi-agent-instances
 * Task: T024 - Verify user can have active conversation while scheduled tasks run in parallel
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import type { SessionConfig } from '@/core/registry/types';

// Mock dependencies
vi.mock('@/core/PiAgent', () => ({
  PiAgent: class MockPiAgent {
    private _conversationId = 'conv_' + Math.random().toString(36).slice(2);
    private _isProcessing = false;

    initialize = async () => undefined;
    setEventDispatcher = (_fn: any) => {};
    getSession = () => ({
      conversationId: this._conversationId,
      abortAllTasks: () => {},
      close: () => {},
      setTabId: () => {},
      isActiveTurn: () => this._isProcessing,
    });
    submitOperation = async (op: any) => {
      this._isProcessing = true;
      // Simulate processing delay
      await new Promise(resolve => setTimeout(resolve, 10));
      this._isProcessing = false;
      return 'sub_' + Math.random().toString(36).slice(2);
    };
    cleanup = () => {};
    agentId = 'agent_mock';
  },
}));

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('@/core/MessageRouter', () => ({
  MessageRouter: vi.fn().mockImplementation(() => ({})),
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

describe('Parallel Execution Integration', () => {
  let mockConfig: any;
  let mockRouter: any;

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
    mockRouter = {};
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  describe('US1: Scheduled Task Runs Without Interrupting Active Session', () => {
    it('allows creating multiple sessions for parallel execution', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create primary session (user's active conversation)
      const primarySession = await registry.createSession({ type: 'primary' });
      expect(primarySession.metadata.type).toBe('primary');

      // Create scheduled task session (should run in parallel)
      const scheduledSession = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_123',
      });
      expect(scheduledSession.metadata.type).toBe('scheduled');
      expect(scheduledSession.metadata.scheduledTaskId).toBe('task_123');

      // Both sessions should be active
      expect(registry.getActiveCount()).toBe(2);

      // Sessions should have different IDs
      expect(primarySession.sessionId).not.toBe(scheduledSession.sessionId);

      // Sessions should have different letters for tab group naming
      expect(primarySession.sessionLetter).toBe('a');
      expect(scheduledSession.sessionLetter).toBe('b');
    });

    it('maintains session isolation during parallel operations', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create both sessions
      const primarySession = await registry.createSession({ type: 'primary' });
      const scheduledSession = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_456',
      });

      // Submit operations to both sessions in parallel
      const primarySubmitPromise = primarySession.submit({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Primary user query' }],
      });

      const scheduledSubmitPromise = scheduledSession.submit({
        type: 'UserInput',
        items: [{ type: 'text', text: 'Scheduled task operation' }],
      });

      // Both should complete independently
      const [primaryResult, scheduledResult] = await Promise.all([
        primarySubmitPromise,
        scheduledSubmitPromise,
      ]);

      expect(primaryResult).toMatch(/^sub_/);
      expect(scheduledResult).toMatch(/^sub_/);
      expect(primaryResult).not.toBe(scheduledResult);
    });

    it('allows scheduled session termination without affecting primary', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create both sessions
      const primarySession = await registry.createSession({ type: 'primary' });
      const scheduledSession = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_789',
      });

      expect(registry.getActiveCount()).toBe(2);

      // Terminate scheduled session (simulating task completion)
      await registry.removeSession(scheduledSession.sessionId);

      // Primary session should still be active
      expect(registry.getActiveCount()).toBe(1);
      expect(registry.getPrimarySession()).toBe(primarySession);
      expect(primarySession.state).not.toBe('terminated');
    });

    it('reuses session letters after removal', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create primary session (letter 'a')
      const primarySession = await registry.createSession({ type: 'primary' });
      expect(primarySession.sessionLetter).toBe('a');

      // Create scheduled session (letter 'b')
      const scheduledSession1 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_1',
      });
      expect(scheduledSession1.sessionLetter).toBe('b');

      // Remove scheduled session
      await registry.removeSession(scheduledSession1.sessionId);

      // Create another scheduled session - should reuse letter 'b'
      const scheduledSession2 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_2',
      });
      expect(scheduledSession2.sessionLetter).toBe('b');
    });

    it('tracks scheduled task sessions with scheduledTaskId', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create multiple scheduled task sessions
      const taskIds = ['task_a', 'task_b', 'task_c'];
      const sessions = await Promise.all(
        taskIds.map((taskId) =>
          registry.createSession({
            type: 'scheduled',
            scheduledTaskId: taskId,
          })
        )
      );

      // All sessions should have their task IDs
      sessions.forEach((session, index) => {
        expect(session.metadata.scheduledTaskId).toBe(taskIds[index]);
      });

      // Can find sessions by listing and filtering
      const allSessions = registry.listSessions();
      const scheduledSessions = allSessions.filter(
        (s) => s.type === 'scheduled'
      );
      expect(scheduledSessions).toHaveLength(3);
      expect(scheduledSessions.map((s) => s.scheduledTaskId)).toEqual(
        expect.arrayContaining(taskIds)
      );
    });

    it('emits proper events for session lifecycle', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const events: any[] = [];
      registry.on((event) => events.push(event));

      // Create scheduled session
      const session = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_event_test',
      });

      // Should have emitted stateChanged (initializing → idle) and created events
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session:created',
          sessionId: session.sessionId,
          sessionType: 'scheduled',
        })
      );

      // Remove session
      events.length = 0;
      await registry.removeSession(session.sessionId);

      // Should have emitted terminated event
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session:terminated',
          sessionId: session.sessionId,
        })
      );
    });
  });

  describe('Concurrent Limits for Scheduled Tasks', () => {
    it('respects max concurrent sessions for scheduled tasks', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 3 });
      registry.initialize(mockConfig, mockRouter);

      // Create primary session
      await registry.createSession({ type: 'primary' });

      // Create scheduled sessions up to limit
      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });
      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't2' });

      // At limit
      expect(registry.getActiveCount()).toBe(3);
      expect(registry.canCreateSession()).toBe(false);

      // Cannot create more
      await expect(
        registry.createSession({ type: 'scheduled', scheduledTaskId: 't3' })
      ).rejects.toThrow(/Max concurrent sessions/);
    });

    it('allows new scheduled tasks after existing ones complete', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 2 });
      registry.initialize(mockConfig, mockRouter);

      // Fill to capacity
      const session1 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 't1',
      });
      const session2 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 't2',
      });

      expect(registry.canCreateSession()).toBe(false);

      // Complete one task
      await registry.removeSession(session1.sessionId);

      // Now we can create another
      expect(registry.canCreateSession()).toBe(true);
      const session3 = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 't3',
      });

      expect(session3.metadata.scheduledTaskId).toBe('t3');
    });
  });
});
