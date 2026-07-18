/**
 * Tests for session service handlers
 *
 * Verifies all session.* service handlers route correctly by sessionId,
 * enforce required parameters, and delegate to AgentSession/SessionManager.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionServices, type SessionServiceDeps } from '../session-services';
import type { SubmissionContext } from '@/core/channels/types';

const ctx = { channelId: 'test', channelType: 'sidepanel' } as SubmissionContext;

function createMockDeps(overrides: Partial<SessionServiceDeps> = {}): SessionServiceDeps {
  // Cache session mocks so getSession returns the same reference
  const sessionMocks: Record<string, any> = {
    s1: {
      sessionId: 's1',
      agent: {
        refreshModelClient: vi.fn().mockResolvedValue(undefined),
        getSession: vi.fn().mockReturnValue({
          abortAllTasks: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          getConversationHistory: vi.fn().mockReturnValue({ items: [{ role: 'user', content: 'hi' }] }),
        }),
      },
      getState: vi.fn().mockReturnValue({
        sessionId: 's1',
        isActiveTurn: false,
        tabId: 42,
        history: [{ role: 'user', content: 'hi' }],
      }),
      reset: vi.fn().mockResolvedValue(undefined),
    },
  };

  return {
    registry: {
      listSessions: vi.fn().mockReturnValue([
        { sessionId: 's1', type: 'primary', state: 'idle' },
        { sessionId: 's2', type: 'scheduled', state: 'active' },
      ]),
      getMaxConcurrent: vi.fn().mockReturnValue(5),
      getActiveCount: vi.fn().mockReturnValue(2),
      canCreateSession: vi.fn().mockReturnValue(true),
      createSession: vi.fn().mockResolvedValue({
        sessionId: 's-new',
        sessionLetter: 'c',
        agent: {
          refreshModelClient: vi.fn().mockResolvedValue(undefined),
          getSession: vi.fn().mockReturnValue({
            getConversationHistory: vi.fn().mockReturnValue({ items: [{ role: 'user', content: 'resumed' }] }),
          }),
        },
      }),
      removeSession: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockImplementation((id: string) => sessionMocks[id]),
      setMaxConcurrent: vi.fn(),
      getHistoryPage: vi.fn().mockResolvedValue({
        sessionId: 's1',
        revision: 11,
        turns: [],
        items: [],
        nextCursor: 7,
      }),
    },
    ...overrides,
  };
}

describe('session-services', () => {
  let deps: SessionServiceDeps;
  let services: ReturnType<typeof createSessionServices>;

  beforeEach(() => {
    deps = createMockDeps();
    services = createSessionServices(deps);
  });

  describe('session.resume', () => {
    it('loads history and creates the resumed session without terminating another session', async () => {
      const loadRolloutHistory = vi.fn().mockResolvedValue({
        sessionId: 'conv-123',
        rolloutItems: [{ type: 'event_msg', payload: {} }],
      });
      deps = createMockDeps({ loadRolloutHistory });
      services = createSessionServices(deps);

      const result = await services['session.resume']({ sessionId: 'conv-123' }, ctx);

      // Should load rollout history
      expect(loadRolloutHistory).toHaveBeenCalledWith('conv-123');

      // Should create new session with resume data
      expect(deps.registry.createSession).toHaveBeenCalledWith({
        type: 'primary',
        resume: {
          sessionId: 'conv-123',
          rolloutItems: [{ type: 'event_msg', payload: {} }],
        },
      });

      // Should return history from the new session
      expect(result).toEqual({
        sessionId: 'conv-123',
        history: [{ role: 'user', content: 'resumed' }],
      });
    });

    it('throws when loadRolloutHistory not provided', async () => {
      await expect(services['session.resume']({ sessionId: 's1' }, ctx)).rejects.toThrow(
        'Session resume not supported'
      );
    });

    it('throws when history not found (returns null)', async () => {
      const loadRolloutHistory = vi.fn().mockResolvedValue(null);
      deps = createMockDeps({ loadRolloutHistory });
      services = createSessionServices(deps);

      await expect(services['session.resume']({ sessionId: 'unknown' }, ctx)).rejects.toThrow(
        'Conversation not found or has no history'
      );
    });

    it('throws for missing sessionId', async () => {
      const loadRolloutHistory = vi.fn();
      deps = createMockDeps({ loadRolloutHistory });
      services = createSessionServices(deps);

      await expect(services['session.resume']({}, ctx)).rejects.toThrow('sessionId is required');
    });
  });

  describe('session.list', () => {
    it('returns all sessions with registry metadata', async () => {
      const result = await services['session.list']({}, ctx);

      expect(result).toEqual({
        sessions: [
          { sessionId: 's1', type: 'primary', state: 'idle' },
          { sessionId: 's2', type: 'scheduled', state: 'active' },
        ],
        maxConcurrent: 5,
        activeCount: 2,
      });
    });
  });

  describe('session.getActiveCount', () => {
    it('returns count and capacity info', async () => {
      const result = await services['session.getActiveCount']({}, ctx);

      expect(result).toEqual({
        activeCount: 2,
        maxConcurrent: 5,
        canCreateSession: true,
      });
    });
  });

  describe('session.history', () => {
    it('routes an exclusive cursor and bounded page size to the canonical projection', async () => {
      const result = await services['session.history']({
        sessionId: 's1',
        limit: 10,
        beforeSequence: 42,
      }, ctx);

      expect(deps.registry.getHistoryPage).toHaveBeenCalledWith('s1', {
        limit: 10,
        beforeSequence: 42,
      });
      expect(result).toMatchObject({ sessionId: 's1', revision: 11, nextCursor: 7 });
    });

    it('rejects a history request without a session id', async () => {
      await expect(services['session.history']({}, ctx)).rejects.toThrow(
        'sessionId is required',
      );
    });
  });

  describe('session.create', () => {
    it('creates a new session and returns its info', async () => {
      const refreshModelClient = vi.fn().mockResolvedValue(undefined);
      // Make getSession return a session with agent for the newly created session
      (deps.registry.getSession as any).mockImplementation((id: string) => {
        if (id === 's-new') {
          return {
            agent: { refreshModelClient },
          };
        }
        return undefined;
      });

      const result = await services['session.create']({}, ctx);

      expect(deps.registry.createSession).toHaveBeenCalledWith({ type: 'primary' });
      expect(refreshModelClient).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        sessionId: 's-new',
        sessionLetter: 'c',
      });
    });

    it('returns error when at capacity', async () => {
      (deps.registry.canCreateSession as any).mockReturnValue(false);

      const result = await services['session.create']({}, ctx);

      expect(result).toEqual({
        success: false,
        error: 'Maximum concurrent sessions reached',
      });
      expect(deps.registry.createSession).not.toHaveBeenCalled();
    });
  });

  describe('session.setMaxConcurrent', () => {
    it('updates the limit', async () => {
      const result = await services['session.setMaxConcurrent']({ maxConcurrent: 8 }, ctx);

      expect(deps.registry.setMaxConcurrent).toHaveBeenCalledWith(8);
      expect(result).toEqual({ success: true });
    });

    it('throws for non-numeric value', async () => {
      await expect(
        services['session.setMaxConcurrent']({ maxConcurrent: 'five' }, ctx)
      ).rejects.toThrow('maxConcurrent must be a number');
    });
  });

  describe('session.close', () => {
    it('removes the session', async () => {
      const result = await services['session.close']({ sessionId: 's1' }, ctx);

      expect(deps.registry.removeSession).toHaveBeenCalledWith('s1');
      expect(result).toEqual({ success: true });
    });

    it('returns error for missing sessionId', async () => {
      const result = await services['session.close']({}, ctx);

      expect(result).toEqual({ success: false, error: 'sessionId is required' });
      expect(deps.registry.removeSession).not.toHaveBeenCalled();
    });
  });
});
