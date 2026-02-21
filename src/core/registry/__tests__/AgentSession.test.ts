/**
 * Unit tests for AgentSession
 * Feature: 015-multi-agent-instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSession } from '@/core/registry/AgentSession';
import type { SessionConfig } from '@/core/registry/types';

// Mock PiAgent session - shared object so spies work correctly
const mockSession = {
  conversationId: 'conv_test_123',
  abortAllTasks: vi.fn(),
  close: vi.fn(),
  setTabId: vi.fn(),
};

// Mock PiAgent
const mockAgent = {
  getSession: vi.fn(() => mockSession),
  submitOperation: vi.fn(() => Promise.resolve('sub_123')),
  cleanup: vi.fn(),
};

// Mock chrome API for tab group operations
global.chrome = {
  tabs: {
    group: vi.fn(() => Promise.resolve(1)),
    ungroup: vi.fn(() => Promise.resolve()),
    query: vi.fn(() => Promise.resolve([])),
  },
  tabGroups: {
    update: vi.fn(() => Promise.resolve({})),
  },
} as any;

describe('AgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates session with primary type', () => {
      const config: SessionConfig = { type: 'primary' };
      const session = new AgentSession(config, 0);

      expect(session.sessionId).toMatch(/^session_/);
      expect(session.sessionLetter).toBe('a');
      expect(session.state).toBe('initializing');
      expect(session.metadata.type).toBe('primary');
      expect(session.metadata.tabGroupName).toBe('pi_s_a');
    });

    it('creates session with scheduled type', () => {
      const config: SessionConfig = {
        type: 'scheduled',
        scheduledTaskId: 'task_123',
      };
      const session = new AgentSession(config, 1);

      expect(session.metadata.type).toBe('scheduled');
      expect(session.metadata.scheduledTaskId).toBe('task_123');
      expect(session.sessionLetter).toBe('b');
      expect(session.metadata.tabGroupName).toBe('pi_s_b');
    });

    it('uses provided tabId', () => {
      const config: SessionConfig = { type: 'primary', tabId: 42 };
      const session = new AgentSession(config, 0);

      expect(session.metadata.tabId).toBe(42);
    });

    it('wraps letter index for large values', () => {
      const config: SessionConfig = { type: 'primary' };
      const session = new AgentSession(config, 26); // Should wrap to 'a'

      expect(session.sessionLetter).toBe('a');
    });
  });

  describe('lifecycle states', () => {
    it('starts in initializing state', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      expect(session.state).toBe('initializing');
    });

    it('transitions from initializing to idle via markReady', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();
      expect(session.state).toBe('idle');
    });

    it('transitions from idle to active via markActive', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();
      session.markActive();
      expect(session.state).toBe('active');
    });

    it('transitions from active to idle via markIdle', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();
      session.markActive();
      session.markIdle();
      expect(session.state).toBe('idle');
    });

    it('throws on invalid state transition', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();

      // Cannot go from idle directly to initializing
      expect(() => session.setState('initializing')).toThrow('Invalid state transition');
    });

    it('emits stateChanged events', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      const listener = vi.fn();
      session.on(listener);

      session.markReady();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session:stateChanged',
          sessionId: session.sessionId,
          previousState: 'initializing',
          newState: 'idle',
        })
      );
    });

    it('cannot transition from terminated', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();
      session.setState('terminated');

      expect(() => session.setState('idle')).toThrow('Invalid state transition');
    });
  });

  describe('agent attachment', () => {
    it('attaches agent and updates conversationId', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);

      expect(session.agent).toBe(mockAgent);
      expect(session.metadata.conversationId).toBe('conv_test_123');
    });

    it('throws when attaching agent twice', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);

      expect(() => session.attachAgent(mockAgent as any)).toThrow('already has an agent attached');
    });
  });

  describe('submit', () => {
    it('submits operation to agent', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      session.markReady();

      const submissionId = await session.submit({ type: 'UserInput', items: [] });

      expect(mockAgent.submitOperation).toHaveBeenCalled();
      expect(submissionId).toBe('sub_123');
    });

    it('marks session as active on submit from idle', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      session.markReady();

      expect(session.state).toBe('idle');
      await session.submit({ type: 'UserInput', items: [] });
      expect(session.state).toBe('active');
    });

    it('throws when submitting without agent', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();

      await expect(session.submit({ type: 'UserInput', items: [] })).rejects.toThrow(
        'has no agent attached'
      );
    });

    it('throws when submitting to terminated session', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      session.markReady();
      session.setState('terminated');

      await expect(session.submit({ type: 'UserInput', items: [] })).rejects.toThrow(
        'is terminated'
      );
    });
  });

  describe('tab binding', () => {
    it('binds tab and updates metadata', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      await session.bindTab(42, false); // false = don't create tab group

      expect(session.metadata.tabId).toBe(42);
    });

    it('unbinds tab', async () => {
      const session = new AgentSession({ type: 'primary', tabId: 42 }, 0);
      await session.unbindTab();

      expect(session.metadata.tabId).toBeNull();
    });

    it('updates agent session tabId when bound', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      await session.bindTab(42, false);

      expect(mockSession.setTabId).toHaveBeenCalledWith(42);
    });

    it('throws when binding tab to terminated session', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();
      session.setState('terminated');

      await expect(session.bindTab(42)).rejects.toThrow('is terminated');
    });
  });

  describe('terminate', () => {
    it('terminates session and emits event', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      session.markReady();

      const listener = vi.fn();
      session.on(listener);

      await session.terminate('manual');

      expect(session.state).toBe('terminated');
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session:terminated',
          sessionId: session.sessionId,
          reason: 'manual',
        })
      );
    });

    it('cleans up agent on termination', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      session.markReady();

      await session.terminate('error');

      expect(mockAgent.getSession().abortAllTasks).toHaveBeenCalled();
      expect(mockAgent.getSession().close).toHaveBeenCalled();
      expect(mockAgent.cleanup).toHaveBeenCalled();
      expect(session.agent).toBeNull();
    });

    it('is idempotent', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(mockAgent as any);
      session.markReady();

      await session.terminate('manual');
      await session.terminate('manual'); // Should not throw

      expect(session.state).toBe('terminated');
    });
  });

  describe('event handling', () => {
    it('registers and unregisters listeners', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      const listener = vi.fn();

      const unsubscribe = session.on(listener);
      session.markReady();
      expect(listener).toHaveBeenCalled();

      listener.mockClear();
      unsubscribe();
      session.markActive();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('serialization', () => {
    it('toJSON returns metadata copy', () => {
      const session = new AgentSession({ type: 'primary', tabId: 42 }, 0);
      const json = session.toJSON();

      expect(json.sessionId).toBe(session.sessionId);
      expect(json.type).toBe('primary');
      expect(json.tabId).toBe(42);

      // Ensure it's a copy
      json.tabId = 999;
      expect(session.metadata.tabId).toBe(42);
    });
  });
});
