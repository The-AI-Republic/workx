/**
 * Unit tests for AgentSession
 * Feature: 015-multi-agent-instances
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSession } from '@/core/registry/AgentSession';
import type { SessionConfig } from '@/core/registry/types';

// Mock RepublicAgent session - shared object so spies work correctly
const mockSession = {
  sessionId: 'conv_test_123',
  abortAllTasks: vi.fn(),
  close: vi.fn(),
  dispose: vi.fn(),
};

// Mock RepublicAgent
const mockAgent = {
  getSession: vi.fn(() => mockSession),
  submitOperation: vi.fn(() => Promise.resolve('sub_123')),
  dispose: vi.fn().mockResolvedValue(undefined),
};

describe('AgentSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates session with primary type', () => {
      const config: SessionConfig = { type: 'primary' };
      const session = new AgentSession(config, 0);

      // sessionId is a UUID when not provided via config
      expect(session.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(session.sessionLetter).toBe('a');
      expect(session.state).toBe('initializing');
      expect(session.metadata.type).toBe('primary');
    });

    it('creates session with scheduled type', () => {
      const config: SessionConfig = {
        type: 'scheduled',
      };
      const session = new AgentSession(config, 1);

      expect(session.metadata.type).toBe('scheduled');
      expect(session.sessionLetter).toBe('b');
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
    it('attaches agent without changing sessionId', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      const originalSessionId = session.sessionId;
      session.attachAgent(mockAgent as any);

      expect(session.agent).toBe(mockAgent);
      // sessionId is set at construction, attachAgent does not change it
      expect(session.metadata.sessionId).toBe(originalSessionId);
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

      expect(mockAgent.dispose).toHaveBeenCalledWith('error');
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

  describe('unified sessionId', () => {
    it('uses provided sessionId from config', () => {
      const session = new AgentSession({ type: 'primary', sessionId: 'agent-abc-123' } as any, 0);

      expect(session.sessionId).toBe('agent-abc-123');
      expect(session.metadata.sessionId).toBe('agent-abc-123');
      expect(session.getSessionId()).toBe('agent-abc-123');
    });

    it('generates UUID when sessionId not provided', () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      expect(session.sessionId).toMatch(/^[0-9a-f]{8}-/);
    });

    it('sessionId is consistent via getter and metadata', () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      expect(session.sessionId).toBe(session.metadata.sessionId);
      expect(session.sessionId).toBe(session.getSessionId());
    });
  });

  describe('concurrent submit guard', () => {
    it('prevents concurrent submissions', async () => {
      // Create a slow agent that doesn't resolve immediately
      let resolveSubmit: (value: string) => void;
      const slowAgent = {
        getSession: vi.fn(() => mockSession),
        submitOperation: vi.fn(() => new Promise<string>((resolve) => { resolveSubmit = resolve; })),
        cleanup: vi.fn(),
      };

      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(slowAgent as any);
      session.markReady();

      // First submit starts
      const submit1 = session.submit({ type: 'UserInput', items: [] });

      // Second submit should be rejected while first is in flight
      await expect(
        session.submit({ type: 'UserInput', items: [] })
      ).rejects.toThrow('already processing a submission');

      // Resolve the first submit
      resolveSubmit!('sub_1');
      await submit1;

      // Now a third submit should work
      resolveSubmit = undefined as any;
      slowAgent.submitOperation.mockResolvedValue('sub_2');
      const result = await session.submit({ type: 'UserInput', items: [] });
      expect(result).toBe('sub_2');
    });

    it('clears submitting flag even when submit throws', async () => {
      const failingAgent = {
        getSession: vi.fn(() => mockSession),
        submitOperation: vi.fn().mockRejectedValue(new Error('submission failed')),
        cleanup: vi.fn(),
      };

      const session = new AgentSession({ type: 'primary' }, 0);
      session.attachAgent(failingAgent as any);
      session.markReady();

      // First submit fails
      await expect(session.submit({ type: 'UserInput', items: [] })).rejects.toThrow('submission failed');

      // Should be able to submit again (flag was cleared)
      failingAgent.submitOperation.mockResolvedValue('sub_retry');
      const result = await session.submit({ type: 'UserInput', items: [] });
      expect(result).toBe('sub_retry');
    });
  });

  describe('internal flag', () => {
    it('defaults to false', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      expect(session.internal).toBe(false);
    });

    it('can be set to true via config', () => {
      const session = new AgentSession({ type: 'primary', internal: true }, 0);
      expect(session.internal).toBe(true);
    });
  });

  describe('serialization', () => {
    it('toJSON returns metadata copy', () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      const json = session.toJSON();

      expect(json.sessionId).toBe(session.sessionId);
      expect(json.type).toBe('primary');
      json.type = 'scheduled';
      expect(session.metadata.type).toBe('primary');
    });
  });
});
