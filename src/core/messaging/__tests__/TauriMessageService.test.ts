/**
 * Unit tests for TauriMessageService — session-aware desktop message routing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageType } from '@/core/MessageRouter';

// ---------- Mock set-up ----------

const mockEmit = vi.fn().mockResolvedValue(undefined);
const mockListen = vi.fn().mockResolvedValue(() => {});

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: any[]) => mockEmit(...args),
  listen: (...args: any[]) => mockListen(...args),
}));

vi.mock('@/desktop/channels/LargePayloadStore', () => ({
  isPayloadRef: vi.fn(() => false),
  retrievePayload: vi.fn(),
}));

// Stable inner session objects (returned by getSession()) so spy references persist
const innerSessionA = {
  getTabId: vi.fn(() => 101),
  getConversationHistory: vi.fn(() => ({ items: [{ role: 'user', content: 'hello A' }] })),
  reset: vi.fn(),
  abortAllTasks: vi.fn(),
};

const innerSessionB = {
  getTabId: vi.fn(() => 202),
  getConversationHistory: vi.fn(() => ({ items: [{ role: 'user', content: 'hello B' }] })),
  reset: vi.fn(),
  abortAllTasks: vi.fn(),
};

const innerPrimarySession = {
  getTabId: vi.fn(() => 999),
  getConversationHistory: vi.fn(() => ({ items: [] })),
  reset: vi.fn(),
  abortAllTasks: vi.fn(),
};

const mockSessionA = {
  agent: {
    getSession: vi.fn(() => innerSessionA),
    refreshModelClient: vi.fn().mockResolvedValue(undefined),
  },
};

const mockSessionB = {
  agent: {
    getSession: vi.fn(() => innerSessionB),
    refreshModelClient: vi.fn().mockResolvedValue(undefined),
  },
};

const mockPrimaryAgent = {
  getSession: vi.fn(() => innerPrimarySession),
};

const mockRegistry = {
  getSession: vi.fn((id: string) => {
    if (id === 'session_A') return mockSessionA;
    if (id === 'session_B') return mockSessionB;
    return undefined;
  }),
  createSession: vi.fn().mockResolvedValue({
    sessionId: 'session_new',
    sessionLetter: 'c',
    agent: { refreshModelClient: vi.fn().mockResolvedValue(undefined) },
  }),
  removeSession: vi.fn().mockResolvedValue(undefined),
  canCreateSession: vi.fn(() => true),
  listSessions: vi.fn(() => [
    { sessionId: 'session_A', type: 'primary' },
    { sessionId: 'session_B', type: 'primary' },
  ]),
  getActiveCount: vi.fn(() => 2),
  getMaxConcurrent: vi.fn(() => 5),
};

const mockBootstrap = {
  getRegistry: vi.fn(() => mockRegistry),
  getAgent: vi.fn(() => mockPrimaryAgent),
  getReadyState: vi.fn().mockResolvedValue({
    ready: true,
    message: 'ok',
    provider: 'openai',
    model: 'gpt-4',
    authMode: 'api_key',
  }),
};

vi.mock('@/desktop/agent/DesktopAgentBootstrap', () => ({
  getDesktopAgentBootstrap: vi.fn(() => mockBootstrap),
}));

import { TauriMessageService } from '@/core/messaging/TauriMessageService';

describe('TauriMessageService', () => {
  let service: TauriMessageService;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-setup mocks after clearAllMocks (mockReset: true clears implementations)
    mockEmit.mockResolvedValue(undefined);
    mockListen.mockResolvedValue(() => {});

    // Restore inner session mocks
    innerSessionA.getTabId.mockReturnValue(101);
    innerSessionA.getConversationHistory.mockReturnValue({ items: [{ role: 'user', content: 'hello A' }] });
    innerSessionB.getTabId.mockReturnValue(202);
    innerSessionB.getConversationHistory.mockReturnValue({ items: [{ role: 'user', content: 'hello B' }] });
    innerPrimarySession.getTabId.mockReturnValue(999);
    innerPrimarySession.getConversationHistory.mockReturnValue({ items: [] });

    mockSessionA.agent.getSession.mockReturnValue(innerSessionA);
    mockSessionB.agent.getSession.mockReturnValue(innerSessionB);
    mockPrimaryAgent.getSession.mockReturnValue(innerPrimarySession);

    mockRegistry.getSession.mockImplementation((id: string) => {
      if (id === 'session_A') return mockSessionA;
      if (id === 'session_B') return mockSessionB;
      return undefined;
    });
    mockRegistry.canCreateSession.mockReturnValue(true);
    mockRegistry.createSession.mockResolvedValue({
      sessionId: 'session_new',
      sessionLetter: 'c',
      agent: { refreshModelClient: vi.fn().mockResolvedValue(undefined) },
    });
    mockRegistry.removeSession.mockResolvedValue(undefined);
    mockRegistry.listSessions.mockReturnValue([
      { sessionId: 'session_A', type: 'primary' },
      { sessionId: 'session_B', type: 'primary' },
    ]);
    mockRegistry.getActiveCount.mockReturnValue(2);
    mockRegistry.getMaxConcurrent.mockReturnValue(5);

    mockBootstrap.getRegistry.mockReturnValue(mockRegistry);
    mockBootstrap.getAgent.mockReturnValue(mockPrimaryAgent);
    mockBootstrap.getReadyState.mockResolvedValue({
      ready: true,
      message: 'ok',
      provider: 'openai',
      model: 'gpt-4',
      authMode: 'api_key',
    });

    service = new TauriMessageService();
    await service.initialize();
  });

  // =========================================================================
  // handleGetState — routes by sessionId
  // =========================================================================

  describe('handleGetState', () => {
    it('routes to the correct session by sessionId', async () => {
      const result: any = await service.send(MessageType.GET_STATE, {
        sessionId: 'session_A',
      });

      expect(result.tabId).toBe(101);
      expect(result.history).toEqual([{ role: 'user', content: 'hello A' }]);
    });

    it('routes to session B when given session_B', async () => {
      const result: any = await service.send(MessageType.GET_STATE, {
        sessionId: 'session_B',
      });

      expect(result.tabId).toBe(202);
    });

    it('falls back to primary agent without sessionId', async () => {
      const result: any = await service.send(MessageType.GET_STATE, {});

      expect(result.tabId).toBe(999);
    });

    it('handles missing session gracefully', async () => {
      const result: any = await service.send(MessageType.GET_STATE, {
        sessionId: 'nonexistent',
      });

      // Falls back to primary agent
      expect(result.tabId).toBe(999);
    });
  });

  // =========================================================================
  // handleInterrupt — routes by sessionId
  // =========================================================================

  describe('handleInterrupt', () => {
    it('interrupts the correct session', async () => {
      await service.send(MessageType.INTERRUPT, { sessionId: 'session_A' });

      expect(innerSessionA.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
    });

    it('falls back to primary agent without sessionId', async () => {
      await service.send(MessageType.INTERRUPT, {});

      expect(innerPrimarySession.abortAllTasks).toHaveBeenCalledWith('UserInterrupt');
    });
  });

  // =========================================================================
  // handleSessionReset — routes by sessionId
  // =========================================================================

  describe('handleSessionReset', () => {
    it('resets the correct session', async () => {
      const result: any = await service.send(MessageType.SESSION_RESET, {
        sessionId: 'session_A',
      });

      expect(innerSessionA.reset).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('falls back to primary agent without sessionId', async () => {
      const result: any = await service.send(MessageType.SESSION_RESET, {});

      expect(innerPrimarySession.reset).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });
  });

  // =========================================================================
  // handleCreateSession
  // =========================================================================

  describe('handleCreateSession', () => {
    it('creates a session and returns sessionId', async () => {
      const result: any = await service.send(MessageType.SIDEPANEL_CREATE_SESSION);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('session_new');
      expect(result.sessionLetter).toBe('c');
    });

    it('returns error when max sessions reached', async () => {
      mockRegistry.canCreateSession.mockReturnValue(false);

      const result: any = await service.send(MessageType.SIDEPANEL_CREATE_SESSION);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Maximum concurrent sessions reached');
    });
  });

  // =========================================================================
  // handleCloseSession
  // =========================================================================

  describe('handleCloseSession', () => {
    it('removes the correct session', async () => {
      const result: any = await service.send(MessageType.SIDEPANEL_CLOSE_SESSION, {
        sessionId: 'session_A',
      });

      expect(mockRegistry.removeSession).toHaveBeenCalledWith('session_A');
      expect(result.success).toBe(true);
    });

    it('returns error when sessionId is missing', async () => {
      const result: any = await service.send(MessageType.SIDEPANEL_CLOSE_SESSION, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain('sessionId is required');
    });
  });

  // =========================================================================
  // handleListSessions / handleGetActiveCount
  // =========================================================================

  describe('handleListSessions', () => {
    it('returns session list with capacity info', async () => {
      const result: any = await service.send(MessageType.SIDEPANEL_LIST_SESSIONS);

      expect(result.sessions).toHaveLength(2);
      expect(result.maxConcurrent).toBe(5);
      expect(result.activeCount).toBe(2);
      expect(result.canCreateSession).toBe(true);
    });
  });

  describe('handleGetActiveCount', () => {
    it('returns active count and capacity', async () => {
      const result: any = await service.send(MessageType.SESSION_GET_ACTIVE_COUNT);

      expect(result.activeCount).toBe(2);
      expect(result.maxConcurrent).toBe(5);
      expect(result.canCreateSession).toBe(true);
    });
  });

  // =========================================================================
  // handleSubmission — emits pi:submit with context
  // =========================================================================

  describe('handleSubmission', () => {
    it('emits pi:submit with sessionId in context', async () => {
      const payload = {
        op: { type: 'chat', text: 'hello' },
        context: { sessionId: 'session_A' },
      };

      await service.send(MessageType.SUBMISSION, payload);

      expect(mockEmit).toHaveBeenCalledWith('pi:submit', {
        op: payload.op,
        context: payload.context,
      });
    });

    it('emits pi:submit without sessionId when not provided', async () => {
      const payload = { op: { type: 'chat', text: 'hi' }, context: {} };

      await service.send(MessageType.SUBMISSION, payload);

      expect(mockEmit).toHaveBeenCalledWith('pi:submit', {
        op: payload.op,
        context: payload.context,
      });
    });
  });
});
