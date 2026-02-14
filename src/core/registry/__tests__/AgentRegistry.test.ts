/**
 * Unit tests for AgentRegistry
 * Feature: 015-multi-agent-instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import type { SessionConfig } from '@/core/registry/types';

// Mock dependencies
const mockAgentFactory = vi.hoisted(() => {
  return {
    createMockAgent: () => ({
      initialize: async () => undefined,
      getSession: () => ({
        conversationId: 'conv_test_' + Math.random().toString(36).slice(2),
        abortAllTasks: () => {},
        close: () => {},
        setTabId: () => {},
      }),
      submitOperation: async () => 'sub_123',
      cleanup: () => {},
      agentId: 'agent_' + Math.random().toString(36).slice(2),
    }),
  };
});

vi.mock('../../../src/core/BrowserxAgent', () => ({
  BrowserxAgent: class MockBrowserxAgent {
    initialize = mockAgentFactory.createMockAgent().initialize;
    getSession = mockAgentFactory.createMockAgent().getSession;
    submitOperation = mockAgentFactory.createMockAgent().submitOperation;
    cleanup = mockAgentFactory.createMockAgent().cleanup;
    agentId = 'agent_mock';
  },
}));

vi.mock('../../../src/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../../src/core/MessageRouter', () => ({
  MessageRouter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('../../../src/core/TabManager', () => ({
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

describe('AgentRegistry', () => {
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

  describe('singleton pattern', () => {
    it('returns same instance on multiple calls', () => {
      const instance1 = AgentRegistry.getInstance();
      const instance2 = AgentRegistry.getInstance();

      expect(instance1).toBe(instance2);
    });

    it('can be reset', () => {
      const instance1 = AgentRegistry.getInstance();
      AgentRegistry.resetInstance();
      const instance2 = AgentRegistry.getInstance();

      expect(instance1).not.toBe(instance2);
    });
  });

  describe('initialization', () => {
    it('initializes with config and router', () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Should not throw
      expect(registry.getActiveCount()).toBe(0);
    });
  });

  describe('createSession', () => {
    it('creates a primary session', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session = await registry.createSession({ type: 'primary' });

      expect(session.sessionId).toMatch(/^session_/);
      expect(session.metadata.type).toBe('primary');
      expect(session.state).toBe('idle'); // Should be ready after creation
    });

    it('creates a scheduled session', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session = await registry.createSession({
        type: 'scheduled',
        scheduledTaskId: 'task_123',
      });

      expect(session.metadata.type).toBe('scheduled');
      expect(session.metadata.scheduledTaskId).toBe('task_123');
    });

    it('assigns unique letters to sessions', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session1 = await registry.createSession({ type: 'primary' });
      const session2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });
      const session3 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't2' });

      expect(session1.sessionLetter).toBe('a');
      expect(session2.sessionLetter).toBe('b');
      expect(session3.sessionLetter).toBe('c');
    });

    it('throws when max sessions reached', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 2 });
      registry.initialize(mockConfig, mockRouter);

      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });

      await expect(
        registry.createSession({ type: 'scheduled', scheduledTaskId: 't2' })
      ).rejects.toThrow('Max concurrent sessions reached');
    });

    it('throws when not initialized', async () => {
      const registry = AgentRegistry.getInstance();

      await expect(registry.createSession({ type: 'primary' })).rejects.toThrow(
        'AgentRegistry not initialized'
      );
    });

    it('emits session:created event', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const listener = vi.fn();
      registry.on(listener);

      const session = await registry.createSession({ type: 'primary' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session:created',
          sessionId: session.sessionId,
          sessionType: 'primary',
        })
      );
    });
  });

  describe('getSession', () => {
    it('returns session by ID', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const created = await registry.createSession({ type: 'primary' });
      const retrieved = registry.getSession(created.sessionId);

      expect(retrieved).toBe(created);
    });

    it('returns undefined for unknown ID', () => {
      const registry = AgentRegistry.getInstance();

      expect(registry.getSession('unknown')).toBeUndefined();
    });
  });

  describe('getPrimarySession', () => {
    it('returns primary session when exists', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const primary = await registry.createSession({ type: 'primary' });

      expect(registry.getPrimarySession()).toBe(primary);
    });

    it('returns undefined when no primary session', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });

      expect(registry.getPrimarySession()).toBeUndefined();
    });
  });

  describe('getOrCreatePrimarySession', () => {
    it('returns existing primary session', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const existing = await registry.createSession({ type: 'primary' });
      const retrieved = await registry.getOrCreatePrimarySession();

      expect(retrieved).toBe(existing);
    });

    it('creates primary session if none exists', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session = await registry.getOrCreatePrimarySession();

      expect(session.metadata.type).toBe('primary');
    });
  });

  describe('removeSession', () => {
    it('removes session from registry', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session = await registry.createSession({ type: 'primary' });
      expect(registry.getSession(session.sessionId)).toBeDefined();

      await registry.removeSession(session.sessionId);
      expect(registry.getSession(session.sessionId)).toBeUndefined();
    });

    it('frees letter for reuse', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session1 = await registry.createSession({ type: 'primary' });
      expect(session1.sessionLetter).toBe('a');

      await registry.removeSession(session1.sessionId);

      const session2 = await registry.createSession({ type: 'primary' });
      expect(session2.sessionLetter).toBe('a'); // Reused
    });

    it('handles unknown session gracefully', async () => {
      const registry = AgentRegistry.getInstance();

      // Should not throw
      await registry.removeSession('unknown');
    });
  });

  describe('listSessions', () => {
    it('returns all session metadata', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });

      const sessions = registry.listSessions();

      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.type === 'primary')).toBeDefined();
      expect(sessions.find((s) => s.type === 'scheduled')).toBeDefined();
    });
  });

  describe('getActiveCount', () => {
    it('counts non-terminated sessions', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      expect(registry.getActiveCount()).toBe(0);

      const session1 = await registry.createSession({ type: 'primary' });
      expect(registry.getActiveCount()).toBe(1);

      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });
      expect(registry.getActiveCount()).toBe(2);

      await registry.removeSession(session1.sessionId);
      expect(registry.getActiveCount()).toBe(1);
    });
  });

  describe('concurrent limits', () => {
    it('defaults to 3 concurrent sessions', () => {
      const registry = AgentRegistry.getInstance();
      expect(registry.getMaxConcurrent()).toBe(3);
    });

    it('accepts custom limit in constructor', () => {
      AgentRegistry.resetInstance();
      const registry = AgentRegistry.getInstance({ maxConcurrent: 5 });
      expect(registry.getMaxConcurrent()).toBe(5);
    });

    it('clamps limit to valid range', () => {
      AgentRegistry.resetInstance();
      const registry = AgentRegistry.getInstance({ maxConcurrent: 100 });
      expect(registry.getMaxConcurrent()).toBe(10); // MAX_CONCURRENT_LIMIT
    });

    it('setMaxConcurrent updates limit', () => {
      const registry = AgentRegistry.getInstance();
      registry.setMaxConcurrent(5);
      expect(registry.getMaxConcurrent()).toBe(5);
    });

    it('canCreateSession respects limit', async () => {
      const registry = AgentRegistry.getInstance({ maxConcurrent: 1 });
      registry.initialize(mockConfig, mockRouter);

      expect(registry.canCreateSession()).toBe(true);

      await registry.createSession({ type: 'primary' });
      expect(registry.canCreateSession()).toBe(false);
    });
  });

  describe('event handling', () => {
    it('registers and unregisters listeners', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const listener = vi.fn();
      const unsubscribe = registry.on(listener);

      await registry.createSession({ type: 'primary' });
      expect(listener).toHaveBeenCalled();

      listener.mockClear();
      unsubscribe();

      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('terminates all sessions', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });

      expect(registry.getActiveCount()).toBe(2);

      await registry.cleanup();

      expect(registry.getActiveCount()).toBe(0);
      expect(registry.listSessions()).toHaveLength(0);
    });
  });
});
