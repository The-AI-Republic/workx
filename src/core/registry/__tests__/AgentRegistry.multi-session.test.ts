/**
 * Multi-session isolation tests for AgentRegistry
 *
 * Verifies that each session gets its own RepublicAgent,
 * events don't leak between sessions, concurrent limits
 * are enforced, and freed letters are recycled.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '@/core/registry/AgentRegistry';
import { DEFAULT_MAX_CONCURRENT } from '@/core/registry/types';

// Mock RepublicAgent
vi.mock('@/core/RepublicAgent', () => ({
  RepublicAgent: class MockRepublicAgent {
    private _session = {
      sessionId: 'session_' + Math.random().toString(36).slice(2),
      abortAllTasks: vi.fn(),
      close: vi.fn(),
      setTabId: vi.fn(),
    };
    initialize = vi.fn().mockResolvedValue(undefined);
    getSession = vi.fn(() => this._session);
    submitOperation = vi.fn().mockResolvedValue('sub_123');
    cleanup = vi.fn();
    setEventDispatcher = vi.fn();
    getApprovalManager = vi.fn().mockReturnValue({});
    getToolRegistry = vi.fn().mockReturnValue({ setApprovalGate: vi.fn() });
    getHookDispatcher = vi.fn().mockReturnValue({ fire: vi.fn().mockResolvedValue({}) });
    getEngine = vi.fn().mockReturnValue(null);
    refreshModelClient = vi.fn().mockResolvedValue(undefined);
    agentId = 'agent_mock';
  },
}));

vi.mock('@/config/AgentConfig', () => ({
  AgentConfig: { getInstance: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@/core/channels/ChannelManager', () => ({
  getChannelManager: vi.fn(() => ({
    broadcastEvent: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('@/core/TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(() => ({
      onTabClosure: vi.fn(() => vi.fn()),
    })),
  },
}));

describe('AgentRegistry — multi-session isolation', () => {
  let registry: AgentRegistry;
  let mockConfig: any;

  beforeEach(() => {
    AgentRegistry.resetInstance();
    vi.clearAllMocks();

    Object.defineProperty(globalThis, 'chrome', {
      value: {
        runtime: { sendMessage: vi.fn(() => Promise.resolve(undefined)) },
      },
      writable: true,
      configurable: true,
    });

    mockConfig = {};
    registry = new AgentRegistry({ maxConcurrent: DEFAULT_MAX_CONCURRENT });
    registry.initialize(mockConfig);
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  // =========================================================================
  // Session isolation
  // =========================================================================

  describe('session isolation', () => {
    it('assigns distinct sessionIds to each session', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });

      expect(s1.sessionId).not.toBe(s2.sessionId);
    });

    it('assigns distinct letters to each session', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });
      const s3 = await registry.createSession({ type: 'primary' });

      const letters = [s1.sessionLetter, s2.sessionLetter, s3.sessionLetter];
      expect(new Set(letters).size).toBe(3);
      expect(letters).toEqual(['a', 'b', 'c']);
    });

    it('creates distinct RepublicAgent instances per session', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });

      expect(s1.agent).not.toBe(s2.agent);
    });

    it('getSession returns the correct session by ID', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });

      expect(registry.getSession(s1.sessionId)).toBe(s1);
      expect(registry.getSession(s2.sessionId)).toBe(s2);
      expect(registry.getSession('unknown')).toBeUndefined();
    });
  });

  // =========================================================================
  // Event isolation
  // =========================================================================

  describe('event isolation', () => {
    it('emits session:created events tagged with the correct sessionId', async () => {
      const listener = vi.fn();
      registry.on(listener);

      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });

      const createdEvents = listener.mock.calls
        .map(([ev]: any) => ev)
        .filter((ev: any) => ev.type === 'session:created');

      expect(createdEvents).toHaveLength(2);
      expect(createdEvents[0].sessionId).toBe(s1.sessionId);
      expect(createdEvents[1].sessionId).toBe(s2.sessionId);
    });

    it('terminating one session does not affect another', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });

      await registry.removeSession(s1.sessionId);

      expect(registry.getSession(s1.sessionId)).toBeUndefined();
      expect(registry.getSession(s2.sessionId)).toBe(s2);
      expect(s2.state).toBe('idle');
    });

    it('registry listener receives events from all sessions', async () => {
      const listener = vi.fn();
      registry.on(listener);

      await registry.createSession({ type: 'primary' });
      await registry.createSession({ type: 'primary' });

      // Every createSession emits at least a session:stateChanged (initializing→idle)
      // and session:created. With 2 sessions we should have events from both.
      const sessionIds = new Set(
        listener.mock.calls.map(([ev]: any) => ev.sessionId)
      );
      expect(sessionIds.size).toBe(2);
    });
  });

  // =========================================================================
  // Concurrent limits
  // =========================================================================

  describe('concurrent limits', () => {
    it('allows up to maxConcurrent sessions', async () => {
      const reg = new AgentRegistry({ maxConcurrent: 5 });
      reg.initialize(mockConfig);

      for (let i = 0; i < 5; i++) {
        await reg.createSession({ type: 'primary' });
      }

      expect(reg.getActiveCount()).toBe(5);
    });

    it('rejects the session that exceeds the limit', async () => {
      const reg = new AgentRegistry({ maxConcurrent: 5 });
      reg.initialize(mockConfig);

      for (let i = 0; i < 5; i++) {
        await reg.createSession({ type: 'primary' });
      }

      await expect(reg.createSession({ type: 'primary' })).rejects.toThrow(
        'Max concurrent sessions reached'
      );
    });

    it('allows creation after removal frees a slot', async () => {
      const reg = new AgentRegistry({ maxConcurrent: 2 });
      reg.initialize(mockConfig);

      const s1 = await reg.createSession({ type: 'primary' });
      await reg.createSession({ type: 'primary' });

      // Full
      await expect(reg.createSession({ type: 'primary' })).rejects.toThrow();

      // Free one slot
      await reg.removeSession(s1.sessionId);

      // Should succeed now
      const s3 = await reg.createSession({ type: 'primary' });
      expect(s3.sessionId).toBeTruthy();
    });
  });

  // =========================================================================
  // Letter recycling
  // =========================================================================

  describe('letter recycling', () => {
    it('reuses a freed letter', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      expect(s1.sessionLetter).toBe('a');

      await registry.removeSession(s1.sessionId);

      const s2 = await registry.createSession({ type: 'primary' });
      expect(s2.sessionLetter).toBe('a');
    });

    it('maintains unique letters across concurrent sessions', async () => {
      const s1 = await registry.createSession({ type: 'primary' });
      const s2 = await registry.createSession({ type: 'primary' });

      // Remove 'a', create new — should get 'a' back, not 'c'
      await registry.removeSession(s1.sessionId);

      const s3 = await registry.createSession({ type: 'primary' });
      expect(s3.sessionLetter).toBe('a');
      expect(s2.sessionLetter).toBe('b');

      // Letters should remain unique
      expect(new Set([s2.sessionLetter, s3.sessionLetter]).size).toBe(2);
    });
  });
});
